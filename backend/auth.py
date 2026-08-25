"""Microsoft Entra ID(옛 Azure AD) 로그인 — 인증 코드 흐름(MSAL).

DATAVERSE_* 앱 등록(서버가 스스로 Dataverse에 접근, client_credentials)과는 완전히
별개인 LOGIN_* 앱 등록(사람이 로그인, authorization code)을 쓴다 — 이유는 .env 주석
참고. 세션은 DB 없이 메모리 dict에 둔다(이 앱의 다른 상태 — chat_api.py의
_history_map — 와 같은 패턴, 서버 재시작하면 로그아웃되는 건 감수).

SSO: authorize URL에 prompt를 아예 안 실어 보낸다 — 그래야 브라우저에 이미 Office
365/Teams/Azure Portal 세션이 있으면 Microsoft가 알아서 비밀번호 입력 없이 통과시켜
준다(2026-08-25 피드백 — "이미 로그인된 사람은 그냥 넘어가게" 요구 그대로).
"""
from __future__ import annotations

import os
import secrets
import time
from typing import Any

import msal
from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

from .logger import log
from .sse import HttpStatus

LOGIN_TENANT_ID     = os.environ.get("LOGIN_TENANT_ID", "").strip()
LOGIN_CLIENT_ID     = os.environ.get("LOGIN_CLIENT_ID", "").strip()
LOGIN_CLIENT_SECRET = os.environ.get("LOGIN_CLIENT_SECRET", "").strip()
LOGIN_REDIRECT_URI  = os.environ.get("LOGIN_REDIRECT_URI", "").strip()
# secure=False가 기본인 이유: 사내망에서 http로 먼저 붙이는 경우가 흔해서(로컬 개발도
# 포함) — 실제 https 뒤에 배포하면 .env에서 COOKIE_SECURE=true로 켜야 한다(안 켜면
# 쿠키가 암호화 안 된 채로 오갈 수 있어 운영에선 반드시 켜야 함).
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}
_ADMIN_EMAILS = {
    e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()
}

COOKIE_NAME = "crm_session"
SESSION_TTL_SECONDS = 8 * 60 * 60          # 근무시간 기준 8시간
_STATE_TTL_SECONDS = 10 * 60               # 로그인 도중(리다이렉트 왕복) 넉넉히 10분
GRAPH_SCOPES = ["User.Read"]

# {session_id: {email, name, isAdmin, expiresAt}} / {state: issuedAt} — 둘 다 순수 메모리.
_sessions: dict[str, dict[str, Any]] = {}
_pending_states: dict[str, float] = {}


def is_configured() -> bool:
    return bool(LOGIN_TENANT_ID and LOGIN_CLIENT_ID and LOGIN_CLIENT_SECRET and LOGIN_REDIRECT_URI)


def _msal_app() -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        LOGIN_CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{LOGIN_TENANT_ID}",
        client_credential=LOGIN_CLIENT_SECRET,
    )


def _purge_expired(now: float) -> None:
    for sid, s in list(_sessions.items()):
        if s["expiresAt"] < now:
            _sessions.pop(sid, None)
    for state, issued_at in list(_pending_states.items()):
        if now - issued_at > _STATE_TTL_SECONDS:
            _pending_states.pop(state, None)


def get_session(request: Request) -> dict[str, Any] | None:
    session_id = request.cookies.get(COOKIE_NAME)
    if not session_id:
        return None
    session = _sessions.get(session_id)
    if session is None or session["expiresAt"] < time.time():
        return None
    return session


def register_auth_routes(app: Any) -> None:
    @app.get("/auth/login")
    async def auth_login():
        if not is_configured():
            return JSONResponse(
                {"error": "로그인이 설정되지 않았습니다 (.env의 LOGIN_* 값을 확인하세요)."},
                status_code=HttpStatus.SERVICE_UNAVAILABLE,
            )
        now = time.time()
        _purge_expired(now)
        state = secrets.token_urlsafe(24)
        _pending_states[state] = now
        # prompt를 일부러 안 넘긴다 — 브라우저에 이미 MS 세션이 있으면 Microsoft가
        # 자동으로 SSO 처리한다(비밀번호 재입력 없이 통과). prompt=login/select_account
        # 등을 넣으면 이 자동 통과가 깨진다.
        auth_url = _msal_app().get_authorization_request_url(
            GRAPH_SCOPES, state=state, redirect_uri=LOGIN_REDIRECT_URI,
        )
        return RedirectResponse(auth_url)

    @app.get("/auth/callback")
    async def auth_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
        if error:
            log.error("AUTH", f"Microsoft 로그인 실패: {error}", {})
            return RedirectResponse("/?loginError=1")
        now = time.time()
        _purge_expired(now)
        if not code or not state or _pending_states.pop(state, None) is None:
            log.error("AUTH", "콜백에 code/state가 없거나 state가 유효하지 않음(위조·재사용 시도 가능성)", {})
            return RedirectResponse("/?loginError=1")

        result = _msal_app().acquire_token_by_authorization_code(
            code, scopes=GRAPH_SCOPES, redirect_uri=LOGIN_REDIRECT_URI,
        )
        if "error" in result:
            log.error("AUTH", f"토큰 교환 실패: {result.get('error')} {result.get('error_description', '')[:200]}", {})
            return RedirectResponse("/?loginError=1")

        claims = result.get("id_token_claims") or {}
        email = str(claims.get("preferred_username") or claims.get("email") or "").strip()
        name = str(claims.get("name") or email).strip()
        if not email:
            log.error("AUTH", "id_token에 이메일/UPN이 없음", {})
            return RedirectResponse("/?loginError=1")

        session_id = secrets.token_urlsafe(32)
        _sessions[session_id] = {
            "email": email,
            "name": name,
            "isAdmin": email.lower() in _ADMIN_EMAILS,
            "expiresAt": now + SESSION_TTL_SECONDS,
        }
        log.info("AUTH", f"로그인 성공: {name} ({email})", {})
        response = RedirectResponse("/")
        response.set_cookie(
            COOKIE_NAME, session_id, max_age=SESSION_TTL_SECONDS,
            httponly=True, samesite="lax", secure=COOKIE_SECURE, path="/",
        )
        return response

    @app.get("/auth/me")
    async def auth_me(request: Request):
        # LOGIN_*이 .env에 없는 환경(로컬 개발 클론 등)에서는 로그인 자체를 요구하지
        # 않는다(main.py의 LoginSessionMiddleware와 같은 기준) — 프론트가 이 신호로
        # 로그인 화면을 아예 안 띄우게 한다. loginRequired 없이 그냥 401만 주면,
        # 미들웨어는 안 막는데 화면만 로그인 화면에 갇히는 불일치가 생긴다.
        if not is_configured():
            return {"loginRequired": False}
        session = get_session(request)
        if session is None:
            return JSONResponse(
                {"loginRequired": True, "error": "로그인이 필요합니다."}, status_code=HttpStatus.UNAUTHORIZED,
            )
        return {"loginRequired": True, "email": session["email"], "name": session["name"], "isAdmin": session["isAdmin"]}

    @app.post("/auth/logout")
    async def auth_logout(request: Request):
        session_id = request.cookies.get(COOKIE_NAME)
        if session_id:
            _sessions.pop(session_id, None)
        response = JSONResponse({"ok": True})
        response.delete_cookie(COOKIE_NAME, path="/")
        return response
