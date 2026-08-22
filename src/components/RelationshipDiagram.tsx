import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NOISE_COLUMN_RE, joinKey as joinKeyOf } from '../lib/schemaColumns'
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
  onClose:         () => void
}

interface Rect { x: number; y: number; w: number; h: number }
interface DragColumn { table: string; column: string }

const rowKey = (table: string, column: string) => `${table}::${column}`
const LOOKUP_TYPES = new Set(['Lookup', 'Owner', 'Customer'])
// HTML5 드래그의 dataTransfer는 문자열/커스텀 MIME만 나르므로, "테이블을 캔버스로
// 끌어옴"(배치)과 "컬럼을 다른 테이블로 끌어옴"(연결)을 서로 다른 타입으로 구분한다.
const DND_TABLE  = 'application/x-rdiag-table'
const DND_COLUMN = 'application/x-rdiag-column'

// Power BI 모델 뷰처럼 테이블을 박스로, 관계를 선으로 보여주는 전체화면 오버레이.
// 2026-08-21: 클릭 기반(컬럼 클릭 → 대상 테이블 클릭)에서 드래그 기반으로 전환 —
// 사용자 피드백("Dendo류 ER 툴처럼 왼쪽 팔레트에서 테이블을 캔버스로 끌어다 놓고,
// 컬럼을 끌어서 연결하고 싶다")을 반영. 캔버스는 처음엔 비어 있고(placedTables),
// 왼쪽 패널(이 프로젝트의 전체 테이블, 접힌 목록)에서 테이블을 캔버스로 끌어다
// 놓아야 상자가 생긴다 — 이미 저장된 조인이 있으면 그 테이블들은 미리 올려둔다.
// 캔버스에 올라온 상자 안의 컬럼(Lookup/Owner/Customer만, 시스템 컬럼 제외)을
// 다른 상자로 끌어다 놓으면 그 컬럼 기준으로 연결이 만들어진다 — 대상 컬럼은 항상
// 그 테이블의 기본키(`${table}id`, Dataverse 관례)로 자동 지정된다.
//
// 자기참조(fromTable === toTable)는 상자 안에 "↻" 뱃지로 단순화했다 — 컬럼을 자기
// 자신의 상자 위에 끌어다 놓아도 자기참조 조인이 만들어지고, 뱃지로 바로 나타난다.
export default function RelationshipDiagram({
  projectName, projectTables, joins, joinCandidates, columnsByTable, tableLabel, onAddJoin, onClose,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const nodesRef  = useRef<HTMLDivElement>(null)
  const rowRefs   = useRef<Map<string, HTMLDivElement>>(new Map())
  const [rects, setRects] = useState<Record<string, Rect>>({})
  const [dragging, setDragging] = useState<DragColumn | null>(null)   // 지금 끌고 있는 컬럼(연결 중)
  const [dragOverTable, setDragOverTable] = useState<string | null>(null)   // 드롭 가능 상자 위에 있는지(하이라이트용)

  const selfJoins  = useMemo(() => joins.filter(j => j.fromTable === j.toTable), [joins])
  const crossJoins = useMemo(() => joins.filter(j => j.fromTable !== j.toTable), [joins])

  // 아직 저장 안 된 "🔎 자동 후보"(지침 패널 연결 탭에 카드로 뜨는 것과 같은 목록)도
  // 점선으로 같이 보여준다 — 캔버스에 두 테이블이 다 올라와 있을 때만 그려진다.
  const candidateCrossJoins = useMemo(
    () => joinCandidates.filter(c => c.fromTable !== c.toTable && !joins.some(j => joinKeyOf(j) === joinKeyOf(c))),
    [joinCandidates, joins],
  )

  // 왼쪽 팔레트에 나열할 후보 = 프로젝트 테이블 스코프 전체(스코프 미지정이면 조인에
  // 등장하는 테이블만 — 전체 카탈로그를 다 나열하면 압도적으로 많음).
  const paletteTables = useMemo(() => {
    if (projectTables.length > 0) return projectTables
    return [...new Set(joins.flatMap(j => [j.fromTable, j.toTable]))]
  }, [projectTables, joins])

  // 캔버스에 실제로 올라온 테이블 — 처음엔 이미 저장된 조인이 걸쳐 있는 테이블만
  // 미리 올려서 "기존 연결은 열자마자 보이게", 나머진 왼쪽에서 끌어와야 나타난다.
  const [placedTables, setPlacedTables] = useState<string[]>(() =>
    [...new Set(joins.flatMap(j => [j.fromTable, j.toTable]))],
  )
  const placeTable = (table: string) =>
    setPlacedTables(prev => (prev.includes(table) ? prev : [...prev, table]))
  const unplaceTable = (table: string) =>
    setPlacedTables(prev => prev.filter(t => t !== table))

  const [expandedInPalette, setExpandedInPalette] = useState<Set<string>>(new Set())
  const togglePaletteExpand = (table: string) =>
    setExpandedInPalette(prev => {
      const next = new Set(prev)
      if (next.has(table)) next.delete(table); else next.add(table)
      return next
    })

  // 상자 안엔 그 테이블의 전체 컬럼이 아니라 "실제로 다른 테이블을 가리킬 수 있는
  // 컬럼"(Lookup/Owner/Customer)만 나열한다 — new_q3 하나만 70개 컬럼이라 전부
  // 보여주면 상자가 감당이 안 됨. 그중에서도 createdby/ownerid/transactioncurrencyid
  // 처럼 모든 커스텀 테이블에 자동으로 붙는 시스템 감사·소유권 컬럼(NOISE_COLUMN_RE,
  // InstructionsPanel 용어 탭과 같은 기준)은 값은 Lookup이어도 systemuser/team 같은
  // Dataverse 플랫폼 엔터티를 가리킬 뿐 업무 관계가 아니라서 같이 걸러낸다.
  const lookupColumnsOf = (table: string): string[] =>
    (columnsByTable[table] ?? [])
      .filter(c => LOOKUP_TYPES.has(c.type) && !NOISE_COLUMN_RE.test(c.name))
      .map(c => c.name)

  // 같은 테이블이면 왼쪽 팔레트 미리보기와 오른쪽 캔버스 상자가 항상 같은 컬럼
  // 목록을 보여줘야 한다 — 그래서 "이 테이블 자신의 lookup 컬럼" + "이미 조인/후보가
  // 가리키는 컬럼"(PK 등)을 합친 이 함수 하나를 팔레트·캔버스 양쪽에서 공용으로 쓴다.
  const relevantColumnsOf = (table: string): string[] => {
    const names = new Set(lookupColumnsOf(table))
    for (const j of [...crossJoins, ...candidateCrossJoins, ...selfJoins]) {
      if (j.fromTable === table) names.add(j.fromCol)
      if (j.toTable === table) names.add(j.toCol)
    }
    return [...names]
  }

  // PK/대상 컬럼은 자기 자신이 다른 테이블을 가리키는 게 아니라 "다른 테이블이
  // 여길 가리킬 때 선이 닿는 자리"일 뿐이라, ①"대상" 뱃지를 붙여 다른 종류라는 걸
  // 표시하고 ②드래그 시작점으로는 못 쓰게 한다(이 행을 끌어서 새 연결을 만드는 건
  // 의미가 없다 — 이미 도착지다).
  const isOwnLookupColumn = (table: string, col: string): boolean => lookupColumnsOf(table).includes(col)

  // 캔버스 상자 안에 그릴 컬럼 = relevantColumnsOf 그대로(플레이스된 테이블만).
  const tableColumns = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const table of placedTables) map.set(table, relevantColumnsOf(table))
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedTables, columnsByTable, crossJoins, candidateCrossJoins])

  // 자기참조(selfJoins)도 "이미 연결됨" 스타일을 같이 받아야 한다 — 안 그러면 위에
  // "↻" 뱃지로는 연결됐다고 보여주면서 바로 아래 같은 컬럼 행은 평범한(=안 쓴)
  // 색으로 남아 모순돼 보인다(실제로 이 화면 피드백으로 발견된 불일치).
  const usedColumnKeys = useMemo(() => {
    const s = new Set<string>()
    for (const j of [...crossJoins, ...selfJoins]) { s.add(rowKey(j.fromTable, j.fromCol)); s.add(rowKey(j.toTable, j.toCol)) }
    return s
  }, [crossJoins, selfJoins])

  const candidateColumnKeys = useMemo(() => {
    const s = new Set<string>()
    for (const j of candidateCrossJoins) { s.add(rowKey(j.fromTable, j.fromCol)); s.add(rowKey(j.toTable, j.toCol)) }
    return s
  }, [candidateCrossJoins])

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

  // 테이블이 화면에 다 안 들어가면(특히 세로) 스크롤 대신 우선 축소해서 한눈에
  // 보이게 한다 — Figma/Miro류 "화면에 맞추기"와 같은 발상. zoom은(transform과
  // 달리) 실제 레이아웃 크기 자체를 줄여서 부모 스크롤 영역도 같이 줄어들고,
  // getBoundingClientRect()도 이미 축소된 좌표를 그대로 돌려줘서 연결선 계산
  // (recomputeRects)을 손댈 필요가 없다. 0.45 밑으로는 글자가 안 보일 정도로 작아져
  // 오히려 못 쓰게 되므로 거기서 멈추고, 그 이상 넘치는 건 캔버스 자체 스크롤
  // (overflow:auto, 기존 안전장치)에 맡긴다 — Firefox는 zoom 미지원이라 그 경우
  // 그냥 1배(=기존처럼 스크롤)로 남는다.
  const fitToScreen = () => {
    const stage = stageRef.current
    const nodes = nodesRef.current
    if (!stage || !nodes) return
    nodes.style.zoom = '1'
    const naturalW = nodes.scrollWidth
    const naturalH = nodes.scrollHeight
    const availW = stage.clientWidth - 48   // .rdiag-stage padding: 24px 양쪽
    const availH = stage.clientHeight - 48
    const raw = naturalW > 0 && naturalH > 0 ? Math.min(1, availW / naturalW, availH / naturalH) : 1
    nodes.style.zoom = String(Number.isFinite(raw) ? Math.max(0.45, raw) : 1)
  }

  useLayoutEffect(() => {
    const refit = () => { fitToScreen(); recomputeRects() }
    refit()
    window.addEventListener('resize', refit)
    return () => window.removeEventListener('resize', refit)
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

  return createPortal(
    <div className="rdiag-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="rdiag-inner">
        <div className="rdiag-hdr">
          <div>
            <div className="ts-modal-title">"{projectName}" 테이블 연결 다이어그램</div>
            <div className="ts-modal-sub">
              왼쪽 테이블을 캔버스로 끌어다 놓고, 상자 안 컬럼을 다른 상자로 끌어다 놓으면 연결이 만들어집니다.
              {candidateCrossJoins.length > 0 && ' 점선은 스키마에서 자동으로 찾았지만 아직 저장 안 한 후보입니다.'}
            </div>
          </div>
          <div className="instr-hdr-actions">
            <button className="btn btn-xs" onClick={onClose}>✕ 닫기</button>
          </div>
        </div>

        <div className="rdiag-body">
          {paletteTables.length === 0 ? (
            <div className="sb-empty">보여줄 테이블이 없습니다 — 프로젝트에 테이블을 먼저 선택하세요</div>
          ) : (
            <div className="rdiag-layout">
              <div className="rdiag-palette">
                <div className="rdiag-palette-hdr">이 프로젝트 테이블</div>
                {paletteTables.map(table => {
                  const placed = placedTables.includes(table)
                  const expanded = expandedInPalette.has(table)
                  return (
                    <div className="rdiag-palette-item" key={table}>
                      <div
                        className={`rdiag-palette-row${placed ? ' placed' : ''}`}
                        draggable
                        onDragStart={e => handlePaletteDragStart(e, table)}
                        title={placed ? '이미 캔버스에 있습니다 — 상자의 ✕로만 뺄 수 있습니다' : '캔버스로 끌어다 놓으면 배치됩니다'}
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
                {placedTables.length === 0 && (
                  <div className="rdiag-stage-empty">왼쪽에서 테이블을 이 영역으로 끌어다 놓으세요</div>
                )}
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
                    return (
                      <g key={i}>
                        <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke="#4f5b76" strokeWidth={1.5} />
                        <text x={x1 + (fromRight ? 6 : -6)} y={y1 - 4} textAnchor={fromRight ? 'start' : 'end'} className="rdiag-card">N</text>
                        <text x={x2 + (fromRight ? -6 : 6)} y={y2 - 4} textAnchor={fromRight ? 'end' : 'start'} className="rdiag-card">1</text>
                      </g>
                    )
                  })}
                  {candidateCrossJoins.map((j, i) => {
                    const from = rects[rowKey(j.fromTable, j.fromCol)]
                    const to   = rects[rowKey(j.toTable, j.toCol)]
                    if (!from || !to) return null
                    const fromRight = from.x < to.x
                    const x1 = fromRight ? from.x + from.w : from.x
                    const y1 = from.y + from.h / 2
                    const x2 = fromRight ? to.x : to.x + to.w
                    const y2 = to.y + to.h / 2
                    const mx = (x1 + x2) / 2
                    return (
                      <path
                        key={`cand-${i}`}
                        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                        fill="none" stroke="#3b4258" strokeWidth={1.5} strokeDasharray="4 3"
                      />
                    )
                  })}
                </svg>

                <div className="rdiag-nodes" ref={nodesRef}>
                  {placedTables.map(table => {
                    const cols = tableColumns.get(table) ?? []
                    const selfBadges = selfJoins.filter(j => j.fromTable === table)
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
                          <button
                            type="button" className="rdiag-node-remove" title="캔버스에서 빼기(저장된 연결은 유지됨)"
                            onClick={() => unplaceTable(table)}
                          >
                            ✕
                          </button>
                        </div>
                        <div className="rdiag-node-name">{table}</div>
                        {selfBadges.map((j, i) => (
                          <div className="rdiag-node-self" key={`self-${i}`} title="같은 테이블을 가리키는 자기참조 조인">
                            ↻ {j.fromCol} → {j.toCol}{j.label ? ` (${j.label})` : ''}
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
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
