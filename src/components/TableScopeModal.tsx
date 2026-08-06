import { useState, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'

interface TableItem    { name: string; label: string }
interface CatalogGroup { domain: string; tables: TableItem[] }

interface Props {
  projectName:   string
  catalog:       CatalogGroup[]
  initialTables: string[]
  onConfirm:     (tables: string[]) => void
  onClose:       () => void
}

// Databricks Genie의 "Connect your data" 팝업과 같은 자리 — 프로젝트 생성 직후,
// 또는 프로젝트 목록의 "＋ 테이블" 버튼으로 언제든 다시 띄워서 스코프를 고친다.
// 확인을 눌러야만 반영되고(취소하면 변경 무시), 검색으로 36개 테이블 중 원하는 것만 빠르게 찾는다.
export default function TableScopeModal({ projectName, catalog, initialTables, onConfirm, onClose }: Props) {
  const [selected, setSelected] = useState<string[]>(initialTables)
  const [query,    setQuery]    = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const g of catalog) {
      if (g.tables.some(t => initialTables.includes(t.name))) init[g.domain] = true
    }
    return init
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog
      .map(g => ({ domain: g.domain, tables: g.tables.filter(t => t.name.toLowerCase().includes(q) || t.label.toLowerCase().includes(q)) }))
      .filter(g => g.tables.length > 0)
  }, [catalog, query])

  const toggleTable = (name: string) => {
    setSelected(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])
  }
  const toggleGroup = (domain: string) => setOpenGroups(prev => ({ ...prev, [domain]: !prev[domain] }))
  const toggleGroupAll = (g: CatalogGroup) => {
    const names  = g.tables.map(t => t.name)
    const allSel = names.every(n => selected.includes(n))
    setSelected(prev => allSel ? prev.filter(n => !names.includes(n)) : [...new Set([...prev, ...names])])
  }

  return createPortal(
    <div className="ts-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ts-modal-inner">
        <div className="ts-modal-hdr">
          <div>
            <div className="ts-modal-title">테이블 선택</div>
            <div className="ts-modal-sub">"{projectName}" 프로젝트가 조회할 테이블을 고르세요</div>
          </div>
          <button className="btn btn-xs" onClick={onClose}>✕</button>
        </div>

        <div className="ts-modal-search">
          <input
            className="ts-search-input"
            placeholder="테이블 이름 검색…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
          <span className="ts-selected-count">
            {selected.length > 0 ? `${selected.length}개 선택됨` : '전체(미선택 — 모든 테이블 조회 가능)'}
          </span>
        </div>

        <div className="ts-modal-body">
          {filtered.length === 0 && <div className="sb-empty">일치하는 테이블이 없습니다</div>}
          {filtered.map(g => {
            const names        = g.tables.map(t => t.name)
            const allSelected   = names.every(n => selected.includes(n))
            const someSelected  = !allSelected && names.some(n => selected.includes(n))
            const isOpen        = Boolean(query.trim()) || !!openGroups[g.domain]
            return (
              <div key={g.domain}>
                <div className="cat-conn-row">
                  <span className={`cat-conn-chev${isOpen ? ' open' : ''}`} onClick={() => toggleGroup(g.domain)}>▶</span>
                  <span className="cat-conn-name" onClick={() => toggleGroup(g.domain)}>{g.domain}</span>
                  <button
                    className={`group-select-btn${someSelected ? ' partial' : ''}`}
                    title="그룹 전체 선택/해제"
                    onClick={() => toggleGroupAll(g)}
                  >
                    {allSelected ? '✓' : someSelected ? '–' : '전체'}
                  </button>
                </div>
                {isOpen && (
                  <div>
                    {g.tables.map(t => (
                      <label className="cat-table-row nested" key={t.name}>
                        <input
                          type="checkbox"
                          className="cat-table-check"
                          checked={selected.includes(t.name)}
                          onChange={() => toggleTable(t.name)}
                        />
                        <span className="cat-table-icon">⊞</span>
                        <span className="cat-table-name" title={t.name}>{t.label}</span>
                        <span className="cat-table-cnt">{t.name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="ts-modal-ftr">
          <button className="scope-clear" onClick={() => setSelected([])}>전체 해제</button>
          <div className="h-spacer" />
          <button className="btn" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={() => onConfirm(selected)}>저장</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
