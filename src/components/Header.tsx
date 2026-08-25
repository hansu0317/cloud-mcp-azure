import type { RefObject } from 'react'
import type { NotebookHandle } from '../types'
import { APP_NAME } from '../constants'

interface Props {
  activeProjectName:    string
  onOpenProjects:       () => void
  onToggleSidebar:      () => void
  sidebarOpen:          boolean
  onToggleInstructions: () => void
  instructionsOpen:     boolean
  notebookRef:          RefObject<NotebookHandle | null>
  authUser:             { email: string; name: string; isAdmin: boolean } | null
  onSwitchAccount:      () => void
}

export default function Header({
  activeProjectName, onOpenProjects, onToggleSidebar, sidebarOpen, onToggleInstructions, instructionsOpen, notebookRef,
  authUser, onSwitchAccount,
}: Props) {
  return (
    <header>
      <div className="logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">{APP_NAME}</span>
      </div>
      <div className="h-div" />
      <button
        className={`btn proj-indicator${sidebarOpen ? ' active' : ''}`}
        onClick={onOpenProjects}
        title="프로젝트 목록 열기/닫기 · 전환 · 새로 만들기"
      >
        📁 {activeProjectName || '프로젝트 불러오는 중…'}
      </button>
      <div className="h-div" />
      <div className="nb-only">
        <button className="btn" onClick={() => notebookRef.current?.addCell()}>＋ 셀 추가</button>
      </div>
      <div className="h-spacer" />
      <button
        className={`btn${instructionsOpen ? ' active' : ''}`}
        onClick={onToggleInstructions}
        title="지침 패널 열기/닫기 (조인 관계·용어·예시)"
      >
        🔗 지침
      </button>
      <button className={`btn${sidebarOpen ? ' active' : ''}`} onClick={onToggleSidebar} title="사이드바 토글">≡</button>
      {authUser && (
        <>
          <div className="h-div" />
          <span className="header-user" title={authUser.email}>
            {authUser.isAdmin && <span className="header-user-admin">관리자</span>}
            {authUser.name}
          </span>
          {/* "로그아웃" 대신 "계정 전환"인 이유: 진짜 Microsoft 로그아웃은 같은
              브라우저의 Outlook/Teams 등 다른 회사 M365 웹앱까지 같이 로그아웃시켜버린다
              (AAD single sign-out 표준 동작 — 이 앱만 빼고 로그아웃시킬 방법이 없다).
              그래서 우리 세션만 지우고 Microsoft 계정 선택 화면을 강제로 띄워서, 다른
              계정으로 바로 들어갈 수 있게만 한다(2026-08-25, backend/auth.py 참고). */}
          <button className="btn btn-sm" onClick={onSwitchAccount} title="다른 Microsoft 계정으로 전환">계정 전환</button>
        </>
      )}
    </header>
  )
}
