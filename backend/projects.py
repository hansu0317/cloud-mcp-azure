"""프로젝트 영속화 — data/projects/<id>.json 파일 하나당 프로젝트 하나.

"새 세션"(휘발성, 이름 없음)을 완전히 대체하는 개념이다.
프로젝트는
  - 이름
  - 테이블 스코프(tables — 빈 배열이면 "전체 테이블", 즉 스코프 제한 없음)
  - 지침(instructions — 조인 관계·용어·질문 예시. 2026-08-12부터 프로젝트별로 분리됨.
    이전엔 data/instructions.json 파일 하나를 모든 프로젝트가 공유했는데, 그러면
    관계없는 프로젝트의 few-shot 예시·용어가 매 질문에 섞여 들어가 프롬프트만
    커지고 오히려 방해가 될 수 있어 테이블 스코프처럼 프로젝트 단위로 분리했다)
  - 노트북 셀(cells — 프론트 전용 구조, 서버는 내용을 해석하지 않고 그대로 보관)
  - 공급자 중립 대화 히스토리(history — 프론트에는 절대 내려주지 않음, chat_api.py 전용)
를 파일로 들고 있어 서버 재시작·새 브라우저 창에서도 사용자가 직접 삭제하기
전까지 사라지지 않는다.

data/ 전체가 .gitignore 대상이라 별도 조치 없이 커밋에서 제외된다.

동기 파일 I/O만 사용한다 — TS 버전이 "async를 쓰지 않아 이벤트 루프 한 틱 안에서
끊기지 않는다"는 성질에 기댄 것과 마찬가지로, 이 모듈의 함수들은 FastAPI 라우트에서
스레드풀로 오프로딩되지 않는 한 그대로 두면 된다(각 함수 자체가 짧고 원자적).
"""
from __future__ import annotations

import json
import os
import re
import uuid
from copy import deepcopy
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


def _empty_instructions() -> dict[str, Any]:
    """호출자 사이에 내부 list 객체가 공유되지 않는 빈 지침을 반환한다."""
    return deepcopy(_EMPTY_INSTRUCTIONS)


def _copy_instructions(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _empty_instructions()
    return {
        "joins": deepcopy(value.get("joins")) if isinstance(value.get("joins"), list) else [],
        "terms": deepcopy(value.get("terms")) if isinstance(value.get("terms"), list) else [],
        "examples": deepcopy(value.get("examples")) if isinstance(value.get("examples"), list) else [],
    }


def _read_json_file(path: Path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _file_path(project_id: str) -> Path:
    """검증된 프로젝트 경로만 반환하고 심볼릭 링크 경로 탈출도 거부한다."""
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    root = PROJECTS_DIR.resolve()
    expected = root / f"{project_id}.json"
    path = (PROJECTS_DIR / f"{project_id}.json").resolve()
    if path != expected:
        raise ValueError("프로젝트 경로가 저장 디렉터리를 벗어났습니다.")
    return path


def _is_project_shape(value: Any, expected_id: str) -> bool:
    """파일을 API 객체로 사용하기 전에 필수 루트 구조를 검증한다."""
    if not isinstance(value, dict):
        return False
    if value.get("id") != expected_id or not isinstance(value.get("name"), str):
        return False
    if not isinstance(value.get("tables"), list) or not all(isinstance(item, str) for item in value["tables"]):
        return False
    if not isinstance(value.get("createdAt"), str) or not isinstance(value.get("updatedAt"), str):
        return False
    if "instructions" in value and not isinstance(value["instructions"], dict):
        return False
    if "cells" in value and not isinstance(value["cells"], list):
        return False
    if "history" in value and not isinstance(value["history"], list):
        return False
    return True


def _read_project(project_id: str) -> dict[str, Any] | None:
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        return None
    try:
        value = json.loads(_file_path(project_id).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    if not _is_project_shape(value, project_id):
        log.error("PROJECT", f"손상된 프로젝트 파일 무시: {project_id}.json")
        return None
    return deepcopy(value)


def _write_project(p: dict[str, Any]) -> None:
    project_id = p.get("id")
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    if not _is_project_shape(p, project_id):
        raise ValueError("프로젝트 데이터 형식이 올바르지 않습니다.")

    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    target = _file_path(project_id)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    if temporary.parent.resolve() != PROJECTS_DIR.resolve():
        raise ValueError("임시 프로젝트 경로가 저장 디렉터리를 벗어났습니다.")

    payload = json.dumps(p, ensure_ascii=False, indent=2)
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _to_summary(p: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(
        {
            "id": p["id"], "name": p["name"], "tables": p["tables"],
            "createdAt": p["createdAt"], "updatedAt": p["updatedAt"],
            "order": p.get("order", 0),
        }
    )


def _to_detail(p: dict[str, Any]) -> dict[str, Any]:
    return deepcopy({k: v for k, v in p.items() if k != "history"})


def list_projects() -> list[dict[str, Any]]:
    try:
        files = [f.stem for f in PROJECTS_DIR.iterdir() if f.suffix == ".json"]
    except OSError:
        return []
    projects = [p for p in (_read_project(f) for f in files) if p is not None]

    # 2026-08-21 이전 프로젝트엔 order 필드가 없다 — 그 경우 하나라도 있으면 예전
    # 정렬 기준(최근 사용순)으로 한 번만 order를 매겨 파일에 자가 치유(self-heal)한다.
    # 그 이후로는 순서를 수동으로 옮기면(reorder_projects) 이 값만 바뀐다.
    if any("order" not in p for p in projects):
        projects.sort(key=lambda p: p["updatedAt"], reverse=True)
        for index, p in enumerate(projects):
            if p.get("order") != index:
                p["order"] = index
                _write_project(p)

    summaries = [_to_summary(p) for p in projects]
    summaries.sort(key=lambda s: s["order"])
    return summaries


def reorder_projects(ordered_ids: list[str]) -> list[dict[str, Any]]:
    """사이드바에서 위/아래로 옮긴 새 순서를 그대로 order에 반영한다.

    프론트가 이미 화면에 보이는 전체 프로젝트 id를 새 순서대로 보내주므로, 여기서는
    각 프로젝트의 order를 그 배열 인덱스로 덮어쓰기만 한다 — 두 개씩 스왑하는 것보다
    간단하고, 나중에 드래그 앤 드롭으로 바꿔도 이 함수는 그대로 재사용된다.
    """
    for index, project_id in enumerate(ordered_ids):
        p = _read_project(project_id)
        if p is None:
            continue
        if p.get("order") != index:
            p["order"] = index
            _write_project(p)
    return list_projects()


def get_project(project_id: str) -> dict[str, Any] | None:
    p = _read_project(project_id)
    return _to_detail(p) if p else None


def create_project(name: str, tables: list[str] | None = None) -> dict[str, Any]:
    project_id = str(uuid.uuid4())
    now = _now_iso()
    try:
        existing_count = sum(1 for f in PROJECTS_DIR.iterdir() if f.suffix == ".json")
    except OSError:
        existing_count = 0
    p = {
        "id": project_id,
        "name": name.strip() or "제목 없는 프로젝트",
        "tables": deepcopy(tables) if tables else [],
        "instructions": _empty_instructions(),   # 새 프로젝트는 항상 빈 지침에서 시작
        "cells": [],
        "history": [],
        "createdAt": now,
        "updatedAt": now,
        "order": existing_count,   # 사이드바 맨 아래에 추가 — 위/아래 버튼으로 옮긴 순서만 이후 유지
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
        p["tables"] = deepcopy(tables)
    if instructions is not None:
        p["instructions"] = _copy_instructions(instructions)
    if cells is not None:
        p["cells"] = deepcopy(cells)
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
        p["instructions"] = _copy_instructions(legacy)
        _write_project(p)
        migrated += 1
    if migrated:
        log.info("PROJECT", f"지침 마이그레이션: 전역 → 프로젝트 {migrated}개에 복사 완료")


_migrate_legacy_global_instructions()


def delete_project(project_id: str) -> bool:
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        return False
    try:
        _file_path(project_id).unlink()
        log.info("PROJECT", f"삭제: {project_id}")
        return True
    except (OSError, ValueError):
        return False


# ─── 채팅 히스토리(LLM 컨텍스트) — chat_api.py 전용, /api/projects 응답에는 절대 포함하지 않음 ──
def get_project_history(project_id: str) -> list[Any]:
    p = _read_project(project_id)
    history = p.get("history") if p else None
    return deepcopy(history) if isinstance(history, list) else []


def get_project_tables(project_id: str) -> list[str]:
    p = _read_project(project_id)
    tables = p.get("tables") if p else None
    return list(tables) if isinstance(tables, list) else []


def get_project_instructions(project_id: str) -> dict[str, Any]:
    p = _read_project(project_id)
    return _copy_instructions(p.get("instructions") if p else None)


def get_project_name(project_id: str) -> str:
    # 로그에 project_id(UUID)만 남으면 사람이 눈으로 구분할 수 없어서, 채팅 로그에
    # 같이 찍을 사람이 읽을 수 있는 이름을 조회하는 용도(chat_api.py의 log_context).
    p = _read_project(project_id)
    name = p.get("name") if p else None
    return name if isinstance(name, str) and name else project_id


def project_exists(project_id: str) -> bool:
    return _read_project(project_id) is not None


def save_project_history(project_id: str, history: list[Any]) -> bool:
    existing = _read_project(project_id)
    if existing is None:
        return False
    existing["history"] = deepcopy(history)
    existing["updatedAt"] = _now_iso()
    _write_project(existing)
    return True
