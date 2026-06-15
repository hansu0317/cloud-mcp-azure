import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { API, LOG_REFRESH_MS, LOG_MAX_ENTRIES, LOG_DATA_PREVIEW } from '../constants'
import type { LogEntry } from '../types'

type FilterKey = 'all' | 'chat' | 'tool' | 'error'

const FILTERS: Record<FilterKey, (e: LogEntry) => boolean> = {
  all:   () => true,
  chat:  (e) => ['CHAT', 'CLAUDE'].includes(e.category),
  tool:  (e) => e.level === 'tool' || e.category === 'SECURITY',
  error: (e) => e.level === 'error',
}

const FILTER_LABELS: Record<FilterKey, string> = {
  all: '전체', chat: '채팅', tool: 'MCP', error: '오류',
}

export default function LogModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [filter,  setFilter]  = useState<FilterKey>('all')

  const fetchLogs = useCallback(async () => {
    try {
      const data = await fetch(`${API.LOGS}?n=${LOG_MAX_ENTRIES}`).then(r => r.json()) as LogEntry[]
      setEntries(Array.isArray(data) ? data : [])
    } catch {
      setEntries([])
    }
  }, [])

  useEffect(() => {
    fetchLogs()
    const timer = setInterval(fetchLogs, LOG_REFRESH_MS)
    return () => clearInterval(timer)
  }, [fetchLogs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = entries.filter(FILTERS[filter])

  return createPortal(
    <div className="log-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="log-modal-inner">
        <div className="log-modal-hdr">
          <span>서버 로그</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {(Object.keys(FILTER_LABELS) as FilterKey[]).map(f => (
              <button key={f} className={`log-filter-btn${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
                {FILTER_LABELS[f]}
              </button>
            ))}
            <button className="btn btn-xs" onClick={fetchLogs} title="새로고침">↻</button>
            <button className="btn btn-xs danger" onClick={onClose} title="닫기">✕</button>
          </div>
        </div>

        <div className="log-modal-body">
          {filtered.length === 0 ? (
            <div className="sb-empty">로그가 없습니다</div>
          ) : (
            filtered.map((e, i) => {
              const t = (e.time || '').replace('T', ' ').slice(0, 19)
              let d = ''
              if (e.data) {
                if (e.data.question)          d = `Q: ${String(e.data.question).slice(0, LOG_DATA_PREVIEW)}`
                else if (e.data.answerPreview) d = `A: ${String(e.data.answerPreview).slice(0, LOG_DATA_PREVIEW)}`
                else if (e.data.tool)          d = `🔧 ${String(e.data.tool)}`
                else d = JSON.stringify(e.data).slice(0, 100)
              }
              return (
                <div className="log-entry" key={i}>
                  <span className="log-time">{t}</span>
                  <span className={`log-level ${e.level}`}>{e.level.toUpperCase()}</span>
                  <span className="log-cat">{e.category}</span>
                  <span className="log-msg">{e.message}</span>
                  {d && <span className="log-data">{d}</span>}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
