import type { RefObject } from 'react'
import type { NotebookHandle } from '../types'
import type { LlmMode } from '../constants'
import { APP_NAME } from '../constants'

interface Props {
  onNewSession:    () => void
  onToggleSidebar: () => void
  notebookRef:     RefObject<NotebookHandle | null>
  llmMode:         LlmMode
  onToggleLlm:     () => void
}

export default function Header({ onNewSession, onToggleSidebar, notebookRef, llmMode, onToggleLlm }: Props) {
  return (
    <header>
      <div className="logo">
        <span className="logo-icon">◈</span>
        <span className="logo-text">{APP_NAME}</span>
      </div>
      <div className="h-div" />
      <div className="nb-only">
        <button className="btn primary" onClick={() => notebookRef.current?.runAll()}>▶ Run All</button>
        <button className="btn" onClick={() => notebookRef.current?.addCell('ai')}>＋ AI 셀</button>
        <button className="btn" onClick={() => notebookRef.current?.addCell('sql')}>＋ SQL 셀</button>
      </div>
      <div className="h-spacer" />
      <button
        className={`btn llm-toggle ${llmMode === 'groq' ? 'llm-groq' : 'llm-claude'}`}
        onClick={onToggleLlm}
        title={llmMode === 'groq' ? 'Groq (빠름) — 클릭하면 Claude로 전환' : 'Claude MCP — 클릭하면 Groq로 전환'}
      >
        {llmMode === 'groq' ? '⚡ Groq' : '◆ Claude'}
      </button>
      <button className="btn" onClick={onToggleSidebar} title="사이드바 토글">≡</button>
      <button className="btn" onClick={onNewSession}>↺ 새 세션</button>
    </header>
  )
}
