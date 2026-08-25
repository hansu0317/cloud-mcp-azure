"""토큰 사용량·예상 비용 기록/집계.

질문 하나가 끝날 때마다(도구 호출 루프 전체 합산 — 다이어그램 로그의 "토큰 in/out/
cache_read/cache_write"와 같은 값) chat_api.py가 record_usage()를 호출해
data/usage.jsonl에 한 줄(JSON Lines) 추가한다. 로그 파일(logs/server.*.log)에만
찍히고 화면 어디서도 안 보인다는 게 2026-08-24 피드백이었다 — 그 로그를 그대로
쓰지 않고 별도 파일로 남기는 이유는, 로그는 회전·삭제될 수 있어 누적 집계의 근거로
쓰기엔 불안정하기 때문이다.

비용은 Anthropic 공개 요금표(모델별 $/1M 토큰)로 추정한 값이다. 캐시 쓰기는 입력가의
1.25배, 캐시 읽기는 0.1배 — Anthropic이 전 모델에 공통으로 적용하는 배율(공식 문서
"cache_creation_input_tokens ~1.25x cost", "cache_read_input_tokens ~0.1x cost")을
그대로 곱한다. 실제 청구액과 반올림 차이가 날 수 있는 추정치일 뿐이다. Ollama(로컬)
등 요금표에 없는 모델은 비용 없이 토큰 수만 기록한다 — costUsd=None으로 "0원"과
"모른다"를 구분한다.
"""
from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

USAGE_FILE = Path.cwd() / "data" / "usage.jsonl"

# 모델별 (입력 $/1M, 출력 $/1M) — Claude API 공개 요금표(2026-06-24 기준 캐시값).
# 여기 없는 모델(로컬 Ollama 모델 등)은 estimate_cost_usd가 None을 돌려준다.
_PRICING_PER_MILLION: dict[str, tuple[float, float]] = {
    "claude-fable-5":    (10.00, 50.00),
    "claude-mythos-5":   (10.00, 50.00),
    "claude-opus-5":     (5.00, 25.00),
    "claude-opus-4-8":   (5.00, 25.00),
    "claude-opus-4-7":   (5.00, 25.00),
    "claude-opus-4-6":   (5.00, 25.00),
    "claude-sonnet-5":   (3.00, 15.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5":  (1.00, 5.00),
}
_CACHE_WRITE_MULTIPLIER = 1.25
_CACHE_READ_MULTIPLIER = 0.1


def estimate_cost_usd(
    model: str, input_tokens: int, output_tokens: int,
    cache_read_tokens: int, cache_write_tokens: int,
) -> float | None:
    pricing = _PRICING_PER_MILLION.get(model)
    if pricing is None:
        return None
    input_rate, output_rate = pricing
    cost = (
        input_tokens * input_rate
        + output_tokens * output_rate
        + cache_write_tokens * input_rate * _CACHE_WRITE_MULTIPLIER
        + cache_read_tokens * input_rate * _CACHE_READ_MULTIPLIER
    ) / 1_000_000
    return round(cost, 6)


# 모듈 임포트 시점엔 이벤트 루프가 없을 수 있어 asyncio.Lock()을 바로 못 만든다 —
# 첫 호출 때 지연 생성한다(backend/main.py의 _schema_write_lock과 같은 문제,
# 다만 그쪽은 모듈이 이벤트 루프 기동 후에 임포트돼서 괜찮았을 뿐 패턴은 동일).
_lock: asyncio.Lock | None = None


def _get_lock() -> asyncio.Lock:
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    return _lock


async def record_usage(
    *, project_id: str, provider: str, model: str,
    input_tokens: int, output_tokens: int, cache_read_tokens: int, cache_write_tokens: int,
    elapsed_s: float, query_count: int,
) -> None:
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "projectId": project_id,
        "provider": provider,
        "model": model,
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "costUsd": estimate_cost_usd(model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens),
        "elapsedS": round(elapsed_s, 2),
        "queryCount": query_count,
    }
    line = json.dumps(entry, ensure_ascii=False)
    async with _get_lock():
        USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with USAGE_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


def _empty_row() -> dict[str, Any]:
    return {
        "questions": 0, "inputTokens": 0, "outputTokens": 0,
        "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": 0.0,
        # costKnown=False면 이 합계에 비용을 모르는 모델(로컬 등)의 요청이 섞여
        # 있다는 뜻 — costUsd가 과소평가일 수 있다는 신호로 화면에 그대로 보여준다.
        "costKnown": True,
    }


def _is_today(ts_raw: Any, today_str: str) -> bool:
    """ts는 UTC로 저장돼 있다(record_usage 참고) — 그대로 문자열 접두어만 비교하면
    서버가 UTC보다 앞선 타임존(KST 등)일 때 자정 근처 요청이 "오늘"에서 빠진다(실제
    재현: KST 08시 요청이 UTC로는 전날 23시라 date.today()="오늘"과 안 맞았음). 로컬
    타임존으로 변환한 뒤 날짜만 비교해야 date.today()(로컬 기준)와 앞뒤가 맞는다."""
    try:
        ts = datetime.fromisoformat(str(ts_raw))
    except ValueError:
        return False
    if ts.tzinfo is not None:
        ts = ts.astimezone()
    return ts.date().isoformat() == today_str


def _add_row(row: dict[str, Any], entry: dict[str, Any]) -> None:
    row["questions"] += 1
    row["inputTokens"] += int(entry.get("inputTokens") or 0)
    row["outputTokens"] += int(entry.get("outputTokens") or 0)
    row["cacheReadTokens"] += int(entry.get("cacheReadTokens") or 0)
    row["cacheWriteTokens"] += int(entry.get("cacheWriteTokens") or 0)
    cost = entry.get("costUsd")
    if cost is None:
        row["costKnown"] = False
    else:
        row["costUsd"] += float(cost)


def usage_summary(project_id: str | None = None) -> dict[str, Any]:
    """오늘/전체 누적, project_id가 있으면 그 프로젝트 것도 같이 돌려준다.

    usage.jsonl을 매번 처음부터 다 읽어 합산한다 — 사내 도구 하나가 감당할 양(하루
    수십~수백 건 수준)이면 이걸로 충분하다. 나중에 파일이 너무 커지면 그때 월별로
    나누면 된다(예: usage-2026-08.jsonl) — 지금은 조기 최적화하지 않는다.
    """
    today_str = date.today().isoformat()
    today = _empty_row()
    all_time = _empty_row()
    project_today = _empty_row() if project_id else None
    project_all_time = _empty_row() if project_id else None

    if USAGE_FILE.exists():
        with USAGE_FILE.open("r", encoding="utf-8") as f:
            for raw_line in f:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    entry = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict):
                    continue
                _add_row(all_time, entry)
                is_today = _is_today(entry.get("ts"), today_str)
                if is_today:
                    _add_row(today, entry)
                if project_id and entry.get("projectId") == project_id:
                    _add_row(project_all_time, entry)  # type: ignore[arg-type]
                    if is_today:
                        _add_row(project_today, entry)  # type: ignore[arg-type]

    result: dict[str, Any] = {"today": today, "allTime": all_time}
    if project_id:
        result["project"] = {"today": project_today, "allTime": project_all_time}
    return result
