"""Quali CRM Chat 서버 진입점 (Python/FastAPI). server/index.ts 포팅.

실행:
  개발:   uvicorn backend.main:app --reload --port 3000
  운영:   python -m backend.main   (uvicorn.run 호출, graceful shutdown 포함)
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # 아래 backend.* 모듈들이 import 시점에 환경변수를 읽으므로 반드시 가장 먼저 실행

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.middleware.base import BaseHTTPMiddleware

from .chat_api import api_status, cleanup_loop, register_chat_api
from .dataverse import dataverse_env_missing, fetch_entity_schema
from .logger import log
from .sse import HttpStatus
from . import projects

# ─── 환경변수 ─────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", "3000"))
SHUTDOWN_TIMEOUT_MS = int(os.environ.get("SHUTDOWN_TIMEOUT_MS", "30000"))
RL_WINDOW_MS = int(os.environ.get("RATE_LIMIT_WINDOW_MS", "60000"))
RL_MAX = int(os.environ.get("RATE_LIMIT_MAX", "20"))
API_KEY = os.environ.get("API_KEY", "")

CWD = Path.cwd()
INST_FILE = CWD / "data" / "instructions.json"
SCHEMA_FILE = CWD / "data" / "schema.json"
DIST_DIR = CWD / "dist"
DOCS_DIR = CWD / "docs"


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

schema_cache: dict[str, str] = {}                      # 스키마 텍스트
schema_meta: dict[str, dict[str, str]] = {}             # 등록 테이블 전체
pending_describe: dict[str, asyncio.Task] = {}


# schema.json → 인메모리 카탈로그 동기화 (기동 시 + 갱신 완료 후 공통 호출)
def reload_from_schema_file() -> None:
    data = _read_json_file(SCHEMA_FILE, {})
    schema_cache.clear()
    schema_meta.clear()
    for table, info in data.items():
        schema_meta[table] = {"label": info.get("label") or table, "domain": info.get("domain") or "기타"}
        if info.get("schema"):
            schema_cache[table] = info["schema"]
    log.info("SCHEMA", f"카탈로그 동기화: {len(schema_meta)}개 테이블 (스키마 로드: {len(schema_cache)}개)")


reload_from_schema_file()


# ─── FastAPI 앱 ────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_app: FastAPI):
    cleanup_task = asyncio.create_task(cleanup_loop())
    log.info("SERVER", f"Quali CRM Chat 서버 기동 — http://localhost:{PORT}")
    print(f"\n{'━' * 40}")
    print("  Quali CRM Chat 서버 실행 중")
    print(f"  http://localhost:{PORT}")
    print(f"  Rate-limit: {RL_MAX}req/{RL_WINDOW_MS / 1000}s")
    print(f"{'━' * 40}\n")
    yield
    cleanup_task.cancel()
    log.info("SERVER", "모든 연결 종료 — 프로세스 정상 종료")


app = FastAPI(lifespan=lifespan)


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
_rate_buckets: dict[str, tuple[int, float]] = {}


class RateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/chat") or path.startswith("/api/describe"):
            ip = request.client.host if request.client else "unknown"
            now = time.monotonic()
            count, window_start = _rate_buckets.get(ip, (0, now))
            if now - window_start > RL_WINDOW_MS / 1000:
                count, window_start = 0, now
            count += 1
            _rate_buckets[ip] = (count, window_start)
            if count > RL_MAX:
                return JSONResponse({"error": "요청이 너무 많습니다. 잠시 후 다시 시도하세요."}, status_code=HttpStatus.TOO_MANY_REQUESTS)
        return await call_next(request)


# add_middleware로 추가한 순서의 역순으로 바깥에서 안으로 감싸므로, 나중에 추가한
# ApiKeyMiddleware가 가장 바깥(먼저 실행)이 되어 인증 → rate-limit 순서가 된다.
app.add_middleware(RateLimitMiddleware)
app.add_middleware(ApiKeyMiddleware)
if API_KEY:
    log.info("SERVER", "API 키 인증 활성화됨")


# ─── API: 스키마 갱신 ─────────────────────────────────────────────────────────
async def describe_table(table: str) -> str:
    missing = dataverse_env_missing()
    if missing:
        raise RuntimeError(f"{missing} 환경변수가 설정되지 않았습니다. (.env 확인)")

    result = await fetch_entity_schema(table)

    schema_cache[table] = result.markdown
    existing = _read_json_file(SCHEMA_FILE, {})
    entry = existing.get(table, {})
    entry.update({"schema": result.markdown, "entitySetName": result.entity_set_name, "updatedAt": _now_iso()})
    existing[table] = entry
    try:
        SCHEMA_FILE.write_text(json.dumps(existing, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        pass  # 무시
    if table not in schema_meta:
        schema_meta[table] = {"label": entry.get("label") or table, "domain": entry.get("domain") or "기타"}
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

    for i in range(0, len(tables), REFRESH_BATCH_SIZE):
        batch = tables[i:i + REFRESH_BATCH_SIZE]
        outcomes.extend(await asyncio.gather(*(run_one(t) for t in batch)))

    results = [t for t, ok in zip(tables, outcomes) if ok]
    log.info("SCHEMA", f"갱신 완료 — {len(results)}/{len(tables)}개 성공 (총 {time.monotonic() - total_start:.1f}초)")
    reload_from_schema_file()   # schema.json → 인메모리 카탈로그 전체 재동기화
    schema_refreshing = False
    return {"updated": len(results), "tables": results}


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
    name = body.get("name") or ""
    tables = body.get("tables") if isinstance(body.get("tables"), list) else []
    return projects.create_project(name, tables)


@app.get("/api/projects/{project_id}")
async def get_project_route(project_id: str):
    project = projects.get_project(project_id)
    if project is None:
        return JSONResponse({"error": "프로젝트를 찾을 수 없습니다."}, status_code=HttpStatus.NOT_FOUND)
    return project


@app.patch("/api/projects/{project_id}")
async def update_project_route(project_id: str, request: Request):
    body = await request.json()
    updated = projects.update_project(project_id, name=body.get("name"), tables=body.get("tables"), cells=body.get("cells"))
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


# ─── API: 지침 ────────────────────────────────────────────────────────────────
def _read_instructions():
    return _read_json_file(INST_FILE, {"joins": [], "terms": [], "examples": []})


@app.get("/api/instructions")
async def get_instructions():
    return _read_instructions()


@app.post("/api/instructions")
async def post_instructions(request: Request):
    body = await request.json()
    try:
        INST_FILE.write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True}
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=HttpStatus.INTERNAL_SERVER_ERROR)


# ─── API: 로그 조회 ───────────────────────────────────────────────────────────
@app.get("/api/logs")
async def get_logs(n: int = 100):
    n = min(n, 200)
    log_path = CWD / "logs" / "app.log"
    if not log_path.exists():
        return []
    try:
        lines = [l for l in log_path.read_text(encoding="utf-8").strip().split("\n") if l]
        entries = []
        for line in reversed(lines[-n:]):
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=HttpStatus.INTERNAL_SERVER_ERROR)


# ─── API: 헬스체크 (모니터링·기동 확인용) ────────────────────────────────────
# curl http://localhost:3000/api/health 한 줄로 가용 상태를 확인한다.
@app.get("/api/health")
async def health():
    dv_missing = dataverse_env_missing()
    chat: dict = {"enabled": bool(os.environ.get("ANTHROPIC_API_KEY")) and not dv_missing}
    if dv_missing:
        chat["missingEnv"] = dv_missing
    chat.update(api_status())
    return {
        "ok": True,
        "uptime": int(time.monotonic() - start_time),
        "schemaTables": len(schema_meta),
        "chat": chat,
    }


# ─── 채팅 엔드포인트 (Claude API + Dataverse Web API) ─────────────────────────
if os.environ.get("ANTHROPIC_API_KEY"):
    register_chat_api(app)
else:
    log.error("SERVER", "ANTHROPIC_API_KEY 미설정 — 채팅(/api/chat) 비활성. .env를 확인하세요.")


# ─── 정적 파일 서빙 + SPA 폴백 ─────────────────────────────────────────────────
# express.static(dist) + express.static(docs, '/docs') + app.get('*', ...) 세 개를
# 하나의 GET 캐치올 라우트로 통합 — 반드시 위의 /api/* 라우트들보다 나중에 등록돼야
# 그것들이 먼저 매칭된다(Starlette는 등록 순서대로 첫 매치를 채택).
def _safe_join(base: Path, rel: str) -> Path | None:
    candidate = (base / rel).resolve()
    base_resolved = base.resolve()
    if candidate != base_resolved and base_resolved not in candidate.parents:
        return None
    return candidate


@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if full_path.startswith("docs/") and DOCS_DIR.exists():
        doc_path = _safe_join(DOCS_DIR, full_path[len("docs/"):])
        if doc_path and doc_path.is_file():
            return FileResponse(doc_path)

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

    uvicorn.run(
        "backend.main:app",
        host="0.0.0.0",
        port=PORT,
        proxy_headers=True,             # nginx 등 리버스 프록시 뒤에서 X-Forwarded-* 신뢰 (Express의 trust proxy 대응)
        forwarded_allow_ips="*",
        timeout_graceful_shutdown=SHUTDOWN_TIMEOUT_MS // 1000,
    )
