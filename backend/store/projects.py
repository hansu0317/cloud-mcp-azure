"""프로젝트 영속화 — 프로젝트 하나당 파일 하나, 저장 위치는 공개범위로 정해진다.

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

★ 저장 위치는 두 곳으로 완전히 나뉜다(2026-08-25 — "개인 프로젝트가 공통과 안
겹치게 해달라"는 요구):
  - data/projects/<id>.json — 공유(부서·전사 공통) 프로젝트. 관리자/소유자가 관리.
  - data/users/<이메일>/projects/<id>.json — 개인 전용(visibility="private") 프로젝트.
    만든 사람의 개인 폴더에만 있고, 공유 폴더와 절대 섞이지 않는다.
  한 번 정해진 위치는 안 바뀐다 — "개인 프로젝트를 나중에 부서에 공유되게 넓힌다"는
  기능은 일부러 안 만들었다(동시편집 문제를 막으려고 소유자 전용 편집으로 갔는데,
  나중에 남에게 공개되면 그 취지가 흔들리고 파일을 옮겨야 해서 복잡해짐 — 사용자
  판단으로 폐기). 그래서 update_project()에 department/visibility 파라미터가 없다 —
  둘 다 create_project() 시점에만 정해진다.

data/ 전체가 .gitignore 대상이라 별도 조치 없이 커밋에서 제외된다.

동기 파일 I/O만 사용한다 — TS 버전이 "async를 쓰지 않아 이벤트 루프 한 틱 안에서
끊기지 않는다"는 성질에 기댄 것과 마찬가지로, 이 모듈의 함수들은 FastAPI 라우트에서
스레드풀로 오프로딩되지 않는 한 그대로 두면 된다(각 함수 자체가 짧고 원자적).

★ 나중에 "로컬 파일 → 공용 서버/DB"로 옮기는 방법(2026-08-25): 지금 로컬 파일에
직접 손대는 곳은 밑줄로 시작하는 함수들뿐이다 — PROJECTS_DIR, USERS_ROOT,
_file_path, _personal_file_path, _personal_dir, _locate_file, _read_project,
_write_project, _read_json_file. 그 아래 밑줄 없는 함수들(list_projects/
get_project/create_project/update_project/delete_project/save_project_history
등)은 전부 "id 문자열 넣으면 dict 나온다" 식의 평범한 계약만 쓰고, 호출부
(main.py/chat_api.py)도 이 계약만 안다 — 파일 경로나 JSON 형식은 전혀 모른다.
그래서 나중에 실제 서버(원격 DB, model 쪽 공용 서버 등)로 옮길 때도 이 파일 안의
밑줄 함수들만 그 서버 호출로 바꿔치면 되고, 호출부는 한 줄도 안 고쳐도 된다 —
departments.py의 get_department()와 같은 패턴.
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

from ..core.logger import log

PROJECTS_DIR = Path.cwd() / "data" / "projects"
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# 개인 전용 프로젝트 루트 — data/users/<이메일 폴더명>/projects/<id>.json.
# data/users.json(부서·관리자 명단 파일)과 이름이 비슷해 보이지만 전혀 다른
# 경로다(파일 vs 폴더) — 헷갈리면 이 docstring부터 다시 볼 것.
USERS_ROOT = Path.cwd() / "data" / "users"

# 2026-08-12 이전까지 전체 프로젝트가 공유하던 지침 파일 — 마이그레이션 원본으로만 쓴다.
_LEGACY_GLOBAL_INST_FILE = Path.cwd() / "data" / "instructions.json"
_EMPTY_INSTRUCTIONS: dict[str, Any] = {"joins": [], "terms": [], "examples": []}

# UUID 형태만 허용 — 경로 탈출(예: "../../etc") 방지
_ID_RE = re.compile(r"^[a-zA-Z0-9-]+$")

# 이메일을 폴더명으로 쓸 때 위험한 문자(경로 구분자 등)를 치환 — 로그인 이메일은
# 이미 검증된 값이라 실제로 걸릴 일은 거의 없지만 방어적으로 둔다.
_EMAIL_UNSAFE_RE = re.compile(r"[^a-zA-Z0-9@_.-]")


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
    """공유 풀(PROJECTS_DIR) 안의 검증된 경로만 반환하고 경로 탈출도 거부한다."""
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    root = PROJECTS_DIR.resolve()
    expected = root / f"{project_id}.json"
    path = (PROJECTS_DIR / f"{project_id}.json").resolve()
    if path != expected:
        raise ValueError("프로젝트 경로가 저장 디렉터리를 벗어났습니다.")
    return path


def _personal_dir(email: str) -> Path:
    safe = _EMAIL_UNSAFE_RE.sub("_", email.strip().lower()) or "unknown"
    d = USERS_ROOT / safe / "projects"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _personal_file_path(email: str, project_id: str) -> Path:
    """개인 폴더 안의 검증된 경로만 반환하고 경로 탈출도 거부한다(_file_path와 동일 패턴)."""
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    root = _personal_dir(email).resolve()
    path = (root / f"{project_id}.json").resolve()
    if path.parent != root:
        raise ValueError("프로젝트 경로가 저장 디렉터리를 벗어났습니다.")
    return path


def _locate_file(project_id: str) -> Path | None:
    """공유 풀에 있는지 개인 폴더들 중 하나에 있는지 몰라도 ID만으로 찾는다 —
    호출부(main.py)는 이 프로젝트가 어디 저장돼 있는지 전혀 몰라도 된다."""
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        return None
    shared = PROJECTS_DIR / f"{project_id}.json"
    if shared.exists():
        return shared
    if USERS_ROOT.exists():
        for match in USERS_ROOT.glob(f"*/projects/{project_id}.json"):
            return match
    return None


def _count_all_projects() -> int:
    try:
        count = sum(1 for f in PROJECTS_DIR.iterdir() if f.suffix == ".json")
    except OSError:
        count = 0
    if USERS_ROOT.exists():
        count += sum(1 for _ in USERS_ROOT.glob("*/projects/*.json"))
    return count


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
    # 2026-08-25: 계정별 접근 구분(owner/department/visibility) — 전부 선택 필드다.
    # 기존 프로젝트 파일엔 이 키들이 아예 없고, department 없음은 "공통"으로 해석된다
    # — 단, 보는 사람도 부서가 있어야 한다(_is_visible). 부서가 없는(DEPARTMENT_MAP에
    # 없는) 로그인 사용자는 공통이든 뭐든 아무 공유 프로젝트도 못 본다.
    if "ownerEmail" in value and value["ownerEmail"] is not None and not isinstance(value["ownerEmail"], str):
        return False
    if "department" in value and value["department"] is not None and not isinstance(value["department"], str):
        return False
    if "visibility" in value and value["visibility"] not in ("shared", "private"):
        return False
    return True


def _read_project(project_id: str) -> dict[str, Any] | None:
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        return None
    path = _locate_file(project_id)
    if path is None:
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not _is_project_shape(value, project_id):
        log.error("PROJECT", f"손상된 프로젝트 파일 무시: {project_id}.json")
        return None
    return deepcopy(value)


def _write_project(p: dict[str, Any]) -> None:
    """이미 어딘가에 있으면 그 자리에 그대로 덮어쓴다(위치 불변) — 없으면(신규
    생성) visibility="private"이고 ownerEmail이 있을 때만 개인 폴더로, 그 외엔
    전부 공유 풀로 간다."""
    project_id = p.get("id")
    if not isinstance(project_id, str) or not _ID_RE.fullmatch(project_id):
        raise ValueError("유효하지 않은 프로젝트 ID입니다.")
    if not _is_project_shape(p, project_id):
        raise ValueError("프로젝트 데이터 형식이 올바르지 않습니다.")

    existing_path = _locate_file(project_id)
    if existing_path is not None:
        target = existing_path
    elif p.get("visibility") == "private" and p.get("ownerEmail"):
        target = _personal_file_path(p["ownerEmail"], project_id)
    else:
        target = _file_path(project_id)

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    if temporary.parent.resolve() != target.parent.resolve():
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
            "visibility": p.get("visibility", "shared"),
            "ownerEmail": p.get("ownerEmail"),
            "department": p.get("department"),
        }
    )


# 2026-08-25: 계정별 접근 구분 — "이 프로젝트를 이 사람이 볼 수 있는가?"를 한 곳에서만
# 판단한다(목록·상세 조회·수정·삭제 전부 이 함수 하나를 재사용 — main.py). 관리자는
# 무조건 다 본다(문제 생겼을 때 들여다볼 수 있어야 함).
def _is_visible(p: dict[str, Any], viewer_email: str | None, viewer_department: str | None, is_admin: bool) -> bool:
    if is_admin:
        return True
    if p.get("visibility", "shared") == "private":
        return viewer_email is not None and p.get("ownerEmail") == viewer_email
    # 부서가 없는 로그인 사용자(DEPARTMENT_MAP/data/users.json에 없는 이메일)는
    # 공유 프로젝트를 하나도 못 본다 — "정의 안 된 사용자는 프로젝트 목록이 비어
    # 보여야 한다"는 요구사항(2026-08-25). 예전엔 department=None(공통) 프로젝트를
    # 로그인 여부와 무관하게 전부에게 보여줬는데, 그러면 부서 매핑을 깜빡 빠뜨린
    # 사람도 그냥 다 보이는 구멍이 생겨서 이렇게 바꿨다. is_admin=True(로그인 자체가
    # 꺼진 환경 포함)는 위에서 이미 걸러졌으니 이 아래는 항상 "로그인은 됐지만 부서가
    # 없는" 경우다.
    if viewer_department is None:
        return False
    department = p.get("department")
    if department is None:
        return True
    return viewer_department == department


def _to_detail(p: dict[str, Any]) -> dict[str, Any]:
    return deepcopy({k: v for k, v in p.items() if k != "history"})


def list_projects(
    viewer_email: str | None = None, viewer_department: str | None = None, is_admin: bool = True,
) -> list[dict[str, Any]]:
    """is_admin 기본값이 True인 이유: 로그인 기능 자체가 꺼진 환경(main.py의
    auth_is_configured()가 False — LOGIN_*이 .env에 없는 로컬 개발 클론 등)에서는
    호출부가 viewer 정보를 아예 안 넘기고 부르므로, 그럴 땐 예전처럼 전부 보여야
    한다. 로그인이 켜진 환경에서는 route 쪽이 항상 is_admin을 명시적으로 넘긴다.

    개인 폴더 스캔 범위: 관리자는 전체 개인 폴더를 다 훑는다(문제 생겼을 때
    들여다볼 수 있어야 함 — _is_visible과 같은 이유). 관리자가 아니면 본인 개인
    폴더만 훑는다 — 남의 개인 프로젝트는 파일이 존재한다는 사실조차 몰라야 한다."""
    ids: set[str] = set()
    try:
        ids.update(f.stem for f in PROJECTS_DIR.iterdir() if f.suffix == ".json")
    except OSError:
        pass
    if USERS_ROOT.exists():
        if is_admin:
            ids.update(f.stem for f in USERS_ROOT.glob("*/projects/*.json"))
        elif viewer_email:
            ids.update(f.stem for f in _personal_dir(viewer_email).glob("*.json"))

    projects = [p for p in (_read_project(pid) for pid in ids) if p is not None]

    # 2026-08-21 이전 프로젝트엔 order 필드가 없다 — 그 경우 하나라도 있으면 예전
    # 정렬 기준(최근 사용순)으로 한 번만 order를 매겨 파일에 자가 치유(self-heal)한다.
    # 그 이후로는 순서를 수동으로 옮기면(reorder_projects) 이 값만 바뀐다.
    # 자가 치유는 "이 사람이 볼 수 있는가"와 무관하게 전체 프로젝트 기준으로 해야
    # order 값이 일관된다 — 필터링은 그다음에 한다.
    if any("order" not in p for p in projects):
        projects.sort(key=lambda p: p["updatedAt"], reverse=True)
        for index, p in enumerate(projects):
            if p.get("order") != index:
                p["order"] = index
                _write_project(p)

    visible = [p for p in projects if _is_visible(p, viewer_email, viewer_department, is_admin)]
    summaries = [_to_summary(p) for p in visible]
    summaries.sort(key=lambda s: s["order"])
    return summaries


def reorder_projects(
    ordered_ids: list[str], viewer_email: str | None = None, viewer_department: str | None = None,
    is_admin: bool = True,
) -> list[dict[str, Any]]:
    """사이드바에서 위/아래로 옮긴 새 순서를 그대로 order에 반영한다.

    프론트가 이미 화면에 보이는(=이 사람이 볼 수 있는) 프로젝트 id를 새 순서대로
    보내주므로, 여기서는 각 프로젝트의 order를 그 배열 인덱스로 덮어쓰기만 한다 —
    두 개씩 스왑하는 것보다 간단하고, 나중에 드래그 앤 드롭으로 바꿔도 이 함수는
    그대로 재사용된다. viewer_*는 끝에 돌려주는 목록에만 쓴다(list_projects와
    동일 — 안 그러면 본인이 못 보는 프로젝트가 이 응답에 그대로 실려 나간다).
    """
    for index, project_id in enumerate(ordered_ids):
        p = _read_project(project_id)
        if p is None:
            continue
        if p.get("order") != index:
            p["order"] = index
            _write_project(p)
    return list_projects(viewer_email, viewer_department, is_admin)


# main.py가 상세 조회·수정·삭제 라우트에서 재사용 — list_projects의 _is_visible과
# 같은 기준을 프로젝트 하나에 대해서만 다시 물을 때 쓴다(목록엔 안 보였어도, ID를
# 직접 알면 상세 API로 우회 접근할 수 있던 걸 막기 위함).
def can_view(project: dict[str, Any], viewer_email: str | None, viewer_department: str | None, is_admin: bool) -> bool:
    return _is_visible(project, viewer_email, viewer_department, is_admin)


# 2026-08-25: "부서 5명이 같은 프로젝트를 동시에 고치면 서로 덮어쓴다" 문제 —
# 실시간 동시편집(구글독스류 병합) 대신 "소유자만 수정, 나머지는 읽기 전용"으로
# 간단히 막기로 함(사용자 결정). can_view는 "목록에 보이는가"(공유/부서/공통 전부
# 포함)이고, can_edit은 그중에서도 "고칠 수 있는가"(소유자 또는 관리자만)로 완전히
# 별개 기준이다 — main.py의 PATCH/DELETE 라우트가 can_view 통과 후 이것도 확인한다.
def can_edit(project: dict[str, Any], viewer_email: str | None, is_admin: bool) -> bool:
    if is_admin:
        return True
    return viewer_email is not None and project.get("ownerEmail") == viewer_email


def get_project(project_id: str) -> dict[str, Any] | None:
    p = _read_project(project_id)
    return _to_detail(p) if p else None


def create_project(
    name: str, tables: list[str] | None = None, *,
    owner_email: str | None = None, department: str | None = None, visibility: str = "shared",
) -> dict[str, Any]:
    project_id = str(uuid.uuid4())
    now = _now_iso()
    visibility = visibility if visibility in ("shared", "private") else "shared"
    # private인데 소유자 이메일이 없으면(로그인 꺼진 환경 등) 개인 폴더 자체를 못
    # 만든다 — 로그인 없는 환경엔 "개인"이라는 개념이 성립하지 않으므로 공유로 되돌린다.
    if visibility == "private" and not owner_email:
        visibility = "shared"
    p = {
        "id": project_id,
        "name": name.strip() or "제목 없는 프로젝트",
        "tables": deepcopy(tables) if tables else [],
        "instructions": _empty_instructions(),   # 새 프로젝트는 항상 빈 지침에서 시작
        "cells": [],
        "history": [],
        "createdAt": now,
        "updatedAt": now,
        "order": _count_all_projects(),   # 사이드바 맨 아래에 추가 — 위/아래 버튼으로 옮긴 순서만 이후 유지
        "ownerEmail": owner_email,
        "department": department,
        "visibility": visibility,
    }
    _write_project(p)
    log.info(
        "PROJECT",
        f'생성: "{p["name"]}" ({project_id}), 소유자: {owner_email or "(로그인 없음)"}, '
        f'{"개인 전용" if visibility == "private" else "공유"}',
    )
    return _to_detail(p)


def update_project(
    project_id: str, *, name: str | None = None, tables: list[str] | None = None,
    instructions: dict[str, Any] | None = None, cells: list[Any] | None = None,
) -> dict[str, Any] | None:
    """department/visibility는 일부러 여기 없다 — 만든 뒤엔 안 바뀐다(파일 상단
    docstring 참고, "개인 프로젝트를 나중에 공유로 넓힌다" 기능은 폐기됨)."""
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
# 절대 덮어쓰지 않으므로 서버를 몇 번을 재시작해도 안전하다(멱등). 이 마이그레이션은
# 개인 폴더 기능보다 훨씬 오래된 거라 공유 풀(PROJECTS_DIR)만 훑으면 충분하다 —
# 개인 폴더엔 애초에 이 구형 포맷의 파일이 존재할 수가 없다.
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
    path = _locate_file(project_id)
    if path is None:
        return False
    try:
        path.unlink()
        log.info("PROJECT", f"삭제: {project_id}")
        return True
    except OSError:
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
