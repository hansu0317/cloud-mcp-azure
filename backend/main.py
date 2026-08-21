"""Quali CRM AI Notebook의 활성 공통 백엔드(Python/FastAPI).

실행:
  개발:   uvicorn backend.main:app --reload --port 3000
  운영:   python -m backend.main   (uvicorn.run 호출, graceful shutdown 포함)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # 아래 backend.* 모듈들이 import 시점에 환경변수를 읽으므로 반드시 가장 먼저 실행

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

if sys.version_info < (3, 11):
    raise RuntimeError("crm-ai-chat FastAPI 백엔드는 Python 3.11 이상이 필요합니다.")

from .chat_api import api_status, cleanup_loop, provider_health, provider_status, register_chat_api
from . import dataverse, projects
from .dataverse import dataverse_env_missing, fetch_entity_schema
from .logger import get_active_log_file_path, log, read_json_log_tail
from .provider_factory import close_llm_provider
from .sse import HttpStatus

# ─── 환경변수 ─────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", "3000"))
if not 1 <= PORT <= 65535:
    raise RuntimeError(f"PORT 범위는 1..65535여야 합니다: {PORT}")
SHUTDOWN_TIMEOUT_MS = max(1000, int(os.environ.get("SHUTDOWN_TIMEOUT_MS", "30000")))
RL_WINDOW_MS = max(1000, int(os.environ.get("RATE_LIMIT_WINDOW_MS", "60000")))
RL_MAX = max(1, int(os.environ.get("RATE_LIMIT_MAX", "20")))
RL_MAX_BUCKETS = max(1, int(os.environ.get("RATE_LIMIT_MAX_BUCKETS", "10000")))
MAX_REQUEST_BODY_BYTES = max(1, int(os.environ.get("MAX_REQUEST_BODY_BYTES", str(1024 * 1024))))
API_KEY = os.environ.get("API_KEY", "")
ENABLE_API_DOCS = os.environ.get("ENABLE_API_DOCS", "").strip().lower() in {"1", "true", "yes", "on"}
FORWARDED_ALLOW_IPS = os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1,::1").strip() or "127.0.0.1,::1"

CWD = Path.cwd()
SCHEMA_FILE = CWD / "data" / "schema.json"
DIST_DIR = CWD / "dist"


# ─── 유틸 ────────────────────────────────────────────────────────────────────
def _read_json_file(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


start_time = time.monotonic()
schema_refreshing = False

schema_cache: dict[str, str] = {}                       # 스키마 텍스트
schema_meta: dict[str, dict[str, str]] = {}             # 등록 테이블 전체
schema_lookups: dict[str, dict[str, list[str]]] = {}    # 테이블별 {컬럼: [대상 테이블...]} — 조인 후보 계산용
pending_describe: dict[str, asyncio.Task] = {}
# schema.json은 "전체를 읽고 한 항목만 고쳐서 전체를 다시 쓰는" 구조라, 여러 테이블을
# 동시에 describe(스키마 갱신은 6개씩 병렬)하면 나중에 끝난 쓰기가 먼저 끝난 쓰기를
# 통째로 덮어써 유실시킬 수 있다. 느린 Dataverse 네트워크 조회는 동시에 하되, 파일을
# 읽고-고치고-쓰는 구간만 이 락으로 직렬화해 그 경합을 막는다.
_schema_write_lock = asyncio.Lock()


def _is_string_array(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def _is_instructions(value) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("joins"), list)
        and isinstance(value.get("terms"), list)
        and isinstance(value.get("examples"), list)
    )


def _validate_project_tables(tables: list[str]) -> str | None:
    unknown = next((table for table in tables if table not in schema_meta), None)
    return f'등록되지 않은 테이블 "{unknown}"입니다.' if unknown else None


# schema.json → 인메모리 카탈로그 동기화 (기동 시 + 갱신 완료 후 공통 호출)
def reload_from_schema_file() -> None:
    data = _read_json_file(SCHEMA_FILE, {})
    schema_cache.clear()
    schema_meta.clear()
    schema_lookups.clear()
    if not isinstance(data, dict):
        log.error("SCHEMA", "schema.json 최상위 값은 JSON 객체여야 합니다.")
        return
    for table, info in data.items():
        if not isinstance(table, str) or not table or not isinstance(info, dict):
            log.error("SCHEMA", "유효하지 않은 schema.json 항목을 건너뜁니다.", {"table": str(table)[:100]})
            continue
        label = info.get("label")
        domain = info.get("domain")
        schema = info.get("schema")
        lookups = info.get("lookups")
        schema_meta[table] = {
            "label": label if isinstance(label, str) and label else table,
            "domain": domain if isinstance(domain, str) and domain else "기타",
        }
        if isinstance(schema, str) and schema:
            schema_cache[table] = schema
        if isinstance(lookups, dict):
            schema_lookups[table] = lookups
    log.info("SCHEMA", f"카탈로그 동기화: {len(schema_meta)}개 테이블 (스키마 로드: {len(schema_cache)}개)")


reload_from_schema_file()


# ─── FastAPI 앱 ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    cleanup_task = asyncio.create_task(cleanup_loop())
    llm = provider_status()
    log.info(
        "SERVER",
        f"Quali CRM AI Notebook FastAPI 기동 — http://localhost:{PORT}",
        {"provider": llm["provider"], "model": llm["model"], "logFile": str(get_active_log_file_path())},
    )
    print(f"\n{'━' * 40}")
    print("  Quali CRM AI Notebook FastAPI 실행 중")
    print(f"  http://localhost:{PORT}")
    print(f"  LLM: {llm['provider']} / {llm['model']}")
    print(f"  Log: {get_active_log_file_path()}")
    print(f"  Rate-limit: {RL_MAX}req/{RL_WINDOW_MS / 1000}s")
    print(f"{'━' * 40}\n")
    try:
        yield
    finally:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.error("SERVER", "백그라운드 정리 작업 종료 실패", {"error": str(exc)})

        closers = [("LLM", close_llm_provider)]
        close_dataverse = getattr(dataverse, "close_dataverse_client", None)
        if close_dataverse is not None:
            closers.append(("Dataverse", close_dataverse))
        for name, closer in closers:
            try:
                await closer()
            except Exception as exc:
                # 하나의 close 실패가 다음 자원 정리를 막지 않게 한다.
                log.error("SERVER", f"{name} 연결 종료 실패", {"error": str(exc)})
        log.info("SERVER", "모든 연결 종료 — 프로세스 정상 종료")


app = FastAPI(
    lifespan=lifespan,
    docs_url="/docs" if ENABLE_API_DOCS else None,
    redoc_url="/redoc" if ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request: Request, exc: StarletteHTTPException):
    if exc.status_code == HttpStatus.BAD_REQUEST:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)


class JsonBodyGuardMiddleware:
    """API JSON body를 한 번만 제한 크기로 읽고 downstream에 그대로 재생한다."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    @staticmethod
    async def _error(scope: Scope, receive: Receive, send: Send, status: int, message: str) -> None:
        response = JSONResponse({"error": message}, status_code=status)
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") not in {"POST", "PATCH", "PUT"}
            or not str(scope.get("path", "")).startswith("/api")
        ):
            await self.app(scope, receive, send)
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        content_length = headers.get("content-length")
        if content_length:
            try:
                declared_size = int(content_length)
            except ValueError:
                await self._error(scope, receive, send, 400, "Content-Length 헤더가 올바르지 않습니다.")
                return
            if declared_size < 0:
                await self._error(scope, receive, send, 400, "Content-Length 헤더가 올바르지 않습니다.")
                return
            if declared_size > self.max_bytes:
                await self._error(scope, receive, send, 413, "요청 본문이 허용 크기를 초과했습니다.")
                return

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > self.max_bytes:
                await self._error(scope, receive, send, 413, "요청 본문이 허용 크기를 초과했습니다.")
                return
            if not message.get("more_body", False):
                break

        path = str(scope.get("path", ""))
        requires_json_body = (
            path in {"/api/projects", "/api/chat"}
            or (scope.get("method") == "PATCH" and path.startswith("/api/projects/"))
        )
        if not body and requires_json_body:
            await self._error(scope, receive, send, 400, "JSON 요청 본문이 필요합니다.")
            return

        if body:
            media_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if media_type != "application/json" and not media_type.endswith("+json"):
                await self._error(scope, receive, send, 415, "Content-Type은 application/json이어야 합니다.")
                return
            try:
                json.loads(body)
            except (UnicodeDecodeError, json.JSONDecodeError):
                await self._error(scope, receive, send, 400, "JSON 형식이 올바르지 않습니다.")
                return

        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)


# ─── 미들웨어: API 키 인증 (API_KEY 설정 시 /api/* 전체에 적용) ────────────────
class ApiKeyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if API_KEY and request.url.path.startswith("/api"):
            provided = request.headers.get("x-api-key") or request.query_params.get("api_key")
            if provided != API_KEY:
                log.error("AUTH", "인증 실패", {"ip": request.client.host if request.client else None, "path": request.url.path})
                return JSONResponse({"error": "인증이 필요합니다. X-API-Key 헤더를 확인하세요."}, status_code=HttpStatus.UNAUTHORIZED)
        return await call_next(request)


# ─── 미들웨어: rate-limit (/api/chat, /api/describe 전용, 고정 윈도) ──────────
_rate_buckets: dict[str, tuple[int, float, float]] = {}
_next_bucket_purge = 0.0


def _purge_rate_buckets(now: float) -> None:
    global _next_bucket_purge
    window_seconds = RL_WINDOW_MS / 1000
    if now < _next_bucket_purge and len(_rate_buckets) < RL_MAX_BUCKETS:
        return
    expired = [key for key, (_count, _start, last_seen) in _rate_buckets.items() if now - last_seen >= window_seconds]
    for key in expired:
        _rate_buckets.pop(key, None)
    overflow = len(_rate_buckets) - RL_MAX_BUCKETS
    if overflow > 0:
        oldest = sorted(_rate_buckets, key=lambda key: _rate_buckets[key][2])[:overflow]
        for key in oldest:
            _rate_buckets.pop(key, None)
    _next_bucket_purge = now + min(window_seconds, 60.0)


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/chat") or path.startswith("/api/describe"):
            ip = request.client.host if request.client else "unknown"
            now = time.monotonic()
            _purge_rate_buckets(now)
            if ip not in _rate_buckets and len(_rate_buckets) >= RL_MAX_BUCKETS:
                oldest = min(_rate_buckets, key=lambda key: _rate_buckets[key][2])
                _rate_buckets.pop(oldest, None)
            count, window_start, _last_seen = _rate_buckets.get(ip, (0, now, now))
            if now - window_start >= RL_WINDOW_MS / 1000:
                count, window_start = 0, now
            count += 1
            _rate_buckets[ip] = (count, window_start, now)
            if count > RL_MAX:
                return JSONResponse({"error": "요청이 너무 많습니다. 잠시 후 다시 시도하세요."}, status_code=HttpStatus.TOO_MANY_REQUESTS)
        return await call_next(request)


# add_middleware로 추가한 순서의 역순으로 바깥에서 안으로 감싸므로, 나중에 추가한
# ApiKeyMiddleware가 가장 바깥(먼저 실행)이 되어 인증 → rate-limit 순서가 된다.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(JsonBodyGuardMiddleware)
app.add_middleware(ApiKeyMiddleware)
if API_KEY:
    log.info("SERVER", "API 키 인증 활성화됨")


# ─── API: 스키마 갱신 ─────────────────────────────────────────────────────────
def _atomic_write_json(path: Path, value: object) -> None:
    """같은 디렉터리의 임시 파일을 fsync한 뒤 원자적으로 교체한다."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_name = temporary.name
            json.dump(value, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        temporary_name = None
    finally:
        if temporary_name is not None:
            try:
                Path(temporary_name).unlink()
            except FileNotFoundError:
                pass


async def describe_table(table: str) -> str:
    missing = dataverse_env_missing()
    if missing:
        raise RuntimeError(f"{missing} 환경변수가 설정되지 않았습니다. (.env 확인)")

    existing = _read_json_file(SCHEMA_FILE, {})
    if not isinstance(existing, dict):
        raise RuntimeError("schema.json 최상위 값은 JSON 객체여야 합니다.")
    entry = existing.get(table, {})
    if not isinstance(entry, dict):
        raise RuntimeError(f'schema.json의 "{table}" 항목은 JSON 객체여야 합니다.')

    # 이미 알고 있는 Lookup 컬럼의 대상 엔티티는 스키마 자체 속성이라 바뀌지 않는다 —
    # 캐시된 값을 넘겨서 매 갱신마다 같은 컬럼을 다시 조회하지 않게 한다.
    known_lookups = entry.get("lookups")
    known_lookups = known_lookups if isinstance(known_lookups, dict) else None
    result = await fetch_entity_schema(table, known_lookups=known_lookups)

    # 느린 네트워크 조회(fetch_entity_schema)는 이미 끝났으니, 파일 읽기-수정-쓰기만
    # 락 안에서 다시 한다 — 락을 기다리는 동안 다른 테이블이 먼저 썼을 수 있으므로
    # existing/entry를 여기서 새로 읽어야 그 갱신을 덮어쓰지 않는다.
    async with _schema_write_lock:
        existing = _read_json_file(SCHEMA_FILE, {})
        if not isinstance(existing, dict):
            raise RuntimeError("schema.json 최상위 값은 JSON 객체여야 합니다.")
        entry = existing.get(table, {})
        if not isinstance(entry, dict):
            raise RuntimeError(f'schema.json의 "{table}" 항목은 JSON 객체여야 합니다.')
        entry.update({"schema": result.markdown, "entitySetName": result.entity_set_name, "updatedAt": _now_iso()})
        if result.lookups:
            entry["lookups"] = result.lookups
        existing[table] = entry
        _atomic_write_json(SCHEMA_FILE, existing)
        # 파일 영속화가 성공한 뒤에만 메모리 캐시를 갱신한다.
        schema_cache[table] = result.markdown
        if table not in schema_meta:
            schema_meta[table] = {"label": entry.get("label") or table, "domain": entry.get("domain") or "기타"}
        if result.lookups:
            schema_lookups[table] = result.lookups
    return result.markdown


@app.post("/api/schemas/refresh")
async def schemas_refresh():
    global schema_refreshing
    if schema_refreshing:
        return {"updated": 0, "tables": [], "message": "갱신이 이미 진행 중입니다."}

    data = _read_json_file(SCHEMA_FILE, {})
    tables = list(data.keys())
    if not tables:
        return {"updated": 0, "tables": []}

    schema_refreshing = True
    log.info("SCHEMA", f"갱신 시작 — {len(tables)}개 테이블 배치 병렬 조회(Dataverse REST, LLM 미사용): {', '.join(tables)}")

    total_start = time.monotonic()
    REFRESH_BATCH_SIZE = 6   # 한꺼번에 전체 병렬 호출 시 커넥션 과부하로 간헐적 fetch 실패 발생 → 배치로 제한
    outcomes: list[bool] = []

    async def run_one(table: str) -> bool:
        t0 = time.monotonic()
        try:
            await describe_table(table)  # describe_table()이 테이블별로 schema.json에 직접 저장
            log.info("SCHEMA", f"{table} 완료 ({time.monotonic() - t0:.1f}초)")
            return True
        except Exception as e:
            log.error("SCHEMA", f"{table} 실패", {"error": str(e)})
            return False

    try:
        for i in range(0, len(tables), REFRESH_BATCH_SIZE):
            batch = tables[i:i + REFRESH_BATCH_SIZE]
            outcomes.extend(await asyncio.gather(*(run_one(t) for t in batch)))

        results = [t for t, ok in zip(tables, outcomes) if ok]
        log.info("SCHEMA", f"갱신 완료 — {len(results)}/{len(tables)}개 성공 (총 {time.monotonic() - total_start:.1f}초)")
        reload_from_schema_file()   # schema.json → 인메모리 카탈로그 전체 재동기화
        return {"updated": len(results), "tables": results}
    finally:
        schema_refreshing = False


# ─── API: 테이블 목록 ─────────────────────────────────────────────────────────
@app.get("/api/tables")
async def get_tables():
    return {"tables": [{"name": name, "label": meta["label"], "domain": meta["domain"]} for name, meta in schema_meta.items()]}


# ─── API: 프로젝트 (구 "세션") ────────────────────────────────────────────────
# 이름 + 테이블 스코프 + 노트북 셀을 data/projects/<id>.json에 영속화한다.
# Claude 대화 히스토리(history)는 여기서 절대 응답에 포함하지 않는다(chat_api.py 전용).
@app.get("/api/projects")
async def list_projects_route():
    return {"projects": projects.list_projects()}


@app.post("/api/projects")
async def create_project_route(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "요청 body는 JSON 객체여야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "name" in body and not isinstance(body["name"], str):
        return JSONResponse({"error": "name은 문자열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "tables" in body and not _is_string_array(body["tables"]):
        return JSONResponse({"error": "tables는 문자열 배열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    tables = body.get("tables", [])
    table_error = _validate_project_tables(tables)
    if table_error:
        return JSONResponse({"error": table_error}, status_code=HttpStatus.BAD_REQUEST)
    return projects.create_project(body.get("name", ""), tables)


@app.put("/api/projects/reorder")
async def reorder_projects_route(request: Request):
    # {project_id}보다 먼저 등록해야 한다 — 안 그러면 "reorder"가 project_id로 해석될 수 있다.
    body = await request.json()
    if not isinstance(body, dict) or not _is_string_array(body.get("order")):
        return JSONResponse({"error": "order는 프로젝트 id 문자열 배열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    return {"projects": projects.reorder_projects(body["order"])}


@app.get("/api/projects/{project_id}")
async def get_project_route(project_id: str):
    project = projects.get_project(project_id)
    if project is None:
        return JSONResponse({"error": "프로젝트를 찾을 수 없습니다."}, status_code=HttpStatus.NOT_FOUND)
    return project


# schema.json의 lookups(Dataverse가 실제로 갖고 있는 FK, reload_from_schema_file()이
# schema_lookups로 메모리에 올려둠)를 그대로 훑어 프로젝트 테이블 스코프 "안에서만"
# 연결되는 조인 후보를 계산한다 — 추측이 아니라 스키마가 이미 아는 사실이라 사람이
# 매번 다이어그램에서 그려 넣을 필요가 없다(예전 instructions_draft.py의
# _draft_joins()와 같은 발상, 지침 패널 재설계로 그 모듈이 통째로 삭제되면서
# 진입점이 없어졌던 것을 후보 목록 형태로 되살림). 저장은 안 하고 매번 새로 계산만
# 한다 — 프론트가 "추가" 누른 것만 실제 joins에 반영된다.
_JOIN_CANDIDATE_EXCLUDE_TARGETS = {"systemuser", "team", "businessunit"}


@app.get("/api/projects/{project_id}/join-candidates")
async def project_join_candidates_route(project_id: str):
    project = projects.get_project(project_id)
    if project is None:
        return JSONResponse({"error": "프로젝트를 찾을 수 없습니다."}, status_code=HttpStatus.NOT_FOUND)
    tables = project.get("tables") or []
    if not tables:
        # 스코프 미지정(전체 허용) 프로젝트는 후보가 카탈로그 전체 규모로 커질 수 있어 건너뛴다.
        return {"joins": []}

    in_scope = set(tables)
    seen: set[tuple[str, str, str, str]] = set()
    candidates: list[dict[str, str]] = []
    for table in tables:
        lookups = schema_lookups.get(table)
        if not isinstance(lookups, dict):
            continue
        for column, targets in lookups.items():
            if not isinstance(targets, list) or not isinstance(column, str):
                continue
            for target in targets:
                if target not in in_scope or target in _JOIN_CANDIDATE_EXCLUDE_TARGETS:
                    continue
                key = (table, column, target, f"{target}id")
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(
                    {"fromTable": table, "fromCol": column, "toTable": target, "toCol": f"{target}id", "label": ""}
                )
    return {"joins": candidates}


@app.patch("/api/projects/{project_id}")
async def update_project_route(project_id: str, request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse({"error": "요청 body는 JSON 객체여야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "name" in body and not isinstance(body["name"], str):
        return JSONResponse({"error": "name은 문자열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "tables" in body and not _is_string_array(body["tables"]):
        return JSONResponse({"error": "tables는 문자열 배열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "instructions" in body and not _is_instructions(body["instructions"]):
        return JSONResponse({"error": "instructions 형식이 올바르지 않습니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "cells" in body and not isinstance(body["cells"], list):
        return JSONResponse({"error": "cells는 배열이어야 합니다."}, status_code=HttpStatus.BAD_REQUEST)
    if "tables" in body:
        table_error = _validate_project_tables(body["tables"])
        if table_error:
            return JSONResponse({"error": table_error}, status_code=HttpStatus.BAD_REQUEST)
    updated = projects.update_project(
        project_id, name=body.get("name"), tables=body.get("tables"),
        instructions=body.get("instructions"), cells=body.get("cells"),
    )
    if updated is None:
        return JSONResponse({"error": "프로젝트를 찾을 수 없습니다."}, status_code=HttpStatus.NOT_FOUND)
    return updated


@app.delete("/api/projects/{project_id}")
async def delete_project_route(project_id: str):
    ok = projects.delete_project(project_id)
    if not ok:
        return JSONResponse({"error": "프로젝트를 찾을 수 없습니다."}, status_code=HttpStatus.NOT_FOUND)
    return {"ok": True}


# ─── API: 테이블 스키마 describe ─────────────────────────────────────────────
@app.get("/api/describe")
async def describe_route(table: str | None = None):
    if not table:
        return JSONResponse({"error": "table 파라미터 필요"}, status_code=HttpStatus.BAD_REQUEST)
    if table not in schema_meta:
        return JSONResponse({"error": f'등록되지 않은 테이블 "{table}"입니다.'}, status_code=HttpStatus.BAD_REQUEST)
    if table in schema_cache:
        return {"schema": schema_cache[table], "cached": True}

    # 동일 테이블 동시 요청은 하나의 조회에 합류
    task = pending_describe.get(table)
    created = task is None
    if created:
        task = asyncio.create_task(describe_table(table))
        pending_describe[table] = task

    try:
        schema = await task
        return {"schema": schema, "cached": False}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=HttpStatus.INTERNAL_SERVER_ERROR)
    finally:
        if created:
            pending_describe.pop(table, None)


# ─── API: 로그 조회 ───────────────────────────────────────────────────────────
@app.get("/api/logs")
async def get_logs(n: int = 100):
    n = max(1, min(n, 200))
    return list(reversed(read_json_log_tail(n, path=get_active_log_file_path())))


# ─── API: 헬스체크 (모니터링·기동 확인용) ────────────────────────────────────
# curl http://localhost:3000/api/health 한 줄로 가용 상태를 확인한다.
@app.get("/api/health")
async def health():
    dv_missing = dataverse_env_missing()
    status = provider_status()
    llm_health = await provider_health(2.0)
    chat: dict = {
        **status,
        "health": llm_health,
        "enabled": status["configured"] and not dv_missing and llm_health.get("status") == "ok",
    }
    if dv_missing:
        chat["missingEnv"] = dv_missing
    chat.update(api_status())
    return {
        "ok": True,
        "uptime": int(time.monotonic() - start_time),
        "schemaTables": len(schema_meta),
        "chat": chat,
    }


# ─── 채팅 엔드포인트 (선택 LLM provider + Dataverse Web API) ──────────────────
register_chat_api(app)


# 등록되지 않은 API를 SPA index.html로 숨기지 않고 일관된 JSON 404로 반환한다.
@app.api_route(
    "/api/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def unknown_api_route(full_path: str):
    return JSONResponse(
        {"error": f"API endpoint not found: /api/{full_path}"},
        status_code=HttpStatus.NOT_FOUND,
    )


@app.api_route("/api", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def unknown_api_root():
    return JSONResponse({"error": "API endpoint not found: /api"}, status_code=HttpStatus.NOT_FOUND)


# ─── 정적 파일 서빙 + SPA 폴백 ─────────────────────────────────────────────────
# 빌드 산출물만 제공한다. 저장소 문서 디렉터리는 서버에서 노출하지 않는다.
def _safe_join(base: Path, rel: str) -> Path | None:
    candidate = (base / rel).resolve()
    base_resolved = base.resolve()
    if candidate != base_resolved and base_resolved not in candidate.parents:
        return None
    return candidate


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if not ENABLE_API_DOCS and full_path in {"docs", "docs/", "redoc", "redoc/", "openapi.json"}:
        return JSONResponse({"error": "Not Found"}, status_code=HttpStatus.NOT_FOUND)
    dist_path = _safe_join(DIST_DIR, full_path)
    if dist_path and dist_path.is_file():
        return FileResponse(dist_path)

    index_path = DIST_DIR / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return PlainTextResponse("프론트엔드 빌드가 없습니다. npm run build 를 실행하세요.", status_code=HttpStatus.SERVICE_UNAVAILABLE)


# ─── 서버 기동 (python -m backend.main) ────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    # 문자열("backend.main:app")로 넘기면 uvicorn이 이 모듈을 "backend.main" 이름으로
    # 다시 import한다 — `python -m backend.main`으로 실행 중인 이 프로세스는 이미
    # 이 모듈을 "__main__"이라는 별도 이름으로 한 번 실행한 상태라, sys.modules 캐시가
    # 안 맞아 모듈 전체(스키마 카탈로그 로드, /api/chat 라우트 등록 등)가 한 번 더
    # 통째로 재실행된다(reload=False라도 마찬가지). 이미 만들어진 app 객체를 직접
    # 넘기면 재-import가 없어 정확히 한 번만 실행된다.
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        proxy_headers=True,             # nginx 등 리버스 프록시의 X-Forwarded-* 신뢰
        forwarded_allow_ips=FORWARDED_ALLOW_IPS,
        timeout_graceful_shutdown=SHUTDOWN_TIMEOUT_MS // 1000,
    )
