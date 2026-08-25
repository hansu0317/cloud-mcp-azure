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
  readOnly?:    boolean   // 내 소유가 아닌 공유/부서 프로젝트를 볼 때 — 실행·삭제·수정 다 막는다
}

export default function NotebookCell({ cell, onRun, onDelete, onTextChange, onExport, readOnly = false }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // 읽기전용 셀은 자동 포커스도 안 준다 — 편집 가능한 것처럼 커서가 깜빡이면 오해를 준다.
    if (taRef.current && !readOnly) {
      autoResize(taRef.current)
      taRef.current.focus()
    }
  }, [readOnly])

  const autoResize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, CELL_TA_MAX_H) + 'px'
  }

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!readOnly && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); onRun() }
  }

  // 내용이 있는 셀(질문을 썼거나 답변을 받은 셀)만 확인창을 띄운다 — 방금 추가한
  // 빈 셀을 바로 지울 땐 매번 물어보면 번거로우니 그 경우엔 바로 지운다.
  const handleDeleteClick = () => {
    const hasContent = cell.text.trim().length > 0 || cell.output !== null
    if (!hasContent || window.confirm('이 셀을 삭제할까요?\n질문과 답변 내용이 사라지며 되돌릴 수 없습니다.')) {
      onDelete()
    }
  }

  const { output } = cell
  const isRunning  = output?.loading
  const hasError   = output?.error

  return (
    <div className={`cell${isRunning ? ' running' : ''}${hasError ? ' has-error' : ''}`} id={`nb-cell-${cell.id}`}>
      <div className="cell-hdr">
        <span className="badge ai">AI</span>
        <span className="exec-num">
          {isRunning ? 'In [*]:' : output?.execN ? `In [${output.execN}]:` : 'In [ ]:'}
        </span>
        <span className="cell-preview">{cell.text.slice(0, 70)}</span>
        {output?.elapsedMs != null && !isRunning && (
          <span
            title="응답 소요시간"
            style={{
              marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
              background: 'rgba(14,116,144,.22)', color: '#22d3ee', whiteSpace: 'nowrap',
            }}
          >
            ⏱ {(output.elapsedMs / 1000).toFixed(1)}초
          </span>
        )}
        <div className="cell-acts">
          {output?.rawContent && (
            <button className="btn btn-sm" onClick={onExport} title="내보내기">↓</button>
          )}
          {!readOnly && (
            <>
              <button className="btn btn-sm" onClick={onRun} disabled={isRunning}>
                {isRunning ? '⏳' : '▶ 실행'}
              </button>
              <button className="btn btn-sm danger" onClick={handleDeleteClick}>×</button>
            </>
          )}
        </div>
      </div>

      <div className="cell-in ai">
        <textarea
          ref={taRef}
          className="cell-ta"
          value={cell.text}
          onChange={e => { if (!readOnly) { onTextChange(e.target.value); autoResize(e.target) } }}
          onKeyDown={handleKey}
          placeholder="자연어로 질문하세요 (예: 고객 TOP 5 보여줘)"
          rows={2}
          readOnly={readOnly}
        />
      </div>

      {output && (
        <div className="cell-out" id={`nb-out-${cell.id}`}>
          <div className="out-inner">
            {isRunning && !output.content && !output.toolName && (
              <div className="running-row">
                <div className="spinner" />
                <span>AI 분석 중...</span>
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
