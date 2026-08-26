"""프로젝트 영속화 — v1: 전부 개인 프로젝트, DocumentStore의 "users/<이메일>/projects" 컬렉션.

★ v2(부서·관리자 공유 프로젝트, 소유자 전용 편집, 읽기전용 공유 등)는 잠시
보류했다 — 그 코드는 전부 `v2-department-access-control` 브랜치에 그대로
보존돼 있으니, 나중에 다시 꺼낼 땐 그 브랜치를 참고할 것(2026-08-25, 책임연구원
논의로 "1차는 단순하게, 부서 구분은 2차"로 정리됨).

이 파일은 그보다 훨씬 단순한 모델이다: 로그인한 사람마다 자기 폴더 안의
프로젝트만 보고 고칠 수 있다. 남의 프로젝트는 존재 자체를 모른다(부서 공유·
관리자 오버사이트·읽기전용 같은 개념이 아예 없음) — 그래서 아래 모든 함수가
`viewer_email`을 받는다: 그 사람 폴더 밖은 건드릴 수도, 알 수도 없다.

프로젝트는
  - 이름
  - 테이블 스코프(tables — 빈 배열이면 "전체 테이블", 즉 스코프 제한 없음)
  - 지침(instructions — 조인 관계·용어·질문 예시. 프로젝트별로 분리되어 있어
    관계없는 프로젝트의 few-shot 예시·용어가 매 질문에 섞여 들어가지 않는다)
  - 노트북 셀(cells — 프론트 전용 구조, 서버는 내용을 해석하지 않고 그대로 보관)
  - 공급자 중립 대화 히스토리(history — 프론트에는 절대 내려주지 않음, chat_api.py 전용)
를 파일로 들고 있어 서버 재시작·새 브라우저 창에서도 사용자가 직접 삭제하기
전까지 사라지지 않는다.

data/ 전체가 .gitignore 대상이라 별도 조치 없이 커밋에서 제외된다.

★ 실제 저장은 이 파일이 직접 하지 않는다(2026-08-26부터) — `backend/stores`의
DocumentStore(기본 구현: LocalFileStore, 로컬 JSON 파일)에 위임한다. 이 파일이 아는 건
"이메일·id 문자열 넣으면 dict 나온다"는 계약뿐이고, 호출부(main.py/chat_api.py)도 이
계약만 안다 — 파일 경로나 JSON 형식은 전혀 모른다. 그래서 나중에 실제 서버(온프레미스
DB, Azure Table Storage 등)로 옮길 때는 `backend/stores/factory.py`에 그 구현체를
추가하기만 하면 되고, 이 파일도 호출부도 고칠 필요가 없다. 각 프로젝트 문서는 store가
관리하는 `_rev`(정수 버전) 필드를 갖게 되는데, 지금은 아무도 강제하지 않고(update_project의
expected_rev 기본값 None = 무조건 덮어쓰기, 지금까지와 동일한 동작) 나중에 "다른 탭/기기에서
먼저 저장한 내용을 덮어쓰지 않게" 강제하고 싶을 때 그 값을 쓸 수 있도록 미리 흘려보내 둔다.

동기 파일 I/O만 사용한다 — TS 버전이 "async를 쓰지 않아 이벤트 루프 한 틱 안에서
끊기지 않는다"는 성질에 기댄 것과 마찬가지로, 이 모듈의 함수들은 FastAPI 라우트에서
스레드풀로 오프로딩되지 않는 한 그대로 두면 된다(각 함수 자체가 짧고 원자적).
"""
from __future__ import annotations

import re
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from ..core.logger import log
from ..stores.base import VersionConflict
from ..stores.factory import get_store

_EMPTY_INSTRUCTIONS: dict[str, Any] = {"joins": [], "terms": [], "examples": []}

# UUID 형태만 허용 — 경로 탈출(예: "../../etc") 방지
_ID_RE = re.compile(r"^[a-zA-Z0-9-]+$")

# 이메일을 collection 경로 세그먼트로 쓸 때 위험한 문자(경로 구분자 등)를 치환 — 로그인
# 이메일은 이미 검증된 값이라 실제로 걸릴 일은 거의 없지만 방어적으로 둔다.
_EMAIL_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9@_.-]")

# VersionConflict를 그대로 재노출 — 호출부가 backend.stores를 직접 몰라도 되게 한다.
ProjectVersionConflict = VersionConflict


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


def _collection(email: str) -> str:
    safe = _EMAIL_UNSAFE_RE.sub("_", email.strip().lower()) or "unknown"
    return f"users/{safe}/projects"


def _is_project_shape(value: Any, expected_id: str) -> bool:
    """저장소에서 읽은 값을 API 객체로 사용하기 전에 필수 루트 구조를 검증한다."""
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
    if "ownerEmail" in value and value["ownerEmail"] is not None and not isinstance(value["ownerEmail"], str):
        return False
    return True


def _read_project(email: str, project_id: str) -> dict[str, Any] | None:
    if not email or not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        return None
    try:
        value = get_store().get(_collection(email), project_id)
    except ValueError:
        return None
    if value is None:
        return None
    if not _is_project_shape(value, project_id):
        log.error("PROJECT", f"손상된 프로젝트 문서 무시: {project_id}")
        return None
    return deepcopy(value)


def _write_project(email: str, p: dict[str, Any], *, expected_rev: int | None = None) -> dict[str, Any]:
    project_id = p.get("id")
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    if not _is_project_shape(p, project_id):
        raise ValueError("프로젝트 데이터 형식이 올바르지 않습니다.")
    return get_store().put(_collection(email), project_id, p, expected_rev=expected_rev)


def _to_summary(p: dict[str, Any]) -> dict[str, Any]:
    return deepcopy(
        {
            "id": p["id"], "name": p["name"], "tables": p["tables"],
            "createdAt": p["createdAt"], "updatedAt": p["updatedAt"],
            "order": p.get("order", 0), "ownerEmail": p.get("ownerEmail"),
        }
    )


def _to_detail(p: dict[str, Any]) -> dict[str, Any]:
    return deepcopy({k: v for k, v in p.items() if k != "history"})


def list_projects(viewer_email: str | None) -> list[dict[str, Any]]:
    if not viewer_email:
        return []
    try:
        ids = get_store().list_keys(_collection(viewer_email))
    except ValueError:
        return []
    projects = [p for p in (_read_project(viewer_email, pid) for pid in ids) if p is not None]

    # 이전 세대(부서 공유 시절) 프로젝트엔 order 필드가 없다 — 하나라도 있으면
    # 최근 사용순으로 한 번만 order를 매겨 문서를 자가 치유(self-heal)한다.
    if any("order" not in p for p in projects):
        projects.sort(key=lambda p: p["updatedAt"], reverse=True)
        for index, p in enumerate(projects):
            if p.get("order") != index:
                p["order"] = index
                _write_project(viewer_email, p)

    summaries = [_to_summary(p) for p in projects]
    summaries.sort(key=lambda s: s["order"])
    return summaries


def reorder_projects(viewer_email: str, ordered_ids: list[str]) -> list[dict[str, Any]]:
    """사이드바에서 위/아래로 옮긴 새 순서를 그대로 order에 반영한다."""
    for index, project_id in enumerate(ordered_ids):
        p = _read_project(viewer_email, project_id)
        if p is None:
            continue
        if p.get("order") != index:
            p["order"] = index
            _write_project(viewer_email, p)
    return list_projects(viewer_email)


def get_project(viewer_email: str | None, project_id: str) -> dict[str, Any] | None:
    if not viewer_email:
        return None
    p = _read_project(viewer_email, project_id)
    return _to_detail(p) if p else None


def create_project(viewer_email: str, name: str, tables: list[str] | None = None) -> dict[str, Any]:
    project_id = str(uuid.uuid4())
    now = _now_iso()
    try:
        existing_count = len(get_store().list_keys(_collection(viewer_email)))
    except ValueError:
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
        "order": existing_count,   # 목록 맨 아래에 추가 — 위/아래 버튼으로 옮긴 순서만 이후 유지
        "ownerEmail": viewer_email,
    }
    p = _write_project(viewer_email, p)
    log.info("PROJECT", f'생성: "{p["name"]}" ({project_id}), 소유자: {viewer_email}')
    return _to_detail(p)


def update_project(
    viewer_email: str, project_id: str, *, name: str | None = None, tables: list[str] | None = None,
    instructions: dict[str, Any] | None = None, cells: list[Any] | None = None,
    expected_rev: int | None = None,
) -> dict[str, Any] | None:
    """expected_rev를 주면(지금은 아무 호출부도 안 준다 — 준비만 해둔 상태) 그 사이 다른
    곳에서 먼저 저장된 문서를 조용히 덮어쓰지 않고 ProjectVersionConflict를 던진다."""
    p = _read_project(viewer_email, project_id)
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
    p = _write_project(viewer_email, p, expected_rev=expected_rev)
    return _to_detail(p)


def delete_project(viewer_email: str, project_id: str) -> bool:
    p = _read_project(viewer_email, project_id)
    if p is None:
        return False
    if get_store().delete(_collection(viewer_email), project_id):
        log.info("PROJECT", f"삭제: {project_id}")
        return True
    return False


# ─── 채팅 히스토리(LLM 컨텍스트) — chat_api.py 전용, /api/projects 응답에는 절대 포함하지 않음 ──
def get_project_history(viewer_email: str, project_id: str) -> list[Any]:
    p = _read_project(viewer_email, project_id)
    history = p.get("history") if p else None
    return deepcopy(history) if isinstance(history, list) else []


def get_project_tables(viewer_email: str, project_id: str) -> list[str]:
    p = _read_project(viewer_email, project_id)
    tables = p.get("tables") if p else None
    return list(tables) if isinstance(tables, list) else []


def get_project_instructions(viewer_email: str, project_id: str) -> dict[str, Any]:
    p = _read_project(viewer_email, project_id)
    return _copy_instructions(p.get("instructions") if p else None)


def get_project_name(viewer_email: str, project_id: str) -> str:
    # 로그에 project_id(UUID)만 남으면 사람이 눈으로 구분할 수 없어서, 채팅 로그에
    # 같이 찍을 사람이 읽을 수 있는 이름을 조회하는 용도(chat_api.py의 log_context).
    p = _read_project(viewer_email, project_id)
    name = p.get("name") if p else None
    return name if isinstance(name, str) and name else project_id


def project_exists(viewer_email: str, project_id: str) -> bool:
    return _read_project(viewer_email, project_id) is not None


def save_project_history(viewer_email: str, project_id: str, history: list[Any]) -> bool:
    existing = _read_project(viewer_email, project_id)
    if existing is None:
        return False
    existing["history"] = deepcopy(history)
    existing["updatedAt"] = _now_iso()
    _write_project(viewer_email, existing)
    return True
