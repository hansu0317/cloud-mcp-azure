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
  onReorderProjects: (orderedIds: string[]) => void                // ▲▼로 만든 새 전체 순서
  // 2026-08-25: 공유/부서 프로젝트는 소유자만 수정 가능 — 나머지는 읽기 전용
  // (App.tsx의 canEditProject 참고, 실제 방어선은 서버). 순서 바꾸기(▲▼·드래그)는
  // 그냥 내 화면 정렬 취향에 가까워서 예외로 누구나 허용한다.
  canEditProject:  (p: ProjectSummary) => boolean
}

// 프로젝트 목록 — 테이블 스코프는 목록에 항상 펼쳐 두지 않고, Databricks Genie의
// "Connect your data" 팝업처럼 별도 모달에서 고른다. 새 프로젝트를 만들면 곧바로
// 그 모달이 뜨고, 이후에는 각 행의 "＋ 테이블" 버튼으로 언제든 다시 열어 추가/해제한다.
//
// 2026-08-25: "관리자가 만든 프로젝트"와 "개인 프로젝트"를 화면에서도 확실히 나눠
// 보여달라는 요구 — visibility로 두 섹션으로 갈라서 렌더링한다(어느 쪽으로
// 만들어지는지는 서버가 관리자 여부로 자동 결정하므로 여기엔 고르는 UI가 없다,
// App.tsx/main.py 참고). 순서(▲▼·드래그)는 각 섹션 안에서만 움직인다 — 서로 다른
// 섹션끼리 순서를 뒤섞을 이유가 없다.
export default function Sidebar({
  collapsed, projects, activeProjectId,
  onSwitchProject, onCreateProject, onRenameProject, onDeleteProject, onSelectTables, onReorderProjects,
  canEditProject,
}: Props) {
  const [catalog,     setCatalog]     = useState<CatalogGroup[]>([])
  const [refreshing,  setRefreshing]  = useState(false)
  const [refreshMsg,  setRefreshMsg]  = useState<string | null>(null)

  const [newName,        setNewName]        = useState('')
  const [renamingId,     setRenamingId]      = useState<string | null>(null)
  const [renameVal,      setRenameVal]       = useState('')
  const [editingProject, setEditingProject]  = useState<ProjectSummary | null>(null)   // 테이블 선택 모달 대상
  const [search,         setSearch]          = useState('')
  const [dragId,         setDragId]          = useState<string | null>(null)
  const [dragOverId,     setDragOverId]      = useState<string | null>(null)

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

  const query = search.trim().toLowerCase()
  const matchesQuery = (p: ProjectSummary) => !query || p.name.toLowerCase().includes(query)

  // 관리자가 만든(공유) 프로젝트 vs 개인 전용 — 섹션을 완전히 나눈다.
  const sharedAll  = projects.filter(p => p.visibility !== 'private')
  const personalAll = projects.filter(p => p.visibility === 'private')
  const sharedVisible   = sharedAll.filter(matchesQuery)
  const personalVisible = personalAll.filter(matchesQuery)

  // ▲▼·드래그는 검색으로 걸러진 목록이 아니라 그 섹션의 전체 목록(예: sharedAll) 기준
  // 으로 이웃과 자리를 바꾼다 — 검색 중엔 안 보이는 프로젝트가 사이에 끼어있을 수
  // 있어서, 화면에 보이는 이웃과 바꾸면 순서가 뒤죽박죽될 수 있다(검색 중엔 버튼을
  // 아예 숨긴다 — 아래 렌더링 참고). 서로 다른 섹션끼리는 순서를 안 섞는다.
  const moveProjectIn = (group: ProjectSummary[], id: string, delta: -1 | 1) => {
    const index = group.findIndex(p => p.id === id)
    const swapWith = index + delta
    if (index < 0 || swapWith < 0 || swapWith >= group.length) return
    const ids = group.map(p => p.id)
    ;[ids[index], ids[swapWith]] = [ids[swapWith], ids[index]]
    onReorderProjects(ids)
  }

  const handleDropIn = (group: ProjectSummary[], targetId: string) => {
    const from = dragId
    setDragId(null)
    setDragOverId(null)
    if (!from || from === targetId) return
    if (!group.some(p => p.id === from)) return   // 다른 섹션으로의 드래그는 무시
    const ids = group.map(p => p.id)
    const fromIndex = ids.indexOf(from)
    const toIndex = ids.indexOf(targetId)
    if (fromIndex < 0 || toIndex < 0) return
    ids.splice(fromIndex, 1)
    ids.splice(toIndex, 0, from)
    onReorderProjects(ids)
  }

  const renderRow = (p: ProjectSummary, group: ProjectSummary[]) => {
    const fullIndex = group.findIndex(pr => pr.id === p.id)
    const editable  = canEditProject(p)
    return (
      <div
        className={`proj-row${p.id === activeProjectId ? ' active' : ''}${dragOverId === p.id ? ' drag-over' : ''}`}
        key={p.id}
        draggable={!query}
        onDragStart={e => { setDragId(p.id); e.dataTransfer.effectAllowed = 'move' }}
        onDragOver={e => { if (!query && dragId) { e.preventDefault(); if (dragOverId !== p.id) setDragOverId(p.id) } }}
        onDragLeave={() => setDragOverId(prev => (prev === p.id ? null : prev))}
        onDrop={e => { e.preventDefault(); handleDropIn(group, p.id) }}
        onDragEnd={() => { setDragId(null); setDragOverId(null) }}
      >
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
            {!query && <span className="proj-drag-handle" title="드래그해서 순서 바꾸기">⠿</span>}
            <span className="proj-icon">📁</span>
            <span className="proj-name">{p.name}</span>
            {/* 2026-08-25: 소유자가 아니면 읽기 전용 — 다른 부서원이 동시에 고쳐서
                서로 덮어쓰는 걸 막으려고 "실시간 동시편집" 대신 이 쪽으로 갔다. */}
            {!editable && <span className="proj-readonly-badge" title="읽기 전용 — 소유자만 수정할 수 있습니다">👁</span>}
            {editable ? (
              <button
                className="proj-table-badge clickable"
                title={p.tables.length > 0 ? '테이블 선택 열기' : '테이블 미선택 — 등록된 전체 테이블 조회 가능. 클릭해서 범위 지정'}
                onClick={e => { e.stopPropagation(); setEditingProject(p) }}
              >
                {p.tables.length}개
              </button>
            ) : (
              <span className="proj-table-badge" title="테이블 스코프(읽기 전용)">{p.tables.length}개</span>
            )}
          </div>
        )}
        <div className="proj-acts">
          {!query && (
            <>
              <button
                className="btn-xs proj-act-btn" title="위로 이동"
                onClick={() => moveProjectIn(group, p.id, -1)} disabled={fullIndex <= 0}
              >
                ▲
              </button>
              <button
                className="btn-xs proj-act-btn" title="아래로 이동"
                onClick={() => moveProjectIn(group, p.id, 1)} disabled={fullIndex >= group.length - 1}
              >
                ▼
              </button>
            </>
          )}
          {editable && (
            <>
              <button className="btn-xs proj-act-btn" title="테이블 추가/변경" onClick={() => setEditingProject(p)}>＋</button>
              <button className="btn-xs proj-act-btn" title="이름 변경" onClick={() => startRename(p)}>✎</button>
              <button className="btn-xs proj-act-btn danger" title="삭제" onClick={() => handleDelete(p)}>🗑</button>
            </>
          )}
        </div>
      </div>
    )
  }

  // .body의 자식으로 항상 "요소 하나"만 내놓는다(Fragment로 여러 개를 흘리지 않음) —
  // 예전엔 <>.sidebar, .sb-resizer, (조건부)TableScopeModal</> 세 조각을 Fragment로
  // 반환했는데, React가 .body의 다음 형제(키가 바뀌는 NotebookView/InstructionsPanel)를
  // 리마운트 대신 계속 추가만 하고 이전 걸 정리 안 하는 문제가 있었다(재현: 프로젝트를
  // 전환할 때마다 .notebook-view가 쌓임). TableScopeModal은 createPortal이라 어디에
  // 두든 실제 DOM 위치엔 영향 없으므로, 이 wrapper 안에 그냥 같이 넣어서 Sidebar가
  // .body 입장에서 형제 노드 하나로만 보이게 만든다.
  return (
    <div className="sidebar-group">
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
          {projects.length > 3 && (
            <div className="proj-search-row">
              <input
                className="proj-new-input"
                placeholder="🔍 프로젝트 검색…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          )}

          {projects.length === 0 && <div className="sb-empty">프로젝트가 없습니다</div>}

          {/* 관리자 프로젝트 섹션 — 없으면 검색 중이 아닐 때만 헤더를 보여준다
              (검색 중에 텅 빈 섹션 헤더가 계속 남아있으면 "일치하는 게 없다"는
              느낌이 덜 온다). */}
          {(sharedAll.length > 0 || !query) && (
            <div className="proj-section-hdr">관리자 프로젝트{sharedAll.length > 0 && <span className="proj-section-count">{sharedAll.length}</span>}</div>
          )}
          {sharedAll.length > 0 && sharedVisible.length === 0 && query && (
            <div className="sb-empty sb-empty-sm">일치하는 프로젝트가 없습니다</div>
          )}
          {sharedVisible.map(p => renderRow(p, sharedAll))}

          {/* 개인 프로젝트 섹션 — 새로 만든 프로젝트(관리자가 아니면 전부 여기로
              간다, App.tsx/main.py 참고)가 여기 쌓인다. */}
          {(personalAll.length > 0 || !query) && (
            <div className="proj-section-hdr">개인 프로젝트{personalAll.length > 0 && <span className="proj-section-count">{personalAll.length}</span>}</div>
          )}
          {personalAll.length === 0 && !query && (
            <div className="sb-empty sb-empty-sm">아직 없습니다 — 위에서 새 프로젝트를 만들어보세요</div>
          )}
          {personalAll.length > 0 && personalVisible.length === 0 && query && (
            <div className="sb-empty sb-empty-sm">일치하는 프로젝트가 없습니다</div>
          )}
          {personalVisible.map(p => renderRow(p, personalAll))}
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
    </div>
  )
}
