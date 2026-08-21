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
}

export default function Header({
  activeProjectName, onOpenProjects, onToggleSidebar, sidebarOpen, onToggleInstructions, instructionsOpen, notebookRef,
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
        <button className="btn primary" onClick={() => notebookRef.current?.runAll()}>▶ Run All</button>
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
    </header>
  )
}
