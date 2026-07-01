import type { RefObject } from 'react'
import type { NotebookHandle, CellEngine } from '../types'
import { APP_NAME } from '../constants'

interface Props {
  engine:          CellEngine
  onEngineChange:  (engine: CellEngine) => void
  onNewSession:    () => void
  onToggleSidebar: () => void
  onShowTiming:    () => void
  notebookRef:     RefObject<NotebookHandle | null>
}

export default function Header({ engine, onEngineChange, onNewSession, onToggleSidebar, onShowTiming, notebookRef }: Props) {
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
        <button
          className="btn"
          onClick={() => onEngineChange(engine === 'cli' ? 'api' : 'cli')}
          title="실행 모드 전환 (CLI: Claude Code CLI / API: Claude API). 각 모드는 셀·대화가 독립됩니다."
          style={{ background: engine === 'api' ? '#0e7490' : '#4338ca', color: '#fff', fontWeight: 700 }}
        >
          {engine === 'api' ? '⚡ API 모드' : '⌨ CLI 모드'}
        </button>
        <button className="btn" onClick={onShowTiming} title="Code/API 속도 비교 기록 보기">⏱ 속도기록</button>
      </div>
      <div className="h-spacer" />
      <button className="btn" onClick={onToggleSidebar} title="사이드바 토글">≡</button>
      <button className="btn" onClick={onNewSession}>↺ 새 세션</button>
    </header>
  )
}
