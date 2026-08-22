import { useEffect, useMemo, useState } from 'react'
import { API } from '../constants'
import { NOISE_COLUMN_RE, joinKey } from '../lib/schemaColumns'
import RelationshipDiagram from './RelationshipDiagram'
import type { Cell, Instructions, JoinDef, TermDef, ExampleDef } from '../types'

interface Props {
  collapsed:     boolean
  projectId:     string
  projectName:   string
  projectTables: string[]
  instructions:  Instructions
  cells:         Cell[]
  onSave:        (next: Instructions) => Promise<void>
}

type Tab = 'joins' | 'terms' | 'examples'

interface TableMeta  { name: string; label: string; domain: string }
interface ColumnInfo { name: string; type: string; desc: string; options?: string[] }

const EMPTY_TERM:    TermDef    = { table: '', column: '', term: '', def: '' }
const EMPTY_EXAMPLE: ExampleDef = { question: '', answer: '' }

// backend/dataverse.py의 fetchEntitySchema()가 만드는 마크다운 표
// ("| 컬럼명 | 타입 | 한국어 설명 |" 헤더 + 구분선 + 데이터 행)를 그대로 파싱한다.
// Picklist 컬럼은 설명에 "(옵션1 / 옵션2 / ...)"가 붙어 나오므로 그것도 뽑아둔다 —
// 용어 탭에서 그 옵션을 클릭 한 번으로 채울 수 있게 하기 위해서다.
function parseSchemaMarkdown(md: string): ColumnInfo[] {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'))
  return lines.slice(2)   // [0]=헤더, [1]=구분선(---) 제외
    .map(line => {
      const [name = '', type = '', descRaw = ''] = line.split('|').map(c => c.trim()).slice(1, -1)
      const optMatch = descRaw.match(/\(([^()]+\/[^()]+)\)/)
      const options = optMatch ? optMatch[1].split('/').map(s => s.trim()) : undefined
      return { name, type, desc: descRaw, options }
    })
    .filter(c => c.name)
}

// backend/dataverse.py의 fetch_entity_schema()는 Dataverse 관리자가 직접 입력해둔
// Description이 있을 때만 " — "로 이어붙인다(dataverse.py:334-337). 그래서 desc에
// " — "가 있으면 이미 사람이 업무 의미를 적어둔 컬럼이라는 뜻이고, Picklist류는 desc에
// 코드값이 그대로 노출되므로(options) 둘 다 "이미 설명됨"으로 본다.
//
// "용어"는 컬럼에 저장된 코드값·짧은 값이 실제로 뭘 뜻하는지 알려주는 기능이지,
// 자유 텍스트(메모·설명)나 날짜·숫자 컬럼까지 전부 대상이 아니다 — 캠페인처럼
// Picklist가 적고 Memo/String 컬럼이 많은 테이블에서 "설명 없는 컬럼 = 전부 필요"로
// 잡으면 목록이 쓸데없이 부풀었다. 그래서 코드값을 가질 수 있는 타입(Boolean —
// Picklist/State/Status는 이미 options로 잡힘)만 후보로 남긴다.
const CODED_VALUE_TYPES = new Set(['Boolean'])
function needsTerm(col: ColumnInfo): boolean {
  return CODED_VALUE_TYPES.has(col.type) && !col.desc.includes(' — ') && !col.options
}

// "new_l_q1name"처럼 다른 컬럼(new_l_q1)의 표시값을 그대로 미러링하는 자동 생성
// 컬럼 — 원본 컬럼과 별개로 정의할 게 없다.
function isMirrorColumn(col: ColumnInfo, all: ColumnInfo[]): boolean {
  const m = col.name.match(/^(.+?)(yominame|name)$/i)
  if (!m) return false
  return all.some(c => c.name === m[1])
}

function isNoiseColumn(col: ColumnInfo, all: ColumnInfo[]): boolean {
  return NOISE_COLUMN_RE.test(col.name) || col.type === 'Uniqueidentifier' || isMirrorColumn(col, all)
}

// 탭마다 있던 "언제 필요한가요?" 설명이 매번 3~5줄씩 항상 펼쳐져 있어 지침 패널을
// 열 때마다 화면을 잠식했다. 자동으로 하루에 한 번 띄우는 방식(2026-08-21 초반
// 버전)도 써봤지만 "그냥 눌렀을 때만 뜨면 된다"는 피드백으로 되돌림 — 이제 탭 안엔
// 물음표 아이콘 하나만 있고, 누를 때만 지침 패널 안(HintPopup)에 설명이 뜬다.
const HINT_TEXT: Record<Tab, string> = {
  joins: '테이블 두 개를 엮는 질문에서 AI가 틀린다면 연결을 알려주세요. 아래 자동 후보를 클릭하거나, 다이어그램에서 컬럼을 다른 테이블로 끌어다 놓으면 만들어집니다.',
  terms: '컬럼 값(true/false 등)이 실제로 무슨 뜻인지 AI가 모를 때 알려주세요. 아래는 Dataverse에 설명이 없는 컬럼만 자동으로 골라 보여줍니다.',
  examples: 'AI 답변이 매번 다르거나 헤매면 대표 질문·답변 예시를 등록하세요. 답변은 지어내지 말고 노트북에서 실제로 물어봐서 나온 결과 그대로 넣으세요 — 아래 ✓ 버튼으로 실행된 셀을 가져오면 편합니다.',
}

// 탭 안에 항상 떠 있는 작은 물음표 — 누르면 HintPopup이 뜬다.
function HintIcon({ tab, onOpen }: { tab: Tab; onOpen: (tab: Tab) => void }) {
  return <button type="button" className="instr-hint-icon" onClick={() => onOpen(tab)}>❓ 언제 필요한가요?</button>
}

// 물음표를 눌렀을 때만 뜨는 설명 팝업 — 배경을 클릭하거나 버튼을 누르면 닫힌다.
// document.body로 포털하는 화면 전체 모달이 아니라 — "왜 화면 한가운데 뜨냐, 지침
// 패널 안에서 떠야지"라는 피드백을 반영해 — 지침 패널(.instr-panel,
// position:relative) 안에서만 뜨는 절대배치 오버레이다.
function HintPopup({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  return (
    <div className="hint-popup-overlay" onClick={onClose}>
      <div className="hint-popup" onClick={e => e.stopPropagation()}>
        <div className="hint-popup-text">{HINT_TEXT[tab]}</div>
        <button type="button" className="btn btn-sm primary" onClick={onClose}>닫기</button>
      </div>
    </div>
  )
}

// 용어 탭 한 줄 — 비활성 상태면 "컬럼명 + 설명 + ➕"만 보이는 버튼이고, 누르면 그
// 자리에서 용어/뜻 입력칸으로 바뀐다(테이블·컬럼은 이미 정해져 있으니 나머지 두
// 개만 채우면 된다 — 예전의 4단계 드롭다운 위저드를 대체).
function TermQuickRow({ col, active, draft, onActivate, onChange, onAdd }: {
  col: ColumnInfo; active: boolean; draft: TermDef
  onActivate: () => void; onChange: (d: TermDef) => void; onAdd: () => void
}) {
  if (!active) {
    return (
      <button type="button" className="instr-term-row-btn" onClick={onActivate}>
        <span className="instr-term-row-col">{col.name}</span>
        <span className="instr-term-row-desc">{col.desc}</span>
        <span className="instr-term-row-plus">＋</span>
      </button>
    )
  }
  return (
    <div className="instr-term-active">
      <div className="instr-term-active-hdr"><b>{col.name}</b> — {col.desc}</div>
      {col.options && (
        <div className="instr-chip-row">
          {col.options.map(opt => (
            <button
              type="button" key={opt}
              className={`instr-chip${draft.term === opt ? ' active' : ''}`}
              onClick={() => onChange({ ...draft, term: opt, def: opt })}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
      <input
        className="proj-new-input instr-select"
        placeholder="업무에서 부르는 이름 (예: 진행중)"
        value={draft.term}
        onChange={e => onChange({ ...draft, term: e.target.value })}
      />
      <input
        className="proj-new-input instr-select"
        placeholder="정확한 뜻"
        value={draft.def}
        onChange={e => onChange({ ...draft, def: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') onAdd() }}
      />
      <button type="button" className="btn btn-sm primary instr-step-add" onClick={onAdd}>이 용어 추가</button>
    </div>
  )
}

// "지침" 패널 — 왼쪽 카탈로그 사이드바와 대칭되는 오른쪽 상시 패널. 테이블 조인
// 관계·컬럼 용어·질문 예시를 등록하면 서버가 매 질문의 시스템 프롬프트에 최신
// 저장값을 넣어 모델이 참고한다.
//
// 프로젝트를 바꿀 때마다 그 프로젝트의 지침으로 다시 채워지는 건 이 컴포넌트가
// 스스로 하는 게 아니라, App.tsx가 <InstructionsPanel key={activeProject.id} .../>로
// 프로젝트 전환 시 강제로 새로 마운트시켜서다(NotebookView와 동일한 패턴) — 그래야
// 아래 useState(instructions.*) 초기값이 새 프로젝트 것으로 다시 계산된다.
export default function InstructionsPanel({ collapsed, projectId, projectName, projectTables, instructions, cells, onSave }: Props) {
  const [tab, setTab] = useState<Tab>('joins')
  const [joins,    setJoins]    = useState<JoinDef[]>(instructions.joins)
  const [terms,    setTerms]    = useState<TermDef[]>(instructions.terms)
  const [examples, setExamples] = useState<ExampleDef[]>(instructions.examples)
  const [saving, setSaving] = useState(false)

  const [termDraft,    setTermDraft]    = useState<TermDef>(EMPTY_TERM)
  const [exampleDraft, setExampleDraft] = useState<ExampleDef>(EMPTY_EXAMPLE)

  // 탭 설명 팝업 — 물음표 아이콘을 눌렀을 때만 연다(자동으로 뜨지 않음).
  const [hintPopupTab, setHintPopupTab] = useState<Tab | null>(null)

  // 조인은 다이어그램에서 클릭으로, 용어는 "정의 필요" 목록에서, 예시는 "노트북에서
  // 가져오기"에서 각자 알아서 후보를 보여주므로(각 탭 참고) 로그를 훑어 한 번에
  // 채우던 전역 "초안 생성" 버튼은 뺐다 — 탭마다 이미 자기 프로젝트 범위의 후보를
  // 보여주는 제자리 메커니즘이 있어서 중복이었다. draftMsg는 저장 시 "안 채운 후보는
  // 저장 안 됨" 안내(handleSave)에 계속 쓰인다.
  const [draftMsg, setDraftMsg] = useState<string | null>(null)

  // 테이블 목록 + 컬럼 설명 캐시 — 드롭다운/용어 목록을 채우는 용도. 컬럼은 필요한
  // 시점에 그때그때 불러온다(describe는 서버 캐시라 사실상 즉시 응답).
  const [catalog, setCatalog] = useState<TableMeta[]>([])
  const [columnsCache,   setColumnsCache]   = useState<Record<string, ColumnInfo[]>>({})
  const [columnsLoading, setColumnsLoading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    fetch(API.TABLES)
      .then(r => r.json())
      .then((d: { tables: TableMeta[] }) => setCatalog(d.tables))
      .catch(() => setCatalog([]))
  }, [])

  const ensureColumns = (table: string) => {
    if (!table || columnsCache[table] || columnsLoading[table]) return
    setColumnsLoading(prev => ({ ...prev, [table]: true }))
    fetch(`${API.DESCRIBE}?table=${encodeURIComponent(table)}`)
      .then(r => r.json())
      .then((d: { schema?: string }) => {
        setColumnsCache(prev => ({ ...prev, [table]: d.schema ? parseSchemaMarkdown(d.schema) : [] }))
      })
      .catch(() => setColumnsCache(prev => ({ ...prev, [table]: [] })))
      .finally(() => setColumnsLoading(prev => ({ ...prev, [table]: false })))
  }

  // 용어 탭을 처음 열 때 이 프로젝트의 테이블 전부를 한 번에 불러온다(테이블별로
  // 나열해서 보여주는 방식이라 어차피 다 필요함 — 조인 탭처럼 고를 때마다 하나씩
  // 불러오는 게 아니다). 이미 불러온 테이블은 ensureColumns가 다시 건드리지 않는다.
  useEffect(() => {
    if (tab !== 'terms') return
    for (const table of projectTables) ensureColumns(table)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, projectTables])

  // 프로젝트 테이블 스코프 "안에서만" Dataverse에 실제로 있는 FK(schema.json의
  // lookups)를 훑어 조인 후보를 서버가 계산해 보내준다 — 추측이 아니라 스키마가 이미
  // 아는 사실이라 사람이 다이어그램에서 매번 그려 넣을 필요가 없다. 저장된 목록엔
  // 손대지 않고 "추천" 카드로만 보여주며, ＋를 눌러야 실제 joins에 들어간다.
  const [joinCandidates, setJoinCandidates] = useState<JoinDef[]>([])
  useEffect(() => {
    if (projectTables.length === 0) { setJoinCandidates([]); return }
    fetch(`${API.PROJECTS}/${projectId}/join-candidates`)
      .then(r => r.json())
      .then((d: { joins?: JoinDef[] }) => setJoinCandidates(d.joins ?? []))
      .catch(() => setJoinCandidates([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectTables.join(',')])

  // 다이어그램에서 컬럼을 클릭해 만든 연결 — 위저드 없이 여기서 바로 만들어지므로 중복만 막는다.
  const addJoinIfNew = (join: JoinDef) => {
    setJoins(prev => (prev.some(j => joinKey(j) === joinKey(join)) ? prev : [...prev, join]))
  }
  const activateTerm = (table: string, column: string) => setTermDraft({ table, column, term: '', def: '' })
  const addTerm = () => {
    if (!termDraft.table.trim() || !termDraft.column.trim() || !termDraft.term.trim() || !termDraft.def.trim()) return
    setTerms(prev => [...prev, { ...termDraft }])
    setTermDraft(EMPTY_TERM)
  }
  const addExample = () => {
    if (!exampleDraft.question.trim() || !exampleDraft.answer.trim()) return
    setExamples(prev => [...prev, { ...exampleDraft }])
    setExampleDraft(EMPTY_EXAMPLE)
  }

  // joins는 _draft_joins()가 항상 완전한 값만 만들어서 그대로 믿을 수 있지만, terms/
  // examples는 초안이든 직접 입력이든 table/column/def, question/answer가 빈 채로
  // 화면에만 있을 수 있다(사람이 아직 안 채운 상태). 이 상태로 그냥 저장하면 빈 정의·
  // 빈 답변이 그대로 시스템 프롬프트에 들어가 버려서(_instruction_prompt 참고), "초안
  // 생성 → 검토 없이 바로 저장"을 해도 최소한 사고는 안 나게 여기서 걸러낸다.
  const handleSave = async () => {
    setSaving(true)
    try {
      const completeTerms    = terms.filter(t => t.table.trim() && t.column.trim() && t.term.trim() && t.def.trim())
      const completeExamples = examples.filter(e => e.question.trim() && e.answer.trim())
      const skipped = (terms.length - completeTerms.length) + (examples.length - completeExamples.length)
      await onSave({ joins, terms: completeTerms, examples: completeExamples })
      setDraftMsg(
        skipped > 0
          ? `아직 안 채운 초안 후보 ${skipped}개는 저장하지 않았습니다 — 목록에 남아있으니 채운 뒤 다시 저장하세요`
          : null,
      )
    } finally {
      setSaving(false)
    }
  }

  // 로그에서 자동으로 답까지 채우는 대신(5번 참고), 지금 이 세션에서 실제로 실행해서
  // 눈으로 확인한 셀만 "검증된" 후보로 본다 — dataverse_query가 최소 한 번 성공했고
  // (describe만 호출한 셀은 제외), 에러 없이 끝난 셀만 추린다.
  const verifiedCells = useMemo(
    () => cells.filter(c =>
      c.output && !c.output.loading && !c.output.error && c.output.content.trim()
      && (c.output.queries ?? []).some(q => q.tool === 'dataverse_query'),
    ),
    [cells],
  )

  const totalCount = joins.length + terms.length + examples.length
  const [diagramOpen, setDiagramOpen] = useState(false)

  const tableLabel = (name: string) => catalog.find(t => t.name === name)?.label ?? name

  return (
    <div className={`instr-panel${collapsed ? ' collapsed' : ''}`}>
      <div className="instr-panel-hdr">
        <div>
          <div className="ts-modal-title">
            "{projectName}"의 지침
            <span className="instr-title-help" title="지침은 AI를 다시 학습시키는 게 아닙니다. 이 프로젝트에서 질문할 때마다 '우리는 이런 규칙을 씁니다'라는 메모를 자동으로 같이 보여주는 기능이에요. 다른 프로젝트에는 영향을 주지 않습니다.">ⓘ</span>
          </div>
          <div className="ts-modal-sub">테이블 연결·용어·예시를 알려주면 이 프로젝트의 질문마다 자동으로 참고해 답변 품질이 좋아집니다</div>
        </div>
      </div>

      {draftMsg && <div className="instr-draft-msg">{draftMsg}</div>}

      <div className="instr-tabs">
        <button className={`instr-tab${tab === 'joins' ? ' active' : ''}`} onClick={() => setTab('joins')}>
          🔗 테이블 연결{joins.length > 0 && <span className="instr-tab-count">{joins.length}</span>}
        </button>
        <button className={`instr-tab${tab === 'terms' ? ' active' : ''}`} onClick={() => setTab('terms')}>
          📖 용어 뜻{terms.length > 0 && <span className="instr-tab-count">{terms.length}</span>}
        </button>
        <button className={`instr-tab${tab === 'examples' ? ' active' : ''}`} onClick={() => setTab('examples')}>
          💬 질문 예시{examples.length > 0 && <span className="instr-tab-count">{examples.length}</span>}
        </button>
      </div>

      {hintPopupTab && <HintPopup tab={hintPopupTab} onClose={() => setHintPopupTab(null)} />}

      <div className="instr-panel-body">
        {tab === 'joins' && (
          <>
            {projectTables.length > 0 && (
              <button
                type="button" className="btn btn-sm primary instr-diagram-btn"
                onClick={() => { for (const t of projectTables) ensureColumns(t); setDiagramOpen(true) }}
              >
                🗺 다이어그램으로 연결하기
              </button>
            )}
            <HintIcon tab="joins" onOpen={setHintPopupTab} />
            {projectTables.length === 0 && (
              <div className="instr-hint" style={{ paddingTop: 0 }}>
                이 프로젝트는 테이블이 하나도 선택되지 않았습니다 — 사이드바 "＋테이블"에서 먼저 테이블을 골라야 여기서 연결을 만들 수 있습니다.
              </div>
            )}
            {(() => {
              const visibleCandidates = joinCandidates.filter(c => !joins.some(j => joinKey(j) === joinKey(c)))
              if (visibleCandidates.length === 0) return null
              return (
                <div className="instr-term-group">
                  <div className="instr-term-group-hdr">
                    🔎 스키마에서 자동으로 찾은 연결 후보
                    <span className="instr-term-need-badge">{visibleCandidates.length}개</span>
                  </div>
                  {visibleCandidates.map((c, i) => (
                    <button
                      type="button" key={i} className="instr-term-row-btn"
                      title="Dataverse에 실제로 있는 관계(FK)에서 찾았습니다 — 클릭하면 바로 추가됩니다"
                      onClick={() => addJoinIfNew(c)}
                    >
                      <span className="instr-term-row-col">{tableLabel(c.fromTable)}.{c.fromCol}</span>
                      <span className="instr-term-row-desc">→ {tableLabel(c.toTable)}</span>
                      <span className="instr-term-row-plus">＋</span>
                    </button>
                  ))}
                </div>
              )
            })()}
            {joins.length === 0 && <div className="sb-empty">등록된 테이블 연결이 없습니다</div>}
            {joins.map((j, i) => (
              <div className="instr-row" key={i}>
                <span className="instr-row-text">
                  <b>{tableLabel(j.fromTable)}</b>.{j.fromCol} → <b>{tableLabel(j.toTable)}</b>.{j.toCol}
                  {j.label && <span className="instr-row-label"> ({j.label})</span>}
                </span>
                <button className="instr-row-del" title="삭제" onClick={() => setJoins(prev => prev.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
          </>
        )}

        {tab === 'terms' && (
          <>
            <HintIcon tab="terms" onOpen={setHintPopupTab} />
            {terms.length === 0 && <div className="sb-empty">등록된 용어가 없습니다</div>}
            {terms.map((t, i) => {
              const incomplete = !t.table.trim() || !t.column.trim() || !t.def.trim()
              return (
                <div className={`instr-row${incomplete ? ' instr-row-draft' : ''}`} key={i}>
                  <span className="instr-row-text">
                    {incomplete
                      ? <>✨ "{t.term}" <span className="instr-row-label">— 초안 후보, 테이블·컬럼·설명을 채워주세요</span></>
                      : <><b>{tableLabel(t.table)}</b>.{t.column} = "{t.term}" → {t.def}</>}
                  </span>
                  <button className="instr-row-del" title="삭제" onClick={() => setTerms(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              )
            })}

            <div className="instr-term-browser">
              {projectTables.length === 0 && (
                <div className="instr-hint">이 프로젝트는 테이블 범위가 지정되지 않았습니다 — 사이드바에서 먼저 테이블을 선택하세요.</div>
              )}
              {projectTables.map(table => {
                const cols = columnsCache[table]
                if (!cols) {
                  return columnsLoading[table]
                    ? <div className="instr-hint" key={table}>{tableLabel(table)} 컬럼 불러오는 중…</div>
                    : null
                }
                const existingCols = new Set(terms.filter(t => t.table === table).map(t => t.column))
                const candidates = cols.filter(c => !existingCols.has(c.name) && !isNoiseColumn(c, cols))
                const need    = candidates.filter(needsTerm)
                const covered = candidates.filter(c => !needsTerm(c))
                if (need.length === 0 && covered.length === 0) return null
                return (
                  <div className="instr-term-group" key={table}>
                    <div className="instr-term-group-hdr">
                      {tableLabel(table)}
                      {need.length > 0 && <span className="instr-term-need-badge">{need.length}개 정의 필요</span>}
                    </div>
                    {need.map(c => (
                      <TermQuickRow
                        key={c.name} col={c}
                        active={termDraft.table === table && termDraft.column === c.name}
                        draft={termDraft}
                        onActivate={() => activateTerm(table, c.name)}
                        onChange={setTermDraft}
                        onAdd={addTerm}
                      />
                    ))}
                    {covered.length > 0 && (
                      <details className="instr-term-covered">
                        <summary>이미 설명 있는 컬럼 {covered.length}개 — 그래도 추가하려면 펼치기</summary>
                        {covered.map(c => (
                          <TermQuickRow
                            key={c.name} col={c}
                            active={termDraft.table === table && termDraft.column === c.name}
                            draft={termDraft}
                            onActivate={() => activateTerm(table, c.name)}
                            onChange={setTermDraft}
                            onAdd={addTerm}
                          />
                        ))}
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'examples' && (
          <>
            <HintIcon tab="examples" onOpen={setHintPopupTab} />
            {verifiedCells.length > 0 ? (
              <div className="instr-cellpick-row">
                {verifiedCells.slice(-6).reverse().map(c => (
                  <button
                    type="button"
                    key={c.id}
                    className="instr-cellpick"
                    title="이 셀의 질문·답변을 아래 입력칸에 채웁니다 — 필요하면 고쳐서 쓰세요"
                    onClick={() => setExampleDraft({ question: c.text, answer: c.output!.content })}
                  >
                    ✓ {c.text.slice(0, 28)}{c.text.length > 28 ? '…' : ''}
                  </button>
                ))}
              </div>
            ) : (
              <div className="instr-hint" style={{ paddingTop: 0 }}>
                아직 이 프로젝트에서 실제로 조회에 성공한 셀이 없습니다 — 노트북에서 먼저 질문해보면 여기 후보로 뜹니다.
                그전까지는 아래에서 질문·답변을 직접 입력해 시작할 수 있습니다.
              </div>
            )}
            {examples.length === 0 && <div className="sb-empty">등록된 예시가 없습니다</div>}
            {examples.map((ex, i) => {
              const incomplete = !ex.answer.trim()
              return (
                <div className={`instr-row instr-row-example${incomplete ? ' instr-row-draft' : ''}`} key={i}>
                  <div className="instr-row-text">
                    <div><b>Q.</b> {ex.question}</div>
                    {incomplete
                      ? <div className="instr-row-label">✨ 초안 후보 — 노트북에서 직접 다시 물어보고, 실제 데이터를 확인한 답을 채워주세요</div>
                      : <div className="instr-example-answer"><b>A.</b> {ex.answer}</div>}
                  </div>
                  {incomplete && (
                    <button
                      className="instr-row-del"
                      title="아래 입력칸으로 옮겨서 답 채우기"
                      onClick={() => {
                        setExampleDraft({ question: ex.question, answer: ex.answer })
                        setExamples(prev => prev.filter((_, idx) => idx !== i))
                      }}
                    >
                      ✎
                    </button>
                  )}
                  <button className="instr-row-del" title="삭제" onClick={() => setExamples(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              )
            })}
            <div className="instr-add-col">
              {/* 질문 → 답변 순서로 놓는다 — 답변은 "원하는 형태"를 지어내는 칸이 아니라,
                  노트북에서 실제로 물어봐서 나온 결과를 그대로 옮기는 칸이라는 걸
                  placeholder로도 드러낸다. */}
              <input
                className="proj-new-input"
                placeholder="질문 예시 (이번 분기 매출 상위 5개 거래처는?)"
                value={exampleDraft.question}
                onChange={e => setExampleDraft(d => ({ ...d, question: e.target.value }))}
              />
              <textarea
                className="instr-textarea"
                placeholder="위 쿼리를 실제로 실행해서 나온 답 그대로 (형태 설명 아님 — 지어내지 말고 실제 값 그대로)"
                rows={3}
                value={exampleDraft.answer}
                onChange={e => setExampleDraft(d => ({ ...d, answer: e.target.value }))}
              />
              <button className="btn btn-sm primary instr-add-col-btn" onClick={addExample}>추가</button>
            </div>
          </>
        )}
      </div>

      <div className="instr-panel-ftr">
        <span className="instr-total-count">{totalCount > 0 ? `총 ${totalCount}개 지침` : '등록된 지침 없음'}</span>
        <div className="h-spacer" />
        <button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
      </div>

      {diagramOpen && (
        <RelationshipDiagram
          projectName={projectName}
          projectTables={projectTables}
          joins={joins}
          joinCandidates={joinCandidates}
          columnsByTable={columnsCache}
          tableLabel={tableLabel}
          onAddJoin={addJoinIfNew}
          onClose={() => setDiagramOpen(false)}
        />
      )}
    </div>
  )
}
