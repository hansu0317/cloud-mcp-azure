import type { RefObject } from 'react'
import type { NotebookHandle } from '../types'
import { APP_NAME } from '../constants'

interface Props {
  onNewSession:    () => void
  onToggleSidebar: () => void
  notebookRef:     RefObject<NotebookHandle | null>
}

export default function Header({ onNewSession, onToggleSidebar, notebookRef }: Props) {
  return (
    <header>
      <div className="logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">{APP_NAME}</span>
      </div>
      <div className="h-div" />
      <div className="nb-only">
        <button className="btn primary" onClick={() => notebookRef.current?.runAll()}>▶ Run All</button>
        <button className="btn" onClick={() => notebookRef.current?.addCell()}>＋ 셀 추가</button>
      </div>
      <div className="h-spacer" />
      <button className="btn" onClick={onToggleSidebar} title="사이드바 토글">≡</button>
      <button className="btn" onClick={onNewSession}>↺ 새 세션</button>
    </header>
  )
}
