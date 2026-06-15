import { useState, useRef, useEffect, useCallback } from 'react'
import { SIDEBAR_MIN_W, SIDEBAR_MAX_W, API, CONN_NAME } from '../constants'

interface TableItem    { name: string; label: string }
interface CatalogGroup { domain: string; tables: TableItem[] }

interface Props {
  collapsed: boolean
}

export default function Sidebar({ collapsed }: Props) {
  const [catalog,     setCatalog]     = useState<CatalogGroup[]>([])
  const [openGroups,  setOpenGroups]  = useState<Record<string, boolean>>({})
  const [refreshing,  setRefreshing]  = useState(false)
  const [refreshMsg,  setRefreshMsg]  = useState<string | null>(null)

  const sbRef      = useRef<HTMLDivElement>(null)
  const resizerRef = useRef<HTMLDivElement>(null)

  const loadTables = useCallback(() => {
    fetch(API.TABLES)
      .then(r => r.json())
      .then(({ tables }: { tables: { name: string; label: string; domain: string }[] }) => {
        const groupMap = new Map<string, TableItem[]>()
        for (const t of tables) {
          const list = groupMap.get(t.domain) ?? []
          list.push({ name: t.name, label: t.label })
          groupMap.set(t.domain, list)
        }
        setCatalog([...groupMap.entries()].map(([domain, ts]) => ({ domain, tables: ts })))
      })
      .catch(() => {/* 무시 */})
  }, [])

  useEffect(() => { loadTables() }, [loadTables])

  const handleRefresh = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const res  = await fetch(API.SCHEMA_REFRESH, { method: 'POST' })
      const data = await res.json() as { updated: number; tables: string[] }
      setRefreshMsg(`✓ ${data.updated}개 테이블 갱신 완료`)
      loadTables()
    } catch {
      setRefreshMsg('갱신 실패. 다시 시도하세요.')
    } finally {
      setRefreshing(false)
      setTimeout(() => setRefreshMsg(null), 3000)
    }
  }

  useEffect(() => {
    const resizer = resizerRef.current
    const sb      = sbRef.current
    if (!resizer || !sb) return

    let sx = 0, sw = 0
    const onMove = (e: MouseEvent) => {
      sb.style.width = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, sw + e.clientX - sx)) + 'px'
    }
    const onUp = () => {
      resizer.classList.remove('active')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
    const onDown = (e: MouseEvent) => {
      sx = e.clientX
      sw = sb.offsetWidth
      resizer.classList.add('active')
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup',   onUp)
    }
    resizer.addEventListener('mousedown', onDown)
    return () => resizer.removeEventListener('mousedown', onDown)
  }, [])

  const toggleGroup = (domain: string) => {
    setOpenGroups(prev => ({ ...prev, [domain]: !prev[domain] }))
  }

  return (
    <>
      <div className={`sidebar${collapsed ? ' collapsed' : ''}`} ref={sbRef}>
        <div className="sb-tabs">
          <button className="sb-tab active">카탈로그</button>
        </div>

        <div className="sb-body">
          <div className="cat-conn">
            <div className="cat-conn-row" style={{ cursor: 'default' }}>
              <span className="cat-conn-icon">☁️</span>
              <span className="cat-conn-name">{CONN_NAME}</span>
              <span className="cat-conn-status connected" title="connected" />
            </div>
          </div>

          <div style={{ padding: '6px 10px' }}>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{
                width: '100%', padding: '5px 8px', fontSize: '11px',
                background: refreshing ? 'var(--bg-3)' : 'var(--accent)',
                color: '#fff', border: 'none', borderRadius: '4px',
                cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.7 : 1,
              }}
            >
              {refreshing ? '⟳ 갱신 중…' : '↻ 스키마 갱신'}
            </button>
            {refreshMsg && (
              <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center' }}>
                {refreshMsg}
              </div>
            )}
          </div>

          {catalog.length === 0 && !refreshing && (
            <div style={{ padding: '12px 16px', color: 'var(--text-muted)', fontSize: '12px' }}>
              테이블 없음 — 스키마 갱신을 실행하세요
            </div>
          )}
          {catalog.map(g => (
            <div className="cat-conn" key={g.domain}>
              <div className="cat-conn-row" onClick={() => toggleGroup(g.domain)}>
                <span className={`cat-conn-chev${openGroups[g.domain] ? ' open' : ''}`}>▶</span>
                <span className="cat-conn-name">{g.domain}</span>
              </div>
              {openGroups[g.domain] && (
                <div>
                  {g.tables.map(t => (
                    <div className="cat-table-row" key={t.name}>
                      <span className="cat-table-icon">⊞</span>
                      <span className="cat-table-name" title={t.name}>{t.label}</span>
                      <span className="cat-table-cnt">{t.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="sb-resizer" ref={resizerRef} />
    </>
  )
}
