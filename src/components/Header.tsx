import type { RefObject } from 'react'
import type { NotebookHandle } from '../types'
import { APP_NAME } from '../constants'
import UsagePanel from './UsagePanel'

interface Props {
  activeProjectId:      string | null
  activeProjectName:    string
  onOpenProjects:       () => void
  onToggleSidebar:      () => void
  sidebarOpen:          boolean
  onToggleInstructions: () => void
  instructionsOpen:     boolean
  notebookRef:          RefObject<NotebookHandle | null>
  authUser:             { email: string; name: string; isAdmin: boolean } | null
  onLogout:             () => void
}

export default function Header({
  activeProjectId, activeProjectName, onOpenProjects, onToggleSidebar, sidebarOpen, onToggleInstructions, instructionsOpen, notebookRef,
  authUser, onLogout,
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
      {/* 2026-08-25: 로그인이 켜진 환경에서는 사용량(토큰·비용)을 관리자만 보게 한다
          — "관리자/일반 구분"을 실제로 만들면서 나온 결론(사용량 자체가 민감한 건
          아니지만, 역할 구분이 생겼으니 그 안에 자연스럽게 넣는 게 맞다는 판단).
          로그인이 아예 안 켜진 환경(authUser=null)에서는 예전처럼 그냥 보여준다. */}
      {(!authUser || authUser.isAdmin) && <UsagePanel projectId={activeProjectId} />}
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
          <button className="btn btn-sm" onClick={onLogout} title="로그아웃">로그아웃</button>
        </>
      )}
    </header>
  )
}
