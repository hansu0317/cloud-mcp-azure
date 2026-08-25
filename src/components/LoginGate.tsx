import { useEffect } from 'react'
import { APP_NAME } from '../constants'

// 로그인 안 된 상태에서 앱 전체(Header/Sidebar/Notebook 등) 대신 뜨는 화면 —
// /api/*가 전부 401을 주므로 애초에 그 컴포넌트들을 마운트하지 않는다(마운트하면
// 빈 상태로 깜빡이거나 에러 토스트가 뜨는 걸 막기 위함).
//
// 2026-08-25: "로그인 화면을 없애달라" 요청 — 실제로는 로그인 자체(LOGIN_* env)를
// 끄면 부서별 접근 제어까지 같이 무의미해지는 걸 확인해서(전원이 관리자 취급),
// 대신 이 화면이 "눌러야 하는 카드"로 남아있는 것 자체를 없앴다: 마운트되자마자
// 곧바로 /auth/login으로 이동한다(자동, 클릭 불필요). 브라우저에 이미 사내 Microsoft
// 세션이 있으면 이 카드는 사실상 안 보이고 바로 앱으로 넘어간다(SSO 통과가 그만큼
// 빠르게 끝나서). 세션이 없는 사람만 실제 Microsoft 로그인 화면을 보게 된다 —
// 그건 이 앱이 대신할 수 없는 지점이라 여기서 없앨 방법은 없다.
// 로그인 자체가 실패해서 돌아온 경우(loginError=1)만 자동 재시도 루프를 막기 위해
// 카드를 보여주고 수동으로 다시 누르게 한다.
export default function LoginGate() {
  const params = new URLSearchParams(window.location.search)
  const hadError = params.get('loginError') === '1'

  useEffect(() => {
    if (!hadError) window.location.href = '/auth/login'
  }, [hadError])

  if (!hadError) return null   // 리다이렉트가 바로 나가므로 빈 화면으로 둔다(깜빡임 최소화)

  return (
    <div className="login-gate">
      <div className="login-gate-card">
        <div className="login-gate-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">{APP_NAME}</span>
        </div>
        <div className="login-gate-sub">사내 계정으로 로그인해야 사용할 수 있습니다</div>
        <div className="login-gate-error">로그인에 실패했습니다 — 다시 시도해주세요</div>
        <button type="button" className="btn primary login-gate-btn" onClick={() => { window.location.href = '/auth/login' }}>
          <svg className="ms-logo" width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1"  y="1"  width="9" height="9" fill="#F25022" />
            <rect x="11" y="1"  width="9" height="9" fill="#7FBA00" />
            <rect x="1"  y="11" width="9" height="9" fill="#00A4EF" />
            <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
          </svg>
          Microsoft 계정으로 로그인
        </button>
      </div>
    </div>
  )
}
