"""로그인 허용 명단·관리자 여부 — data/users.json 파일.

v1(2026-08-25): 부서 개념은 v2-department-access-control 브랜치로 보류했다 —
이 파일에 남은 건 "이 이메일이 로그인해도 되는가"(is_known)와 "이 이메일이
사용자 관리 화면을 볼 수 있는가"(is_admin) 두 가지뿐이다. 매 조회마다 파일을
새로 읽으므로(캐시 없음) 관리 화면에서 바꾼 게 재시작 없이 바로 반영된다 — 이
앱의 다른 모듈(store/projects.py 등)과 같은 "동기 파일 I/O, 캐시 없음" 패턴.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

_USERS_FILE = Path.cwd() / "data" / "users.json"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# 비상용 관리자 지정(break-glass, 2026-08-25): data/users.json이 실수로 비거나
# 깨지면 아무도 관리자가 아니게 되고, 관리 화면 자체가 관리자만 볼 수 있어서 그
# 화면으로 되돌릴 방법도 없어진다(닭이 먼저냐 달걀이 먼저냐 문제). 그래서 .env의
# ADMIN_EMAILS는 완전히 없애지 않고, JSON에 적힌 관리자 목록과 "합집합"으로 남겨둔다
# — 평소엔 관리 화면만 쓰면 되고, JSON이 망가졌을 때만 이 줄이 복구 수단이 된다.
_BREAK_GLASS_ADMINS = {
    e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()
}


def _read_users() -> list[dict[str, Any]]:
    try:
        raw = json.loads(_USERS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    result = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("email"), str):
            continue
        result.append({
            "email": item["email"].strip().lower(),
            "isAdmin": bool(item.get("isAdmin", False)),
        })
    return result


def _write_users(users: list[dict[str, Any]]) -> None:
    """같은 디렉터리의 임시 파일을 fsync한 뒤 원자적으로 교체한다(store/projects.py의
    write 패턴과 동일) — 관리 화면에서 여러 요청이 겹쳐도 파일이 반쯤 쓰인 상태로
    깨지지 않는다."""
    _USERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=_USERS_FILE.parent, prefix=".users.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(users, f, ensure_ascii=False, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, _USERS_FILE)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def list_users() -> list[dict[str, Any]]:
    return _read_users()


# 2026-08-25(임시): data/users.json에 없는 사람은 로그인 자체를 막는다 —
# auth/__init__.py의 auth_callback이 이걸로 세션 발급 전에 거른다. "임시"인 이유:
# 지금은 회사 전체가 아니라 소수만 시험 중이라 화이트리스트가 맞지만, 인원이
# 늘면 이 게이트를 완화할 수도 있음 — 그때 판단.
def is_known(email: str) -> bool:
    email = email.strip().lower()
    # break-glass 관리자도 "알려진 사람"으로 쳐야 한다 — 안 그러면 data/users.json이
    # 깨졌을 때 그 파일을 고치러 들어와야 할 사람조차 로그인을 못 하는 모순이 생긴다.
    if email in _BREAK_GLASS_ADMINS:
        return True
    return any(u["email"] == email for u in _read_users())


def is_admin(email: str) -> bool:
    email = email.strip().lower()
    if email in _BREAK_GLASS_ADMINS:
        return True
    for u in _read_users():
        if u["email"] == email:
            return u["isAdmin"]
    return False


def upsert_user(email: str, is_admin_flag: bool) -> dict[str, Any]:
    """이메일이 이미 있으면 덮어쓰고, 없으면 새로 추가한다. 잘못된 이메일 형식이면
    ValueError — main.py 라우트가 이걸 잡아 400으로 바꾼다."""
    email = email.strip().lower()
    if not _EMAIL_RE.fullmatch(email):
        raise ValueError(f"이메일 형식이 아닙니다: {email!r}")
    users = _read_users()
    entry = {"email": email, "isAdmin": bool(is_admin_flag)}
    for i, u in enumerate(users):
        if u["email"] == email:
            users[i] = entry
            break
    else:
        users.append(entry)
    _write_users(users)
    return entry


def remove_user(email: str) -> bool:
    email = email.strip().lower()
    users = _read_users()
    kept = [u for u in users if u["email"] != email]
    if len(kept) == len(users):
        return False
    _write_users(kept)
    return True
