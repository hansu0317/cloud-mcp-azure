import type { RefObject } from 'react'
import type { NotebookHandle } from '../types'
import { APP_NAME } from '../constants'

interface Props {
  activeProjectName:  string
  onOpenProjects:     () => void
  onToggleSidebar:    () => void
  onOpenInstructions: () => void
  notebookRef:        RefObject<NotebookHandle | null>
}

export default function Header({ activeProjectName, onOpenProjects, onToggleSidebar, onOpenInstructions, notebookRef }: Props) {
  return (
    <header>
      <div className="logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">{APP_NAME}</span>
      </div>
      <div className="h-div" />
      <button className="btn proj-indicator" onClick={onOpenProjects} title="프로젝트 전환 · 새로 만들기">
        📁 {activeProjectName || '프로젝트 불러오는 중…'}
      </button>
      <div className="h-div" />
      <div className="nb-only">
        <button className="btn primary" onClick={() => notebookRef.current?.runAll()}>▶ Run All</button>
        <button className="btn" onClick={() => notebookRef.current?.addCell()}>＋ 셀 추가</button>
      </div>
      <div className="h-spacer" />
      {/* 2026-08-14: 지침 버튼을 웹 UI에서만 숨김. InstructionsModal과 백엔드
          (chat_api.py/instructions_draft.py/projects.py) 로직은 그대로 둔다 —
          이미 저장된 프로젝트 지침이 있으면 서버가 계속 system prompt에 반영한다. */}
      <button className="btn" onClick={onToggleSidebar} title="사이드바 토글">≡</button>
    </header>
  )
}
