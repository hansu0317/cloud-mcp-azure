import { useState, useRef, useEffect, useCallback } from 'react'
import { SIDEBAR_MIN_W, SIDEBAR_MAX_W, API, CONN_NAME } from '../constants'
import TableScopeModal from './TableScopeModal'
import type { ProjectSummary } from '../types'

interface TableItem    { name: string; label: string }
interface CatalogGroup { domain: string; tables: TableItem[] }

interface Props {
  collapsed: boolean

  projects:        ProjectSummary[]
  activeProjectId: string | null
  onSwitchProject: (id: string) => void
  onCreateProject: (name: string) => Promise<ProjectSummary>
  onRenameProject: (id: string, name: string) => void
  onDeleteProject: (id: string) => void
  onSelectTables:  (projectId: string, tables: string[]) => void   // 프로젝트별 테이블 스코프 변경
}

// 프로젝트 목록 — 테이블 스코프는 목록에 항상 펼쳐 두지 않고, Databricks Genie의
// "Connect your data" 팝업처럼 별도 모달에서 고른다. 새 프로젝트를 만들면 곧바로
// 그 모달이 뜨고, 이후에는 각 행의 "＋ 테이블" 버튼으로 언제든 다시 열어 추가/해제한다.
export default function Sidebar({
  collapsed, projects, activeProjectId,
  onSwitchProject, onCreateProject, onRenameProject, onDeleteProject, onSelectTables,
}: Props) {
  const [catalog,     setCatalog]     = useState<CatalogGroup[]>([])
  const [refreshing,  setRefreshing]  = useState(false)
  const [refreshMsg,  setRefreshMsg]  = useState<string | null>(null)

  const [newName,        setNewName]        = useState('')
  const [renamingId,     setRenamingId]      = useState<string | null>(null)
  const [renameVal,      setRenameVal]       = useState('')
  const [editingProject, setEditingProject]  = useState<ProjectSummary | null>(null)   // 테이블 선택 모달 대상

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

  const submitCreate = async () => {
    const name = newName.trim()
    if (!name) return
    setNewName('')
    const created = await onCreateProject(name)
    setEditingProject(created)   // 만들자마자 테이블 선택 팝업으로 이어간다
  }

  const startRename = (p: ProjectSummary) => { setRenamingId(p.id); setRenameVal(p.name) }
  const submitRename = () => {
    if (renamingId && renameVal.trim()) onRenameProject(renamingId, renameVal.trim())
    setRenamingId(null)
  }
  const handleDelete = (p: ProjectSummary) => {
    if (window.confirm(`"${p.name}" 프로젝트를 삭제할까요?\n노트북 기록과 대화 내용이 모두 사라지며 되돌릴 수 없습니다.`)) {
      onDeleteProject(p.id)
    }
  }

  return (
    <>
      <div className={`sidebar${collapsed ? ' collapsed' : ''}`} ref={sbRef}>
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

          <div className="proj-new-row">
            <input
              className="proj-new-input"
              placeholder="+ 새 프로젝트 이름"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitCreate() }}
            />
            <button className="btn btn-sm primary" onClick={submitCreate} disabled={!newName.trim()}>추가</button>
          </div>

          {projects.length === 0 && <div className="sb-empty">프로젝트가 없습니다</div>}

          {projects.map(p => (
            <div className={`proj-row${p.id === activeProjectId ? ' active' : ''}`} key={p.id}>
              {renamingId === p.id ? (
                <input
                  className="proj-rename-input"
                  value={renameVal}
                  autoFocus
                  onChange={e => setRenameVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null) }}
                  onBlur={submitRename}
                />
              ) : (
                <div className="proj-row-main" onClick={() => onSwitchProject(p.id)}>
                  <span className="proj-icon">📁</span>
                  <span className="proj-name">{p.name}</span>
                  <button
                    className="proj-table-badge clickable"
                    title="테이블 선택 열기"
                    onClick={e => { e.stopPropagation(); setEditingProject(p) }}
                  >
                    {p.tables.length > 0 ? `${p.tables.length}개` : '전체'}
                  </button>
                </div>
              )}
              <div className="proj-acts">
                <button className="btn-xs proj-act-btn" title="테이블 추가/변경" onClick={() => setEditingProject(p)}>＋</button>
                <button className="btn-xs proj-act-btn" title="이름 변경" onClick={() => startRename(p)}>✎</button>
                <button className="btn-xs proj-act-btn danger" title="삭제" onClick={() => handleDelete(p)}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sb-resizer" ref={resizerRef} />

      {editingProject && (
        <TableScopeModal
          projectName={editingProject.name}
          catalog={catalog}
          initialTables={editingProject.tables}
          onClose={() => setEditingProject(null)}
          onConfirm={tables => { onSelectTables(editingProject.id, tables); setEditingProject(null) }}
        />
      )}
    </>
  )
}
