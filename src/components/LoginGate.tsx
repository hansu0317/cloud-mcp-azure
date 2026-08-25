import { APP_NAME } from '../constants'

// 로그인 안 된 상태에서 앱 전체(Header/Sidebar/Notebook 등) 대신 뜨는 화면 —
// /api/*가 전부 401을 주므로 애초에 그 컴포넌트들을 마운트하지 않는다(마운트하면
// 빈 상태로 깜빡이거나 에러 토스트가 뜨는 걸 막기 위함). 버튼을 누르면 백엔드
// /auth/login으로 실제 브라우저 이동(fetch 아님) — Microsoft 로그인 페이지로 가야
// 하는 흐름이라 페이지 자체가 넘어가야 한다.
export default function LoginGate() {
  const params = new URLSearchParams(window.location.search)
  const hadError = params.get('loginError') === '1'

  return (
    <div className="login-gate">
      <div className="login-gate-card">
        <div className="login-gate-logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">{APP_NAME}</span>
        </div>
        <div className="login-gate-sub">사내 계정으로 로그인해야 사용할 수 있습니다</div>
        {hadError && (
          <div className="login-gate-error">로그인에 실패했습니다 — 다시 시도해주세요</div>
        )}
        <button type="button" className="btn primary login-gate-btn" onClick={() => { window.location.href = '/auth/login' }}>
          Microsoft 계정으로 로그인
        </button>
      </div>
    </div>
  )
}
