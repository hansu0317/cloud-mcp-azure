"""로그인한 사람의 부서를 알아내는 부분 — 지금은 수동 매핑, 나중엔 Entra ID 그룹.

Databricks Genie도 "로그인 시 부서 자동 감지" 같은 건 없고, 관리자가 미리 스페이스를
팀별 폴더에 넣거나 특정 사용자/그룹에 직접 공유해두는 방식이다(2026-08-25 조사).
그래서 지금은 제일 간단한 "이메일 → 부서" 수동 매핑으로 시작한다 — Azure 관리자
동의(admin consent)를 추가로 안 받아도 되고, ADMIN_EMAILS랑 똑같은 패턴이라 바로
쓸 수 있다.

★ 나중에 Entra ID 그룹으로 옮기는 방법: get_department() 함수 안쪽만 바꾸면 된다 —
지금은 DEPARTMENT_MAP을 찾아보지만, 나중엔 여기서 Microsoft Graph
(GET /me/memberOf, User.Read 로는 부족하고 GroupMember.Read.All 델리게이트 권한을
추가로 관리자 동의받아야 함)를 호출해서 그룹 ID → 부서명으로 바꾸면 된다. 이 함수를
호출하는 쪽(auth.py의 로그인 콜백)은 "이메일 넣으면 부서 문자열이나 None이 나온다"는
계약만 알지 내부 구현은 몰라도 되게 짜여 있어서, 호출부는 그대로 두고 이 파일
하나만 고치면 된다.
"""
from __future__ import annotations

import os

# 형식: "이메일1:부서1,이메일2:부서1,이메일3:부서2" — 공백은 앞뒤로 있어도 무시한다.
# 이메일이 여기 없으면 부서 미상(None) — department가 None인 프로젝트는 전사 공유로
# 취급되므로(projects.py), 부서를 아직 안 채운 사람도 접근 자체가 막히진 않는다.
def _parse_department_map(raw: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        email, _, department = entry.partition(":")
        email = email.strip().lower()
        department = department.strip()
        if email and department:
            result[email] = department
    return result


_DEPARTMENT_MAP = _parse_department_map(os.environ.get("DEPARTMENT_MAP", ""))


def get_department(email: str) -> str | None:
    return _DEPARTMENT_MAP.get(email.strip().lower())
