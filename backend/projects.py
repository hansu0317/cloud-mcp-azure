"""프로젝트 영속화 — data/projects/<id>.json 파일 하나당 프로젝트 하나.

server/projects.ts 포팅. "새 세션"(휘발성, 이름 없음)을 완전히 대체하는 개념이다.
프로젝트는
  - 이름
  - 테이블 스코프(tables — 빈 배열이면 "전체 테이블", 즉 스코프 제한 없음)
  - 지침(instructions — 조인 관계·용어·질문 예시. 2026-08-12부터 프로젝트별로 분리됨.
    이전엔 data/instructions.json 파일 하나를 모든 프로젝트가 공유했는데, 그러면
    관계없는 프로젝트의 few-shot 예시·용어가 매 질문에 섞여 들어가 프롬프트만
    커지고 오히려 방해가 될 수 있어 테이블 스코프처럼 프로젝트 단위로 분리했다)
  - 노트북 셀(cells — 프론트 전용 구조, 서버는 내용을 해석하지 않고 그대로 보관)
  - Claude 대화 히스토리(history — 프론트에는 절대 내려주지 않음, chat_api.py 전용)
를 파일로 들고 있어 서버 재시작·새 브라우저 창에서도 사용자가 직접 삭제하기
전까지 사라지지 않는다.

data/ 전체가 .gitignore 대상이라 별도 조치 없이 커밋에서 제외된다.

동기 파일 I/O만 사용한다 — TS 버전이 "async를 쓰지 않아 이벤트 루프 한 틱 안에서
끊기지 않는다"는 성질에 기댄 것과 마찬가지로, 이 모듈의 함수들은 FastAPI 라우트에서
스레드풀로 오프로딩되지 않는 한 그대로 두면 된다(각 함수 자체가 짧고 원자적).
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .logger import log

PROJECTS_DIR = Path.cwd() / "data" / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# 2026-08-12 이전까지 전체 프로젝트가 공유하던 지침 파일 — 마이그레이션 원본으로만 쓴다.
_LEGACY_GLOBAL_INST_FILE = Path.cwd() / "data" / "instructions.json"
_EMPTY_INSTRUCTIONS: dict[str, Any] = {"joins": [], "terms": [], "examples": []}

# UUID 형태만 허용 — 경로 탈출(예: "../../etc") 방지
_ID_RE = re.compile(r"^[a-zA-Z0-9-]+$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _read_json_file(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _file_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def _read_project(project_id: str) -> dict[str, Any] | None:
    if not _ID_RE.match(project_id):
        return None
    try:
        return json.loads(_file_path(project_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _write_project(p: dict[str, Any]) -> None:
    _file_path(p["id"]).write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")


def _to_summary(p: dict[str, Any]) -> dict[str, Any]:
    return {"id": p["id"], "name": p["name"], "tables": p["tables"], "createdAt": p["createdAt"], "updatedAt": p["updatedAt"]}


def _to_detail(p: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in p.items() if k != "history"}


def list_projects() -> list[dict[str, Any]]:
    try:
        files = [f.stem for f in PROJECTS_DIR.iterdir() if f.suffix == ".json"]
    except OSError:
        return []
    projects = [p for p in (_read_project(f) for f in files) if p is not None]
    summaries = [_to_summary(p) for p in projects]
    summaries.sort(key=lambda s: s["updatedAt"], reverse=True)  # 최근 사용순
    return summaries


def get_project(project_id: str) -> dict[str, Any] | None:
    p = _read_project(project_id)
    return _to_detail(p) if p else None


def create_project(name: str, tables: list[str] | None = None) -> dict[str, Any]:
    project_id = str(uuid.uuid4())
    now = _now_iso()
    p = {
        "id": project_id,
        "name": name.strip() or "제목 없는 프로젝트",
        "tables": tables or [],
        "instructions": dict(_EMPTY_INSTRUCTIONS),   # 새 프로젝트는 항상 빈 지침에서 시작
        "cells": [],
        "history": [],
        "createdAt": now,
        "updatedAt": now,
    }
    _write_project(p)
    log.info("PROJECT", f'생성: "{p["name"]}" ({project_id})')
    return _to_detail(p)


def update_project(
    project_id: str, *, name: str | None = None, tables: list[str] | None = None,
    instructions: dict[str, Any] | None = None, cells: list[Any] | None = None,
) -> dict[str, Any] | None:
    p = _read_project(project_id)
    if p is None:
        return None
    if name is not None:
        p["name"] = name.strip() or p["name"]
    if tables is not None:
        p["tables"] = tables
    if instructions is not None:
        p["instructions"] = instructions
    if cells is not None:
        p["cells"] = cells
    p["updatedAt"] = _now_iso()
    _write_project(p)
    return _to_detail(p)


# ─── 마이그레이션(2026-08-12): 전역 data/instructions.json → 프로젝트별 필드 ──────
# 기존에 만들어진 프로젝트 파일엔 "instructions" 키가 아예 없다(위 create_project가
# 이 필드를 추가하기 전에 만들어졌으므로). 그 경우에 한해 예전 전역 지침 내용을
# 그대로 복사해 넣는다 — 이미 값이 있는 프로젝트(마이그레이션 이후 생성/저장된)는
# 절대 덮어쓰지 않으므로 서버를 몇 번을 재시작해도 안전하다(멱등).
def _migrate_legacy_global_instructions() -> None:
    legacy = _read_json_file(_LEGACY_GLOBAL_INST_FILE, None)
    try:
        files = [f.stem for f in PROJECTS_DIR.iterdir() if f.suffix == ".json"]
    except OSError:
        return
    migrated = 0
    for pid in files:
        p = _read_project(pid)
        if p is None or "instructions" in p:
            continue
        p["instructions"] = dict(legacy) if legacy else dict(_EMPTY_INSTRUCTIONS)
        _write_project(p)
        migrated += 1
    if migrated:
        log.info("PROJECT", f"지침 마이그레이션: 전역 → 프로젝트 {migrated}개에 복사 완료")


_migrate_legacy_global_instructions()


def delete_project(project_id: str) -> bool:
    if not _ID_RE.match(project_id):
        return False
    try:
        _file_path(project_id).unlink()
        log.info("PROJECT", f"삭제: {project_id}")
        return True
    except OSError:
        return False


# ─── 채팅 히스토리(LLM 컨텍스트) — chat_api.py 전용, /api/projects 응답에는 절대 포함하지 않음 ──
def get_project_history(project_id: str) -> list[Any]:
    p = _read_project(project_id)
    return p["history"] if p else []


def get_project_tables(project_id: str) -> list[str]:
    p = _read_project(project_id)
    return p["tables"] if p else []


def save_project_history(project_id: str, history: list[Any]) -> None:
    existing = _read_project(project_id)
    now = _now_iso()
    p = existing or {
        "id": project_id, "name": "제목 없는 프로젝트", "tables": [], "cells": [], "history": [],
        "createdAt": now, "updatedAt": now,
    }
    p["history"] = history
    p["updatedAt"] = now
    _write_project(p)
