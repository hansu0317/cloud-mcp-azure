import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TimingEntry } from '../types'

interface Props {
  entries: TimingEntry[]
  onClear: () => void
  onClose: () => void
}

function avg(list: TimingEntry[]): number | null {
  if (list.length === 0) return null
  return list.reduce((s, e) => s + e.elapsedMs, 0) / list.length
}

export default function TimingModal({ entries, onClear, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const codeEntries = entries.filter(e => e.engine === 'cli')
  const apiEntries  = entries.filter(e => e.engine === 'api')
  const codeAvg     = avg(codeEntries)
  const apiAvg      = avg(apiEntries)
  const sorted      = [...entries].sort((a, b) => b.time.localeCompare(a.time))

  return createPortal(
    <div className="log-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="log-modal-inner">
        <div className="log-modal-hdr">
          <span>⏱ 속도 비교 기록 — 질문 전송 ~ 답변 완료 표시까지</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn btn-xs danger" onClick={onClear} title="기록 전체 삭제">지우기</button>
            <button className="btn btn-xs danger" onClick={onClose} title="닫기">✕</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, padding: '12px 14px', borderBottom: '1px solid #1e2533', flexShrink: 0 }}>
          <div style={{ flex: 1, background: 'rgba(67,56,202,.15)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 700 }}>⌨ CLI 평균</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0' }}>
              {codeAvg != null ? `${(codeAvg / 1000).toFixed(1)}초` : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{codeEntries.length}건</div>
          </div>
          <div style={{ flex: 1, background: 'rgba(14,116,144,.15)', borderRadius: 8, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: '#22d3ee', fontWeight: 700 }}>⚡ API 평균</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0' }}>
              {apiAvg != null ? `${(apiAvg / 1000).toFixed(1)}초` : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{apiEntries.length}건</div>
          </div>
          {codeAvg != null && apiAvg != null && (
            <div style={{ flex: 1, background: 'rgba(34,197,94,.12)', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>API가 더 빠름</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0' }}>
                {codeAvg > apiAvg ? `${(codeAvg / apiAvg).toFixed(1)}배` : '—'}
              </div>
            </div>
          )}
        </div>

        <div className="log-modal-body">
          {sorted.length === 0 ? (
            <div className="sb-empty">아직 기록이 없습니다. 셀을 실행하면 여기 쌓입니다.</div>
          ) : (
            sorted.map((e, i) => (
              <div className="log-entry" key={i}>
                <span className="log-time">{e.time.replace('T', ' ').slice(0, 19)}</span>
                <span
                  className="log-level"
                  style={{ color: e.engine === 'api' ? '#22d3ee' : '#a5b4fc' }}
                >
                  {e.engine === 'api' ? '⚡API' : '⌨CLI'}
                </span>
                <span className="log-cat" style={{ color: e.error ? '#f87171' : '#4ade80' }}>
                  {(e.elapsedMs / 1000).toFixed(1)}초{e.error ? ' (오류)' : ''}
                </span>
                <span className="log-msg">{e.question.slice(0, 80)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
