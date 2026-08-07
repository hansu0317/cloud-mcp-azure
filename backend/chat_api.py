"""채팅 엔드포인트 (POST /api/chat) — Claude API(Messages) + Dataverse Web API(OData).

claudeapi/chat-api.ts 포팅.

구조: QualiSoft Azure 앱(서비스 주체) → client_credentials 토큰(backend/dataverse.py) →
      Dataverse Web API로 직접 조회(GET, 읽기 전용)
      → Claude가 schema.json(엔티티 집합명 포함) 기반으로 OData 쿼리를 작성/해석해 답변

스키마(schema.json)는 Claude 없이 순수 REST로 갱신된다 — backend/dataverse.py +
backend/main.py의 /api/schemas/refresh 참고. 이 파일은 "질문에 답하는" 역할만 한다.

컨텍스트 절약: 매 세션 첫 메시지엔 테이블 "카탈로그"(이름/라벨/엔티티집합명 한 줄)만
넣는다. 실제 컬럼 목록이 필요한 테이블은 dataverse_describe_table 도구로 Claude가
직접 골라서 조회한다(schema.json 캐시 조회 — 네트워크 호출 없음, 즉시 응답).

필요 환경변수 (루트 .env):
  ANTHROPIC_API_KEY        — Anthropic API 키 (필수)
  DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET / DATAVERSE_URL
  ANTHROPIC_MODEL          — 기본값 claude-haiku-4-5 (데모 속도 우선)
  MAX_CONCURRENT_API       — 기본값 10 (동시 Claude API 스트림 수)
  CHAT_TIMEOUT_MS          — 기본값 120000
  MAX_SESSIONS             — 기본값 200 (세션 정리 상한)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from anthropic import AsyncAnthropic
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from .dataverse import build_compact_catalog, dataverse_env_missing, dataverse_get, SchemaEntry
from .logger import log
from .projects import get_project_history, save_project_history
from .semaphore import Semaphore
from .sse import HttpStatus, SseChannel, SSE_HEADERS

# ─── 설정 ─────────────────────────────────────────────────────────────────────
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
MAX_TOKENS = int(os.environ.get("ANTHROPIC_MAX_TOKENS", "4096"))
MAX_CONCURRENT_API = int(os.environ.get("MAX_CONCURRENT_API", "10"))
CHAT_TIMEOUT_MS = int(os.environ.get("CHAT_TIMEOUT_MS", "120000"))
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "200"))
MAX_TOOL_LOOPS = 6
SESSION_TTL_S = 24 * 60 * 60

CWD = Path.cwd()
SCHEMA_FILE = CWD / "data" / "schema.json"

Msg = dict[str, Any]

api_semaphore = Semaphore(MAX_CONCURRENT_API)


def api_status() -> dict[str, int]:
    """헬스체크(/api/health)용 동시성 상태."""
    return {"active": api_semaphore.size, "queued": api_semaphore.pending, "max": MAX_CONCURRENT_API}


def _read_schema_file() -> dict[str, SchemaEntry]:
    try:
        raw = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {table: SchemaEntry.from_dict(info) for table, info in raw.items()}


# ─── OData 쿼리 가드 — 모델이 생성한 경로를 무검증 실행하지 않는다 ────────────
# 1) 엔티티집합명 화이트리스트: schema.json에 등록된 테이블만 조회 허용
#    (환각으로 만든 경로·등록 외 테이블 접근을 원천 차단, 위반 시 tool_result
#     오류로 돌려보내 모델이 카탈로그 기준으로 자가 수정하게 한다)
#    프로젝트에 테이블 스코프(tables)가 지정돼 있으면 그 안에서만 추가로 제한한다.
# 2) $top 상한: 목록 조회에 $top이 없으면 100을 강제해 무제한 전체 조회로 인한
#    Dataverse 부하·응답 비대를 방지 (집계 $apply/$count·단건 조회는 제외)
_ENTITY_SET_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)")
_TOP_RE = re.compile(r"(^|&)\$top=")
_APPLY_RE = re.compile(r"(^|&)\$apply=")
_COUNT_RE = re.compile(r"(^|&)\$count=")


def _allowed_entity_sets(tables: list[str] | None) -> set[str]:
    scoped = set(tables) if tables else None
    sets: set[str] = set()
    for table, info in _read_schema_file().items():
        if scoped is not None and table not in scoped:
            continue
        if info.entity_set_name:
            sets.add(info.entity_set_name)
    return sets


def _guard_odata_path(rel_path: str, tables: list[str] | None) -> str:
    clean = rel_path.lstrip("/")
    m = _ENTITY_SET_RE.match(clean)
    entity_set = m.group(1) if m else ""
    allowed = _allowed_entity_sets(tables)
    if allowed and entity_set not in allowed:
        raise ValueError(f'허용되지 않은 엔티티 집합명 "{entity_set}"입니다. 이 프로젝트의 테이블 스코프에 포함된 엔티티집합명만 사용하세요.')

    q_idx = clean.find("?")
    resource = clean if q_idx == -1 else clean[:q_idx]
    query = "" if q_idx == -1 else clean[q_idx + 1:]
    is_collection = "(" not in resource and "$count" not in resource
    if is_collection and not _TOP_RE.search(query) and not _APPLY_RE.search(query) and not _COUNT_RE.search(query):
        with_top = f"{query}&$top=100" if query else "$top=100"
        return f"{resource}?{with_top}"
    return clean


# 데이터 조회용 GET — 가드 통과 후 공용 dataverse_get(원문 텍스트) + 컨텍스트 절약용 truncate
async def _dataverse_query(rel_path: str, tables: list[str] | None) -> str:
    text = await dataverse_get(_guard_odata_path(rel_path, tables))
    try:
        data = json.loads(text)
        if isinstance(data.get("value"), list):
            return json.dumps(data["value"][:100], ensure_ascii=False)
    except (json.JSONDecodeError, AttributeError):
        pass
    return text[:8000]


# ─── 시스템 프롬프트(카탈로그 + 규칙) — 요청마다 새로 빌드 ────────────────────
# schema.json은 스키마 갱신 버튼으로 언제든 바뀔 수 있다. 서버 기동 시 1회만 빌드해
# 캐싱하면 갱신 후에도 재시작 전까지 낡은 카탈로그를 계속 보내는 문제가 생기므로,
# 매 요청 로컬 파일을 다시 읽어 빌드한다(카탈로그가 작아 비용은 무시할 수준).
def _build_system_prompt(tables: list[str] | None) -> str:
    schema = _read_schema_file()
    scoped = bool(tables)
    filtered = {t: info for t, info in schema.items() if t in tables} if scoped else schema
    catalog = build_compact_catalog(filtered)
    lines = [
        "당신은 Quali CRM 데이터 조회 전용 어시스턴트입니다.",
        "항상 한국어로 답하고, 데이터는 마크다운 표로, 숫자/금액은 천 단위 콤마로 표시하세요.",
        '데이터가 없으면 "해당 조건에 맞는 데이터가 없습니다"라고 명확히 알리세요.',
        "조회 전용입니다. 데이터 변경(생성·수정·삭제) 요청은 거절하세요.",
        "",
        "작업 순서:",
        "1) 아래 [테이블 카탈로그]에서 질문에 필요한 테이블을 고르세요.",
        "2) 그 테이블의 정확한 컬럼명을 모르면 dataverse_describe_table로 먼저 조회하세요.",
        "3) dataverse_query로 실제 데이터를 조회하세요. path는 \"엔티티 집합명\"으로 시작합니다",
        "   (카탈로그 또는 describe 결과의 엔티티집합명을 그대로 사용 — 추측 금지).",
        '   예) "new_q3s?$select=new_name,new_d_maechul&$top=5&$orderby=new_d_maechul desc"',
        "상태 필터가 필요하면 $filter=statecode eq 0 (활성) 을 사용하세요.",
        "Choice(선택) 컬럼은 라벨로 필터링할 수 없습니다. describe 결과의 옵션 목록에서",
        "라벨에 대응하는 숫자 코드를 찾아 필터링하세요.",
    ]
    if scoped:
        lines += ["", f"이 프로젝트는 아래 {len(tables)}개 테이블로 조회 범위가 제한되어 있습니다. 카탈로그 밖의 테이블은 조회할 수 없으니, 범위 밖 정보를 물으면 스코프에 없다고 답하세요."]
    lines += ["", "[테이블 카탈로그]", catalog or "(등록된 테이블이 없습니다)"]
    return "\n".join(lines)


# ─── Claude 커스텀 도구 정의 (읽기 전용) ─────────────────────────────────────
DATAVERSE_QUERY_TOOL = {
    "name": "dataverse_query",
    "description": "Dataverse Web API(OData)를 GET으로 조회한다(읽기 전용). "
    'path는 엔티티 집합명으로 시작하는 상대 경로. 예: "new_q3s?$select=new_name&$top=5&$filter=statecode eq 0"',
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "OData 상대 경로 (엔티티 집합명 + $select/$filter/$top/$orderby 등)"},
        },
        "required": ["path"],
    },
}

DESCRIBE_TABLE_TOOL = {
    "name": "dataverse_describe_table",
    "description": "테이블의 전체 컬럼명·타입·한국어 설명·엔티티집합명을 조회한다(캐시 조회, 즉시 응답, 네트워크 호출 없음). "
    "dataverse_query를 쓰기 전에 정확한 컬럼명이 필요하면 먼저 이 도구를 호출하세요.",
    "input_schema": {
        "type": "object",
        "properties": {
            "table": {"type": "string", "description": "테이블 논리명 (카탈로그에 있는 이름 그대로, 예: new_q3)"},
        },
        "required": ["table"],
    },
}


# 캐시된 schema.json에서 특정 테이블의 전체 스키마를 즉시 반환 (네트워크 호출 없음)
def _describe_table_from_cache(table: str, tables: list[str] | None) -> str:
    if tables and table not in tables:
        return f'테이블 "{table}"은(는) 이 프로젝트의 스코프 밖입니다. 카탈로그에 있는 테이블만 조회하세요.'
    entry = _read_schema_file().get(table)
    if not entry or not entry.schema:
        return f'테이블 "{table}"의 스키마 정보가 없습니다. 카탈로그의 정확한 테이블명을 사용하세요.'
    set_name = f"\n엔티티집합명: {entry.entity_set_name}" if entry.entity_set_name else ""
    return f"## {table}{f' ({entry.label})' if entry.label else ''}{set_name}\n{entry.schema}"


# ─── 세션별 대화 히스토리 (인메모리, TTL/상한 정리) ──────────────────────────
class _HistorySession:
    __slots__ = ("messages", "last_used")

    def __init__(self, messages: list[Msg]) -> None:
        self.messages = messages
        self.last_used = time.monotonic()


_history_map: dict[str, _HistorySession] = {}
MAX_TURNS = 20


# 히스토리 상한 트리밍 — 단순 slice(-N)은 assistant(tool_use) ↔ user(tool_result) 쌍의
# 중간을 자를 수 있고, 그러면 이후 모든 요청이 API 400으로 실패한다(세션 영구 파손).
# 반드시 "일반 텍스트 user 메시지"(새 질문 시작점) 경계에서만 자른다.
def _trim_history(msgs: list[Msg]) -> list[Msg]:
    if len(msgs) <= MAX_TURNS:
        return msgs
    for i in range(len(msgs) - MAX_TURNS, len(msgs)):
        m = msgs[i]
        if m["role"] == "user" and isinstance(m["content"], str):
            return msgs[i:]
    # 상한 범위 안에 질문 경계가 없으면(한 턴이 비정상적으로 긴 경우) 마지막 질문부터 유지
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if m["role"] == "user" and isinstance(m["content"], str):
            return msgs[i:]
    return msgs


# describe 결과 히스토리 컴팩션 — 테이블 하나당 수 KB인 스키마 조회 결과가 대화
# 기록에 그대로 쌓이면 매 요청 입력 토큰이 턴마다 급증한다(실측: 2턴 만에 2배+).
# 답변 생성에 쓰인 직후에는 더 이상 원문이 필요 없고, schema.json 로컬 캐시 조회라
# 다시 필요하면 모델이 재호출해도 비용이 0이므로, 저장 시점에 placeholder로 치환한다.
DESCRIBE_PLACEHOLDER = "(스키마 조회 결과 생략 — 필요하면 dataverse_describe_table을 다시 호출하세요)"


def _compact_describe_results(msgs: list[Msg], describe_ids: set[str]) -> int:
    if not describe_ids:
        return 0
    compacted = 0
    for m in msgs:
        if m["role"] != "user" or not isinstance(m["content"], list):
            continue
        for block in m["content"]:
            if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("tool_use_id") in describe_ids:
                block["content"] = DESCRIBE_PLACEHOLDER
                compacted += 1
    return compacted


async def cleanup_loop() -> None:
    """세션 TTL/상한 정리 백그라운드 태스크 — main.py의 lifespan에서 기동한다."""
    while True:
        await asyncio.sleep(60 * 60)
        cutoff = time.monotonic() - SESSION_TTL_S
        removed = 0
        for sid in [sid for sid, s in _history_map.items() if s.last_used < cutoff]:
            del _history_map[sid]
            removed += 1
        if len(_history_map) > MAX_SESSIONS:
            oldest_first = sorted(_history_map.items(), key=lambda kv: kv[1].last_used)
            excess = len(_history_map) - MAX_SESSIONS
            for sid, _ in oldest_first[:excess]:
                del _history_map[sid]
                removed += 1
        if removed:
            log.info("API-세션", f"세션 정리: {removed}개 삭제 (현재: {len(_history_map)})")


# ─── 라우트 등록 ──────────────────────────────────────────────────────────────
def register_chat_api(app) -> None:
    client = AsyncAnthropic()  # ANTHROPIC_API_KEY 환경변수 사용

    @app.post("/api/chat")
    async def chat(request: Request):
        body = await request.json()
        message = body.get("message")
        session_id = body.get("sessionId")
        tables = body.get("tables")
        if not message or not session_id:
            return JSONResponse({"error": "message와 sessionId가 필요합니다."}, status_code=HttpStatus.BAD_REQUEST)

        if api_semaphore.is_overloaded():
            return JSONResponse({"error": "현재 요청이 많습니다. 잠시 후 다시 시도하세요."}, status_code=HttpStatus.TOO_MANY_REQUESTS)

        channel = SseChannel()

        missing = dataverse_env_missing()
        if missing:
            async def missing_stream():
                channel.send({"type": "error", "message": f"{missing} 환경변수가 설정되지 않았습니다. (.env 확인)"})
                channel.close()
                async for chunk in channel.stream(request):
                    yield chunk
            return StreamingResponse(missing_stream(), headers=SSE_HEADERS)

        async def run_chat():
            await api_semaphore.acquire()
            sem_released = False

            def release_sem():
                nonlocal sem_released
                if not sem_released:
                    sem_released = True
                    api_semaphore.release()

            # 인메모리 캐시에 없으면(서버 재시작·새 창 등) 프로젝트 파일에 저장된 히스토리로 복구한다.
            session = _history_map.get(session_id) or _HistorySession(list(get_project_history(session_id)))
            # 에러 시 이 지점으로 롤백 — 반쪽 히스토리(tool_result 없는 tool_use 등)가 저장되면
            # 그 세션의 이후 요청이 전부 400으로 실패하므로, 실패한 요청의 흔적은 통째로 버린다.
            rollback_len = len(session.messages)
            session.messages.append({"role": "user", "content": message})
            session.last_used = time.monotonic()
            history = session.messages

            start = time.monotonic()
            log.info("API-질문", message[:200])

            answer_text = ""
            query_count = 0
            in_tok = out_tok = cache_read_tok = cache_write_tok = 0
            describe_ids: set[str] = set()  # 이번 요청의 describe 호출 — 저장 시 결과 컴팩션 대상

            try:
                # ── 도구 사용 루프 (커스텀 도구는 서버가 직접 실행) ──
                for _loop in range(MAX_TOOL_LOOPS):
                    tool_acc: dict[int, dict[str, str]] = {}

                    async with client.messages.stream(
                        model=MODEL,
                        max_tokens=MAX_TOKENS,
                        system=[{"type": "text", "text": _build_system_prompt(tables), "cache_control": {"type": "ephemeral"}}],
                        messages=history,
                        tools=[DATAVERSE_QUERY_TOOL, DESCRIBE_TABLE_TOOL],
                        timeout=CHAT_TIMEOUT_MS / 1000,
                    ) as stream:
                        async for ev in stream:
                            if ev.type == "content_block_start" and ev.content_block.type == "tool_use":
                                tool_acc[ev.index] = {"name": ev.content_block.name, "json": ""}
                                channel.send({"type": "tool", "name": ev.content_block.name})
                            elif ev.type == "content_block_delta":
                                if ev.delta.type == "text_delta":
                                    channel.send({"type": "text", "text": ev.delta.text})
                                    answer_text += ev.delta.text
                                elif ev.delta.type == "input_json_delta":
                                    acc = tool_acc.get(ev.index)
                                    if acc is not None:
                                        acc["json"] += ev.delta.partial_json
                            elif ev.type == "content_block_stop":
                                acc = tool_acc.pop(ev.index, None)
                                if acc is not None:
                                    try:
                                        tool_input = json.loads(acc["json"]) if acc["json"] else {}
                                    except json.JSONDecodeError:
                                        tool_input = {}
                                    channel.send({"type": "query", "tool": acc["name"], "input": tool_input})
                                    preview = str(tool_input.get("path") or tool_input.get("table") or json.dumps(tool_input, ensure_ascii=False))
                                    log.info("API-쿼리", f"[{acc['name']}] {preview[:100]}")
                                    query_count += 1

                        final = await stream.get_final_message()

                    # exclude_none: 최신 SDK가 응답 블록에 실어 보내는 부가/beta 필드(예: 구조화
                    # 출력 관련 parsed_output 등, 응답에만 유효하고 None인 값)가 그대로 남아있으면
                    # 다음 턴에 이 히스토리를 다시 요청 본문으로 보낼 때 "Extra inputs are not
                    # permitted" 400 오류로 세션이 깨진다 — None 값 필드는 전부 제거하고 보낸다.
                    assistant_content = [block.model_dump(exclude_none=True) for block in final.content]
                    history.append({"role": "assistant", "content": assistant_content})

                    in_tok += final.usage.input_tokens
                    out_tok += final.usage.output_tokens
                    cache_read_tok += final.usage.cache_read_input_tokens or 0
                    cache_write_tok += final.usage.cache_creation_input_tokens or 0

                    tool_uses = [b for b in final.content if b.type == "tool_use"]
                    if final.stop_reason != "tool_use" or not tool_uses:
                        break

                    # 도구 실행 → tool_result 반환 (모두 읽기 전용)
                    results: list[dict[str, Any]] = []
                    for tu in tool_uses:
                        try:
                            if tu.name == "dataverse_describe_table":
                                table = (tu.input or {}).get("table", "")
                                out = _describe_table_from_cache(table, tables)  # 캐시 조회 — 네트워크 호출 없음
                                describe_ids.add(tu.id)
                                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
                            else:
                                p = (tu.input or {}).get("path", "")
                                out = await _dataverse_query(p, tables)
                                results.append({"type": "tool_result", "tool_use_id": tu.id, "content": out})
                        except Exception as e:
                            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": f"오류: {e}", "is_error": True})
                    history.append({"role": "user", "content": results})

                compacted = _compact_describe_results(history, describe_ids)  # 답변 완료 후 스키마 원문은 히스토리에서 제거
                if compacted > 0:
                    log.info("API-컴팩션", f"스키마 조회 결과 {compacted}건 히스토리에서 생략 처리")
                session.messages = _trim_history(history)
                session.last_used = time.monotonic()
                _history_map[session_id] = session
                save_project_history(session_id, session.messages)  # 재시작해도 이어지도록 디스크에도 저장

                elapsed = time.monotonic() - start
                log.info("API-답변", f"{answer_text[:300]} ({elapsed:.1f}초, 쿼리 {query_count}회, "
                          f"토큰 in:{in_tok} out:{out_tok} cache_read:{cache_read_tok} cache_write:{cache_write_tok})")
                channel.send({"type": "done"})
            except asyncio.CancelledError:
                session.messages[rollback_len:] = []
                raise
            except Exception as err:
                # 실패한 요청의 반쪽 히스토리를 제거해 세션을 이전 정상 상태로 복원
                session.messages[rollback_len:] = []
                msg = str(err)
                log.error("API-오류", msg[:300], {"sessionId": session_id})
                channel.send({"type": "error", "message": f"Claude API 오류: {msg}"})
            finally:
                release_sem()
                channel.close()

        task = asyncio.create_task(run_chat())

        async def event_stream():
            try:
                async for chunk in channel.stream(request):
                    yield chunk
            finally:
                if not task.done():
                    task.cancel()

        return StreamingResponse(event_stream(), headers=SSE_HEADERS)

    log.info("SERVER", f"채팅 엔드포인트 등록됨 — POST /api/chat "
              f"(model: {MODEL}, 동시 {MAX_CONCURRENT_API}, 타임아웃 {CHAT_TIMEOUT_MS / 1000}s)")
