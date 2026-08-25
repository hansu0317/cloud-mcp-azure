import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NOISE_COLUMN_RE, LOOKUP_TYPES, joinKey as joinKeyOf } from '../lib/schemaColumns'
import type { JoinDef } from '../types'

interface ColumnInfo { name: string; type: string; desc: string; options?: string[] }

interface Props {
  projectName:     string
  projectTables:   string[]
  joins:           JoinDef[]
  joinCandidates:  JoinDef[]
  columnsByTable:  Record<string, ColumnInfo[]>
  tableLabel:      (name: string) => string
  onAddJoin:       (join: JoinDef) => void
  onDeleteJoin:    (join: JoinDef) => void
  onSaveJoinLabel: (join: JoinDef, label: string) => void
  onClose:         () => void
  onSave:          () => void
  saving:          boolean
}

interface Rect { x: number; y: number; w: number; h: number }
interface DragColumn { table: string; column: string }

const rowKey = (table: string, column: string) => `${table}::${column}`
// HTML5 드래그의 dataTransfer는 문자열/커스텀 MIME만 나르므로, "테이블을 캔버스로
// 끌어옴"(배치)과 "컬럼을 다른 테이블로 끌어옴"(연결)을 서로 다른 타입으로 구분한다.
const DND_TABLE  = 'application/x-rdiag-table'
const DND_COLUMN = 'application/x-rdiag-column'

// 3분할 레이아웃: 왼쪽(이 프로젝트 테이블 목록, 드래그 소스) · 가운데(캔버스, 항상
// 최대 두 테이블만) · 오른쪽(캔버스에 놓인 테이블들의 관계 상세 — 설명도 여기서 단다).
// 2026-08-24 두 차례 개편 — ①처음엔 테이블을 몇 개든 자유 배치했는데 3~5개만 놓아도
// 선이 서로 꼬여 "그래프가 이상하다"는 피드백 → ②드롭다운으로 정확히 두 테이블만
// 고르게 바꿨는데, 이번엔 "왼쪽엔 원래 테이블 목록이 있어야 하고, 드래그로 옮겨서
// 연결하는 방식은 유지하되 두 개까지만, 오른쪽엔 관계 상세(설명 포함)를 보여달라"는
// 피드백 → 지금 이 버전. 캔버스에 세 번째 테이블을 놓으면 제일 먼저 놓인 걸 밀어내
// 자동 교체한다(막다른 골목 없이 항상 최대 2개 유지).
//
// 자기참조(fromTable === toTable)는 상자 안에 "↻" 뱃지로, 후보도 같은 자리에 초록
// "＋" 뱃지로 보여준다 — 그래야 캔버스에 테이블 하나만 놓아도 그 테이블의 자기참조
// 관계(예: "이전 계약")를 바로 보고 추가할 수 있다.
export default function RelationshipDiagram({
  projectName, projectTables, joins, joinCandidates, columnsByTable, tableLabel,
  onAddJoin, onDeleteJoin, onSaveJoinLabel, onClose, onSave, saving,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const rowRefs   = useRef<Map<string, HTMLDivElement>>(new Map())
  const [rects, setRects] = useState<Record<string, Rect>>({})
  const [dragging, setDragging] = useState<DragColumn | null>(null)
  const [dragOverTable, setDragOverTable] = useState<string | null>(null)

  const [placedTables, setPlacedTables] = useState<string[]>(() =>
    [...new Set(joins.flatMap(j => [j.fromTable, j.toTable]))].slice(0, 2),
  )
  const placeTable = (table: string) => {
    setPlacedTables(prev => {
      if (prev.includes(table)) return prev
      if (prev.length < 2) return [...prev, table]
      return [prev[1], table]   // 이미 2개면 제일 오래된 걸 밀어내고 새로 온 걸 넣는다
    })
  }
  const unplaceTable = (table: string) => setPlacedTables(prev => prev.filter(t => t !== table))

  const [expandedInPalette, setExpandedInPalette] = useState<Set<string>>(new Set())
  const togglePaletteExpand = (table: string) =>
    setExpandedInPalette(prev => {
      const next = new Set(prev)
      if (next.has(table)) next.delete(table); else next.add(table)
      return next
    })

  // 상자 안엔 그 테이블의 전체 컬럼이 아니라 "실제로 다른 테이블을 가리킬 수 있는
  // 컬럼"(Lookup/Owner/Customer)만 나열한다. 시스템 감사·소유권 컬럼(NOISE_COLUMN_RE,
  // InstructionsPanel 용어 탭과 같은 기준)은 값은 Lookup이어도 systemuser/team 같은
  // Dataverse 플랫폼 엔터티를 가리킬 뿐 업무 관계가 아니라서 걸러낸다.
  const lookupColumnsOf = (table: string): string[] =>
    (columnsByTable[table] ?? [])
      .filter(c => LOOKUP_TYPES.has(c.type) && !NOISE_COLUMN_RE.test(c.name))
      .map(c => c.name)

  // 지금 캔버스에 놓인 테이블(들)과 "관련된" 조인/후보만 — 자기참조(상자 하나로도
  // 성립)와 두 테이블 사이 교차 조인(둘 다 놓여야 성립) 둘 다 포함한다.
  const relatedJoins = useMemo(
    () => joins.filter(j => placedTables.includes(j.fromTable) && placedTables.includes(j.toTable)),
    [joins, placedTables],
  )
  const relatedCandidates = useMemo(
    () => joinCandidates.filter(c =>
      placedTables.includes(c.fromTable) && placedTables.includes(c.toTable)
      && !relatedJoins.some(j => joinKeyOf(j) === joinKeyOf(c)),
    ),
    [joinCandidates, placedTables, relatedJoins],
  )
  const isPairComplete = placedTables.length === 2
  const crossJoins      = isPairComplete ? relatedJoins.filter(j => j.fromTable !== j.toTable) : []
  const crossCandidates = isPairComplete ? relatedCandidates.filter(c => c.fromTable !== c.toTable) : []
  const selfJoinsOf      = (table: string) => relatedJoins.filter(j => j.fromTable === table && j.toTable === table)
  const selfCandidatesOf = (table: string) => relatedCandidates.filter(c => c.fromTable === table && c.toTable === table)

  const columnsForBox = (table: string): string[] => {
    const names = new Set(lookupColumnsOf(table))
    for (const j of [...relatedJoins, ...relatedCandidates]) {
      if (j.fromTable === table) names.add(j.fromCol)
      if (j.toTable === table) names.add(j.toCol)
    }
    return [...names]
  }

  // PK/대상 컬럼은 자기 자신이 다른 테이블을 가리키는 게 아니라 "다른 테이블이
  // 여길 가리킬 때 선이 닿는 자리"일 뿐이라, ①"대상" 뱃지를 붙여 다른 종류라는 걸
  // 표시하고 ②드래그 시작점으로는 못 쓰게 한다.
  const isOwnLookupColumn = (table: string, col: string): boolean => lookupColumnsOf(table).includes(col)

  const usedColumnKeys = useMemo(() => {
    const s = new Set<string>()
    for (const j of relatedJoins) { s.add(rowKey(j.fromTable, j.fromCol)); s.add(rowKey(j.toTable, j.toCol)) }
    return s
  }, [relatedJoins])
  const candidateColumnKeys = useMemo(() => {
    const s = new Set<string>()
    for (const j of relatedCandidates) { s.add(rowKey(j.fromTable, j.fromCol)); s.add(rowKey(j.toTable, j.toCol)) }
    return s
  }, [relatedCandidates])

  // 컬럼 raw name(new_l_q1 등)만 보면 실무자가 아니면 뭘 가리키는지 알기 어려워서,
  // describe 캐시의 한국어 설명(desc)을 찾아 라벨로 같이 보여준다.
  const columnLabel = (table: string, col: string): string => {
    const info = (columnsByTable[table] ?? []).find(c => c.name === col)
    if (!info?.desc) return col
    return info.desc.split(' — ')[0].replace(/\s*\(.*\)\s*$/, '').trim() || col
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const recomputeRects = () => {
    const stage = stageRef.current
    if (!stage) return
    const stageBox = stage.getBoundingClientRect()
    const next: Record<string, Rect> = {}
    for (const [key, el] of rowRefs.current) {
      const b = el.getBoundingClientRect()
      next[key] = { x: b.left - stageBox.left, y: b.top - stageBox.top, w: b.width, h: b.height }
    }
    setRects(next)
  }
  // 상자가 최대 2개뿐이라 예전처럼 화면에 맞춰 축소하는 로직이 필요 없다 — 안 맞으면
  // 세로 스크롤(.rdiag-stage, overflow:auto)로 충분하다.
  useLayoutEffect(() => {
    recomputeRects()
    window.addEventListener('resize', recomputeRects)
    return () => window.removeEventListener('resize', recomputeRects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedTables.join(','), joins.length, joinCandidates.length, columnsByTable])

  // 왼쪽 팔레트 → 캔버스: 테이블 배치
  const handlePaletteDragStart = (e: React.DragEvent, table: string) => {
    e.dataTransfer.setData(DND_TABLE, table)
    e.dataTransfer.effectAllowed = 'copy'
  }
  const handleStageDrop = (e: React.DragEvent) => {
    const table = e.dataTransfer.getData(DND_TABLE)
    if (table) placeTable(table)
  }

  // 캔버스 상자 안 컬럼 → 다른 상자: 연결 생성
  const handleColumnDragStart = (e: React.DragEvent, table: string, column: string) => {
    e.stopPropagation()
    e.dataTransfer.setData(DND_COLUMN, JSON.stringify({ table, column }))
    e.dataTransfer.effectAllowed = 'link'
    setDragging({ table, column })
  }
  const handleNodeDrop = (e: React.DragEvent, targetTable: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverTable(null)
    const raw = e.dataTransfer.getData(DND_COLUMN)
    if (!raw) { handleStageDrop(e); return }   // 팔레트에서 상자 위로 바로 끌어다 놔도 배치는 되게
    const from = JSON.parse(raw) as DragColumn
    onAddJoin({ fromTable: from.table, fromCol: from.column, toTable: targetTable, toCol: `${targetTable}id`, label: '' })
    setDragging(null)
  }

  const renderBox = (table: string) => {
    const cols = columnsForBox(table)
    const isDropTarget = dragOverTable === table
    return (
      <div
        className={`rdiag-node${isDropTarget ? ' rdiag-node-target' : ''}`}
        key={table}
        onDragOver={e => { e.preventDefault(); if (dragging) setDragOverTable(table) }}
        onDragLeave={() => setDragOverTable(prev => (prev === table ? null : prev))}
        onDrop={e => handleNodeDrop(e, table)}
      >
        <div className="rdiag-node-hdr">
          {tableLabel(table)}
          <button type="button" className="rdiag-node-remove" title="캔버스에서 빼기" onClick={() => unplaceTable(table)}>✕</button>
        </div>
        <div className="rdiag-node-name">{table}</div>
        {selfJoinsOf(table).map((j, i) => (
          <div className="rdiag-node-self" key={`self-${i}`} title="같은 테이블을 가리키는 자기참조 조인">
            <span>↻ {j.fromCol} → {j.toCol}</span>
            <button type="button" className="rdiag-node-self-del" title="이 연결 삭제" onClick={() => onDeleteJoin(j)}>×</button>
          </div>
        ))}
        {selfCandidatesOf(table).map((j, i) => (
          <div className="rdiag-node-self rdiag-node-self-candidate" key={`selfcand-${i}`} title="자동으로 찾은 후보 — 눌러서 추가">
            <span>↻ {j.fromCol} → {j.toCol} (후보)</span>
            <button type="button" className="rdiag-node-self-add" title="이 관계 추가" onClick={() => onAddJoin(j)}>＋</button>
          </div>
        ))}
        {cols.length === 0 ? (
          <div className="rdiag-node-empty">
            {columnsByTable[table] ? '연결 가능한 컬럼 없음' : '컬럼 불러오는 중…'}
          </div>
        ) : (
          <div className="rdiag-node-cols">
            {cols.map(col => {
              const key = rowKey(table, col)
              const isUsed      = usedColumnKeys.has(key)
              const isCandidate = !isUsed && candidateColumnKeys.has(key)
              const isOwn       = isOwnLookupColumn(table, col)
              const label = columnLabel(table, col)
              return (
                <div
                  className={`rdiag-node-col${isUsed ? ' used' : ''}${isCandidate ? ' candidate' : ''}${isOwn ? '' : ' target-only'}`}
                  key={col}
                  ref={el => { if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key) }}
                  draggable={isOwn}
                  onDragStart={isOwn ? e => handleColumnDragStart(e, table, col) : undefined}
                  onDragEnd={isOwn ? () => { setDragging(null); setDragOverTable(null) } : undefined}
                  title={isOwn ? undefined : '다른 테이블이 이 컬럼을 가리킬 때 연결선이 닿는 자리입니다 — 여기서 새 연결을 시작할 순 없습니다'}
                >
                  <span className="rdiag-node-col-label">{label}</span>
                  {label !== col && <span className="rdiag-node-col-name">{col}</span>}
                  {!isOwn && <span className="rdiag-node-col-badge">대상</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return createPortal(
    <div className="rdiag-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="rdiag-inner">
        <div className="rdiag-hdr">
          <div>
            <div className="ts-modal-title">"{projectName}" 테이블 연결 다이어그램</div>
            <div className="ts-modal-sub">
              왼쪽에서 테이블을 캔버스로 끌어다 놓으세요(최대 2개, 세 번째를 놓으면 먼저 놓인 게 빠집니다).
              컬럼을 반대쪽 상자로 끌어다 놓거나 점선 후보의 ＋를 누르면 연결이 만들어지고, 오른쪽에서 각 연결에 설명을 달 수 있습니다.
            </div>
          </div>
          <div className="instr-hdr-actions">
            {/* 다이어그램이 패널을 전체화면으로 덮어버려서, 연결을 만들고 나서 실제
                저장 버튼(패널 하단)이 화면에 아예 안 보이는 위치에 가려져 있었다 —
                여기 직접 저장 버튼을 둬서 다이어그램을 안 닫고도 바로 저장할 수 있게 한다. */}
            <button className="btn btn-xs primary" onClick={onSave} disabled={saving}>{saving ? '저장 중…' : '💾 저장'}</button>
            <button className="btn btn-xs" onClick={onClose}>✕ 닫기</button>
          </div>
        </div>

        <div className="rdiag-body">
          {projectTables.length === 0 ? (
            <div className="sb-empty">보여줄 테이블이 없습니다 — 프로젝트에 테이블을 먼저 선택하세요</div>
          ) : (
            <div className="rdiag-layout">
              <div className="rdiag-palette">
                <div className="rdiag-palette-hdr">이 프로젝트 테이블</div>
                {projectTables.map(table => {
                  const placed = placedTables.includes(table)
                  const expanded = expandedInPalette.has(table)
                  return (
                    <div className="rdiag-palette-item" key={table}>
                      <div
                        className={`rdiag-palette-row${placed ? ' placed' : ''}`}
                        draggable
                        onDragStart={e => handlePaletteDragStart(e, table)}
                        title={placed ? '이미 캔버스에 있습니다 — 상자의 ✕로 뺄 수 있습니다' : '캔버스로 끌어다 놓으면 배치됩니다(최대 2개)'}
                      >
                        <button
                          type="button" className="rdiag-palette-toggle"
                          onClick={e => { e.stopPropagation(); togglePaletteExpand(table) }}
                        >
                          {expanded ? '▼' : '▶'}
                        </button>
                        <span className="rdiag-palette-label">{tableLabel(table)}</span>
                        {placed && <span className="rdiag-palette-badge">캔버스</span>}
                      </div>
                      {expanded && (
                        <div className="rdiag-palette-cols">
                          {lookupColumnsOf(table).length === 0 ? (
                            <div className="rdiag-palette-empty">연결 가능한 컬럼 없음</div>
                          ) : lookupColumnsOf(table).map(col => (
                            <div className="rdiag-palette-col" key={col}>{columnLabel(table, col)}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div
                className="rdiag-stage"
                ref={stageRef}
                onDragOver={e => e.preventDefault()}
                onDrop={handleStageDrop}
              >
                {placedTables.length === 0 ? (
                  <div className="rdiag-stage-empty">왼쪽에서 테이블 두 개를 이 영역으로 끌어다 놓으세요</div>
                ) : (
                  <>
                    <svg className="rdiag-svg">
                      {crossJoins.map((j, i) => {
                        const from = rects[rowKey(j.fromTable, j.fromCol)]
                        const to   = rects[rowKey(j.toTable, j.toCol)]
                        if (!from || !to) return null
                        const fromRight = from.x < to.x
                        const x1 = fromRight ? from.x + from.w : from.x
                        const y1 = from.y + from.h / 2
                        const x2 = fromRight ? to.x : to.x + to.w
                        const y2 = to.y + to.h / 2
                        const mx = (x1 + x2) / 2
                        const my = (y1 + y2) / 2
                        return (
                          <g key={i}>
                            <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#4f5b76" strokeWidth={1.5} />
                            <text x={x1 + (fromRight ? 6 : -6)} y={y1 - 4} textAnchor={fromRight ? 'start' : 'end'} className="rdiag-card">N</text>
                            <text x={x2 + (fromRight ? -6 : 6)} y={y2 - 4} textAnchor={fromRight ? 'end' : 'start'} className="rdiag-card">1</text>
                            <g className="rdiag-edge-del" transform={`translate(${mx}, ${my})`} onClick={() => onDeleteJoin(j)}>
                              <title>이 연결 삭제</title>
                              <circle r={8} />
                              <text textAnchor="middle" dominantBaseline="central">×</text>
                            </g>
                          </g>
                        )
                      })}
                      {crossCandidates.map((j, i) => {
                        const from = rects[rowKey(j.fromTable, j.fromCol)]
                        const to   = rects[rowKey(j.toTable, j.toCol)]
                        if (!from || !to) return null
                        const fromRight = from.x < to.x
                        const x1 = fromRight ? from.x + from.w : from.x
                        const y1 = from.y + from.h / 2
                        const x2 = fromRight ? to.x : to.x + to.w
                        const y2 = to.y + to.h / 2
                        const mx = (x1 + x2) / 2
                        const my = (y1 + y2) / 2
                        return (
                          <g key={`cand-${i}`}>
                            <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#3b4258" strokeWidth={1.5} strokeDasharray="4 3" />
                            <g className="rdiag-edge-add" transform={`translate(${mx}, ${my})`} onClick={() => onAddJoin(j)}>
                              <title>이 관계 추가 — 드래그 없이 클릭 한 번</title>
                              <circle r={8} />
                              <text textAnchor="middle" dominantBaseline="central">＋</text>
                            </g>
                          </g>
                        )
                      })}
                    </svg>
                    <div className="rdiag-nodes rdiag-nodes-pair">
                      {placedTables.map(table => renderBox(table))}
                    </div>
                  </>
                )}
              </div>

              <div className="rdiag-detail">
                <div className="rdiag-detail-hdr">관계 상세</div>
                {relatedJoins.length === 0 ? (
                  <div className="rdiag-detail-empty">
                    {placedTables.length === 0
                      ? '테이블을 캔버스에 놓으면 여기 관계가 뜹니다'
                      : '아직 등록된 연결이 없습니다 — 캔버스에서 만들어보세요'}
                  </div>
                ) : (
                  relatedJoins.map((j, i) => (
                    <div className="rdiag-detail-row" key={i}>
                      <div className="rdiag-detail-row-hdr">
                        <span>{tableLabel(j.fromTable)}.{j.fromCol} → {tableLabel(j.toTable)}.{j.toCol}</span>
                        <button type="button" className="instr-row-del" title="삭제" onClick={() => onDeleteJoin(j)}>×</button>
                      </div>
                      {/* "＋설명 추가" 프롬프트가 지침 패널 목록 쪽에 줄마다 붙어 있어서
                          목록이 너무 길어 보인다는 피드백(2026-08-24) — 설명 입력은
                          여기 다이어그램 하나로 모았다. 목록 쪽은 이제 값이 있을 때만
                          짧게 보여준다(InstructionsPanel의 JoinRow 참고). */}
                      <input
                        className="proj-new-input instr-select rdiag-detail-label"
                        placeholder="설명 (예: 어느 거래처의 영업기회인지) — 없어도 됩니다"
                        value={j.label ?? ''}
                        onChange={e => onSaveJoinLabel(j, e.target.value)}
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
