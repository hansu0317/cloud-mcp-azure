import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NOISE_COLUMN_RE } from '../lib/schemaColumns'
import type { JoinDef } from '../types'

interface ColumnInfo { name: string; type: string; desc: string; options?: string[] }

interface Props {
  projectName:    string
  projectTables:  string[]
  joins:          JoinDef[]
  columnsByTable: Record<string, ColumnInfo[]>
  tableLabel:     (name: string) => string
  onAddJoin:      (join: JoinDef) => void
  onClose:        () => void
}

interface Rect { x: number; y: number; w: number; h: number }

const rowKey = (table: string, column: string) => `${table}::${column}`
const LOOKUP_TYPES = new Set(['Lookup', 'Owner', 'Customer'])

// Power BI 모델 뷰처럼 테이블을 박스로, 관계를 선으로 보여주는 전체화면 오버레이 —
// 이제 "보기 전용"이 아니라 여기서 직접 연결을 만든다: Lookup/Owner/Customer 타입
// 컬럼(=Dataverse에서 실제로 다른 테이블을 가리킬 수 있는 컬럼)을 클릭해서 시작점을
// 정하고, 대상 테이블 박스를 클릭하면 그 자리에서 조인이 만들어진다. 대상 컬럼은
// 항상 그 테이블의 기본키(`${table}id`, Dataverse 관례)로 자동 지정된다 — 조인
// 탭의 위저드(_draft_joins()와 같은 규칙)와 동일해서 별도로 고를 필요가 없다.
//
// 자기참조(fromTable === toTable)는 Power BI도 곡선 루프로 그리지만, 여기선 상자
// 안에 "↻" 뱃지로 단순화했다 — 자기 자신을 대상으로 클릭해도 자기참조 조인이
// 만들어지고, 뱃지로 바로 나타난다.
export default function RelationshipDiagram({
  projectName, projectTables, joins, columnsByTable, tableLabel, onAddJoin, onClose,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const rowRefs   = useRef<Map<string, HTMLDivElement>>(new Map())
  const [rects, setRects] = useState<Record<string, Rect>>({})
  const [armed, setArmed] = useState<{ table: string; column: string } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (armed) setArmed(null)   // 연결 만드는 중이면 그것부터 취소
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, armed])

  const selfJoins  = useMemo(() => joins.filter(j => j.fromTable === j.toTable), [joins])
  const crossJoins = useMemo(() => joins.filter(j => j.fromTable !== j.toTable), [joins])

  // 보여줄 테이블 = 프로젝트 스코프가 있으면 그 테이블들, 없으면(=전체 허용) 조인에
  // 실제로 등장하는 테이블만(전체 카탈로그를 다 그리면 압도적으로 많음).
  const tables = useMemo(() => {
    if (projectTables.length > 0) return projectTables
    return [...new Set(joins.flatMap(j => [j.fromTable, j.toTable]))]
  }, [projectTables, joins])

  // 상자 안엔 그 테이블의 전체 컬럼이 아니라 "실제로 다른 테이블을 가리킬 수 있는
  // 컬럼"(Lookup/Owner/Customer)만 나열한다 — new_q3 하나만 70개 컬럼이라 전부
  // 보여주면 상자가 감당이 안 됨. 그중에서도 createdby/ownerid/transactioncurrencyid
  // 처럼 모든 커스텀 테이블에 자동으로 붙는 시스템 감사·소유권 컬럼(NOISE_COLUMN_RE,
  // InstructionsPanel 용어 탭과 같은 기준)은 값은 Lookup이어도 systemuser/team 같은
  // Dataverse 플랫폼 엔터티를 가리킬 뿐 업무 관계가 아니라서 같이 걸러낸다 — 안 그러면
  // 테이블 하나당 실제 업무 조인(new_l_*)보다 시스템 컬럼이 더 많이 보여서 다이어그램이
  // 실제보다 훨씬 복잡해 보인다. 이미 조인에 쓰인 컬럼은 이 필터에 걸려도 안전하게 포함시킨다.
  const tableColumns = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const table of tables) {
      const names = new Set(
        (columnsByTable[table] ?? [])
          .filter(c => LOOKUP_TYPES.has(c.type) && !NOISE_COLUMN_RE.test(c.name))
          .map(c => c.name),
      )
      for (const j of crossJoins) {
        if (j.fromTable === table) names.add(j.fromCol)
        if (j.toTable === table) names.add(j.toCol)
      }
      map.set(table, [...names])
    }
    return map
  }, [tables, columnsByTable, crossJoins])

  const usedColumnKeys = useMemo(() => {
    const s = new Set<string>()
    for (const j of crossJoins) { s.add(rowKey(j.fromTable, j.fromCol)); s.add(rowKey(j.toTable, j.toCol)) }
    return s
  }, [crossJoins])

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

  useLayoutEffect(() => {
    recomputeRects()
    window.addEventListener('resize', recomputeRects)
    return () => window.removeEventListener('resize', recomputeRects)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(','), joins.length, columnsByTable])

  const handleColumnClick = (table: string, column: string) => {
    if (armed && armed.table === table && armed.column === column) { setArmed(null); return }
    setArmed({ table, column })
  }
  const handleTableClick = (table: string) => {
    if (!armed) return
    onAddJoin({ fromTable: armed.table, fromCol: armed.column, toTable: table, toCol: `${table}id`, label: '' })
    setArmed(null)
  }

  return createPortal(
    <div className="rdiag-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="rdiag-inner">
        <div className="rdiag-hdr">
          <div>
            <div className="ts-modal-title">"{projectName}" 테이블 연결 다이어그램</div>
            <div className="ts-modal-sub">
              {armed
                ? <><b>{tableLabel(armed.table)}.{armed.column}</b> 연결 중 — 대상 테이블 상자를 클릭하세요 (Esc로 취소)</>
                : '파란 컬럼을 클릭해 시작점을 고르고, 이어질 테이블 상자를 클릭하면 연결이 만들어집니다'}
            </div>
          </div>
          <div className="instr-hdr-actions">
            <button className="btn btn-xs" onClick={onClose}>✕ 닫기</button>
          </div>
        </div>

        <div className="rdiag-body">
          {tables.length === 0 ? (
            <div className="sb-empty">보여줄 테이블이 없습니다 — 프로젝트에 테이블을 먼저 선택하세요</div>
          ) : (
            <div className="rdiag-stage" ref={stageRef}>
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
              </svg>

              <div className="rdiag-nodes">
                {tables.map(table => {
                  const cols = tableColumns.get(table) ?? []
                  const selfBadges = selfJoins.filter(j => j.fromTable === table)
                  const isTarget = !!armed && armed.table !== table
                  return (
                    <div
                      className={`rdiag-node${isTarget ? ' rdiag-node-target' : ''}`}
                      key={table}
                      onClick={() => handleTableClick(table)}
                    >
                      <div className="rdiag-node-hdr">{tableLabel(table)}</div>
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
                            const isArmed = armed?.table === table && armed.column === col
                            const isUsed  = usedColumnKeys.has(key)
                            return (
                              <div
                                className={`rdiag-node-col${isUsed ? ' used' : ''}${isArmed ? ' armed' : ''}`}
                                key={col}
                                ref={el => { if (el) rowRefs.current.set(key, el); else rowRefs.current.delete(key) }}
                                onClick={e => { e.stopPropagation(); handleColumnClick(table, col) }}
                              >
                                {col}
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
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
