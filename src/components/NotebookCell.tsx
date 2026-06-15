import { useRef, useEffect } from 'react'
import { renderMd } from '../api'
import { CELL_TA_MAX_H } from '../constants'
import type { Cell } from '../types'
import QueryPanel from './QueryPanel'

interface Props {
  cell:         Cell
  onRun:        () => void
  onDelete:     () => void
  onTextChange: (text: string) => void
  onExport:     () => void
}

export default function NotebookCell({ cell, onRun, onDelete, onTextChange, onExport }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (taRef.current) {
      autoResize(taRef.current)
      taRef.current.focus()
    }
  }, [])

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, CELL_TA_MAX_H) + 'px'
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); onRun() }
    if (e.key === 'Tab' && cell.type === 'sql') {
      e.preventDefault()
      const ta = e.currentTarget
      const s  = ta.selectionStart
      const newText = cell.text.slice(0, s) + '  ' + cell.text.slice(ta.selectionEnd)
      onTextChange(newText)
      setTimeout(() => { ta.selectionStart = ta.selectionEnd = s + 2 }, 0)
    }
  }

  const { output } = cell
  const isRunning  = output?.loading
  const hasError   = output?.error

  return (
    <div className={`cell${isRunning ? ' running' : ''}${hasError ? ' has-error' : ''}`} id={`nb-cell-${cell.id}`}>
      <div className="cell-hdr">
        <span className={`badge ${cell.type}`}>{cell.type === 'ai' ? 'AI' : 'SQL'}</span>
        <span className="exec-num">
          {isRunning ? 'In [*]:' : output?.execN ? `In [${output.execN}]:` : 'In [ ]:'}
        </span>
        <span className="cell-preview">{cell.text.slice(0, 70)}</span>
        <div className="cell-acts">
          {output?.rawContent && (
            <button className="btn btn-sm" onClick={onExport} title="내보내기">↓</button>
          )}
          {cell.type === 'sql' ? (
            <button className="btn btn-sm" disabled title="DB 커넥션 연결 후 사용 가능">🚧 준비 중</button>
          ) : (
            <button className="btn btn-sm" onClick={onRun} disabled={isRunning}>
              {isRunning ? '⏳' : '▶ 실행'}
            </button>
          )}
          <button className="btn btn-sm danger" onClick={onDelete}>×</button>
        </div>
      </div>

      <div className={`cell-in ${cell.type}`}>
        <textarea
          ref={taRef}
          className="cell-ta"
          value={cell.text}
          onChange={e => { onTextChange(e.target.value); autoResize(e.target) }}
          onKeyDown={handleKey}
          placeholder={
            cell.type === 'ai'
              ? '자연어로 질문하세요 (예: 고객 TOP 5 보여줘)'
              : 'SELECT * FROM table_name LIMIT 10\n-- ⚠️ DB 커넥션 연결 후 실행 가능'
          }
          rows={2}
        />
      </div>

      {output && (
        <div className="cell-out" id={`nb-out-${cell.id}`}>
          <div className="out-inner">
            {isRunning && !output.content && !output.toolName && (
              <div className="running-row">
                <div className="spinner" />
                <span>{cell.type === 'ai' ? 'AI 분석 중...' : 'SQL 실행 중...'}</span>
              </div>
            )}
            {output.toolName && !output.content && (
              <div className="running-row">
                <div className="spinner" />
                <span style={{ color: '#475569' }}>🔍 {output.toolName} 조회 중...</span>
              </div>
            )}
            {output.content && !hasError && (
              <div className="out-answer" dangerouslySetInnerHTML={{ __html: renderMd(output.content) }} />
            )}
            {hasError && <div className="out-error">{output.content}</div>}
            {output.queries && output.queries.length > 0 && !output.loading && (
              <QueryPanel queries={output.queries} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
