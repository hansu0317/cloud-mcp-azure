import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { getInstructionsDraft } from '../api'
import { API } from '../constants'
import type { Instructions, JoinDef, TermDef, ExampleDef } from '../types'

interface Props {
  projectName:   string
  projectTables: string[]
  instructions:  Instructions
  onSave:        (next: Instructions) => Promise<void>
  onClose:       () => void
}

type Tab = 'joins' | 'terms' | 'examples'

interface TableMeta  { name: string; label: string; domain: string }
interface ColumnInfo { name: string; type: string; desc: string; options?: string[] }

const EMPTY_JOIN:    JoinDef    = { fromTable: '', fromCol: '', toTable: '', toCol: '', label: '' }
const EMPTY_TERM:    TermDef    = { table: '', column: '', term: '', def: '' }
const EMPTY_EXAMPLE: ExampleDef = { question: '', answer: '' }

// 질문 예시 탭의 유일한 "직접 입력" 부담을 줄이는 출발점 — 클릭하면 아래 입력칸에
// 그대로 채워지고, 필요한 부분만 고쳐서 쓰면 된다(빈 화면에서 시작하지 않아도 됨).
const EXAMPLE_TEMPLATES: { label: string; ex: ExampleDef }[] = [
  { label: '순위 조회',   ex: { question: '이번 분기 매출 상위 5개 거래처는?',        answer: '거래처 테이블에서 매출액 기준으로 내림차순 정렬해 상위 5개를 표로 보여준다(거래처명·매출액 순).' } },
  { label: '조건 필터링', ex: { question: '활성 상태인 거래처만 보여줘',              answer: '거래처 테이블에서 상태가 활성인 것만 조회해 표로 보여준다.' } },
  { label: '기간 조회',   ex: { question: '이번 달에 새로 등록된 영업기회 보여줘',      answer: '영업기회 테이블에서 등록일이 이번 달인 것만 조회해 표로 보여준다.' } },
  { label: '개수/합계',   ex: { question: '진행중인 영업기회가 총 몇 건이야?',         answer: '영업기회 테이블에서 상태가 진행중인 건의 개수를 세어 알려준다.' } },
]

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

// 조인 탭(2회) · 용어 탭(1회)에서 반복되던 "테이블 선택" 드롭다운을 하나로 통합.
function TableSelect({ value, catalog, domains, onChange }: {
  value: string; catalog: TableMeta[]; domains: string[]; onChange: (table: string) => void
}) {
  return (
    <select className="instr-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">테이블 선택…</option>
      {domains.map(domain => (
        <optgroup label={domain} key={domain}>
          {catalog.filter(t => t.domain === domain).map(t => (
            <option value={t.name} key={t.name}>{t.label} ({t.name})</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// 마찬가지로 반복되던 "컬럼 선택" 드롭다운 통합.
function ColumnSelect({ value, columns, loading, onChange }: {
  value: string; columns: ColumnInfo[]; loading: boolean; onChange: (col: string) => void
}) {
  return (
    <select className="instr-select" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{loading ? '불러오는 중…' : '컬럼 선택…'}</option>
      {columns.map(c => (
        <option value={c.name} key={c.name}>{c.name} — {c.desc}</option>
      ))}
    </select>
  )
}

// "지침" 설정 팝업 — 테이블 조인 관계·컬럼 용어·질문 예시를 등록하면 서버가 매 질문의
// 시스템 프롬프트에 최신 저장값을 넣어 모델이 참고한다. TableScopeModal과
// 같은 모달 셸(.ts-modal*)을 재사용해 기존 UI 톤을 그대로 유지한다.
//
// 조인·용어 탭은 테이블/컬럼의 정확한 논리명(new_q3, customerid 같은)을 몰라도 되도록
// ①②③… 순서로 드롭다운을 채워나가는 방식이다 — 카탈로그(GET /api/tables)와 컬럼
// 설명(GET /api/describe)을 그대로 재사용해 새 서버 코드 없이 프론트에서만 구현했다.
export default function InstructionsModal({ projectName, projectTables, instructions, onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('joins')
  const [joins,    setJoins]    = useState<JoinDef[]>(instructions.joins)
  const [terms,    setTerms]    = useState<TermDef[]>(instructions.terms)
  const [examples, setExamples] = useState<ExampleDef[]>(instructions.examples)
  const [saving, setSaving] = useState(false)

  const [joinDraft,    setJoinDraft]    = useState<JoinDef>(EMPTY_JOIN)
  const [termDraft,    setTermDraft]    = useState<TermDef>(EMPTY_TERM)
  const [exampleDraft, setExampleDraft] = useState<ExampleDef>(EMPTY_EXAMPLE)

  const [draftLoading, setDraftLoading] = useState(false)
  const [draftMsg,      setDraftMsg]     = useState<string | null>(null)

  // 테이블 목록 + 컬럼 설명 캐시 — 드롭다운을 채우는 용도. 컬럼은 테이블을 고른
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

  // 프로젝트가 테이블 범위를 지정해뒀으면(대부분 그렇다) 그 테이블들로만 관계·용어
  // 드롭다운을 제한한다 — 범위 밖 테이블을 가리키는 지침은 실제 조회에서 쓸 수 없어서
  // 애초에 고를 수 없게 막는 게 낫다. 범위가 비어있으면(= 전체 허용) 전체 카탈로그를 그대로 쓴다.
  const scopedCatalog = useMemo(
    () => (projectTables.length > 0 ? catalog.filter(t => projectTables.includes(t.name)) : catalog),
    [catalog, projectTables],
  )
  const domains = useMemo(() => [...new Set(scopedCatalog.map(t => t.domain))], [scopedCatalog])

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

  // 실제 질문/답변 로그에서 뽑은 후보를 기존 목록에 이어 붙인다(덮어쓰지 않음) —
  // 저장은 안 하고 화면에만 미리 채워주므로, 사람이 훑어보고 지우거나 고친 뒤
  // "저장"을 눌러야 실제로 반영된다. joins는 서버가 항상 빈 배열을 주므로 손댈 게 없음
  // (Lookup 대상 엔티티 조회가 필요해 다음 스프린트로 미룸).
  const handleGenerateDraft = async () => {
    setDraftLoading(true)
    setDraftMsg(null)
    try {
      const draft = await getInstructionsDraft()

      const existingTerms = new Set(terms.map(t => t.term))
      const newTerms = draft.terms.filter(t => !existingTerms.has(t.term))
      if (newTerms.length > 0) setTerms(prev => [...prev, ...newTerms])

      const existingQuestions = new Set(examples.map(e => e.question))
      const newExamples = draft.examples.filter(e => !existingQuestions.has(e.question))
      if (newExamples.length > 0) setExamples(prev => [...prev, ...newExamples])

      setDraftMsg(
        newTerms.length === 0 && newExamples.length === 0
          ? '실제 로그에서 새 후보를 찾지 못했습니다 (질문을 좀 더 쌓은 뒤 다시 시도해보세요)'
          : `용어 후보 ${newTerms.length}개 · 예시 후보 ${newExamples.length}개를 추가했습니다 — 검토 후 저장하세요`,
      )
      if (newTerms.length > 0) setTab('terms')
      else if (newExamples.length > 0) setTab('examples')
    } catch {
      setDraftMsg('초안 생성에 실패했습니다. 잠시 후 다시 시도하세요.')
    } finally {
      setDraftLoading(false)
    }
  }

  const addJoin = () => {
    if (!joinDraft.fromTable.trim() || !joinDraft.fromCol.trim() || !joinDraft.toTable.trim() || !joinDraft.toCol.trim()) return
    setJoins(prev => [...prev, { ...joinDraft }])
    setJoinDraft(EMPTY_JOIN)
  }
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

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({ joins, terms, examples })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const totalCount = joins.length + terms.length + examples.length

  const tableLabel = (name: string) => catalog.find(t => t.name === name)?.label
  const columnDesc = (table: string, col: string) => columnsCache[table]?.find(c => c.name === col)?.desc

  const termColumns = columnsCache[termDraft.table] ?? []
  const termColumnOptions = termColumns.find(c => c.name === termDraft.column)?.options

  return createPortal(
    <div className="ts-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ts-modal-inner instr-modal-inner">
        <div className="ts-modal-hdr">
          <div>
            <div className="ts-modal-title">
              "{projectName}"의 지침
              <span className="instr-title-help" title="지침은 AI를 다시 학습시키는 게 아닙니다. 이 프로젝트에서 질문할 때마다 '우리는 이런 규칙을 씁니다'라는 메모를 자동으로 같이 보여주는 기능이에요. 다른 프로젝트에는 영향을 주지 않습니다. 아래 내용은 대부분 목록에서 고르기만 하면 됩니다.">ⓘ</span>
            </div>
            <div className="ts-modal-sub">테이블 연결·용어·예시를 알려주면 이 프로젝트의 질문마다 자동으로 참고해 답변 품질이 좋아집니다</div>
          </div>
          <div className="instr-hdr-actions">
            <button
              className="btn btn-xs"
              onClick={handleGenerateDraft}
              disabled={draftLoading}
              title="실제 질문/답변 로그에서 용어·예시 후보를 뽑아 채워줍니다 (저장 전 검토 필요)"
            >
              {draftLoading ? '⏳ 생성 중…' : '✨ 초안 생성'}
            </button>
            <button className="btn btn-xs" onClick={onClose}>✕</button>
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

        <div className="ts-modal-body instr-modal-body">
          {tab === 'joins' && (
            <>
              <div className="instr-hint">
                <b>언제 필요한가요?</b> "영업기회랑 거래처를 같이 보여줘"처럼 <b>테이블 두 개를 엮는 질문</b>에서 AI가 자꾸 틀린다면,
                어떤 테이블의 어떤 컬럼끼리 연결되는지 알려주세요. 전부 목록에서 고르기만 하면 됩니다.
              </div>
              <div className="instr-hint instr-hint-todo">✨ 초안 생성은 아직 테이블 연결을 채워주지 않습니다 — Lookup 컬럼이 실제로 어느 테이블을 가리키는지 Dataverse에서 별도로 조회해야 해서 다음 작업으로 미뤄뒀습니다. 지금은 아래에서 직접 골라주세요.</div>
              {joins.length === 0 && <div className="sb-empty">등록된 테이블 연결이 없습니다</div>}
              {joins.map((j, i) => (
                <div className="instr-row" key={i}>
                  <span className="instr-row-text">
                    <b>{tableLabel(j.fromTable) ?? j.fromTable}</b>.{j.fromCol} → <b>{tableLabel(j.toTable) ?? j.toTable}</b>.{j.toCol}
                    {j.label && <span className="instr-row-label"> ({j.label})</span>}
                  </span>
                  <button className="instr-row-del" title="삭제" onClick={() => setJoins(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}

              <div className="instr-wizard">
                <div className="instr-step">
                  <span className="instr-step-num">1</span>
                  <div className="instr-step-body">
                    <label className="instr-step-q">어떤 테이블에서 시작할까요?</label>
                    <TableSelect
                      value={joinDraft.fromTable}
                      catalog={scopedCatalog}
                      domains={domains}
                      onChange={v => { setJoinDraft(d => ({ ...d, fromTable: v, fromCol: '' })); ensureColumns(v) }}
                    />
                  </div>
                </div>

                {joinDraft.fromTable && (
                  <div className="instr-step">
                    <span className="instr-step-num">2</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">그 테이블의 어떤 컬럼인가요?</label>
                      <ColumnSelect
                        value={joinDraft.fromCol}
                        columns={columnsCache[joinDraft.fromTable] ?? []}
                        loading={!!columnsLoading[joinDraft.fromTable]}
                        onChange={v => setJoinDraft(d => ({ ...d, fromCol: v }))}
                      />
                    </div>
                  </div>
                )}

                {joinDraft.fromCol && (
                  <div className="instr-step">
                    <span className="instr-step-num">3</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">어떤 테이블과 연결되나요?</label>
                      <TableSelect
                        value={joinDraft.toTable}
                        catalog={scopedCatalog}
                        domains={domains}
                        onChange={v => { setJoinDraft(d => ({ ...d, toTable: v, toCol: '' })); ensureColumns(v) }}
                      />
                    </div>
                  </div>
                )}

                {joinDraft.toTable && (
                  <div className="instr-step">
                    <span className="instr-step-num">4</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">그 테이블의 어떤 컬럼인가요?</label>
                      <ColumnSelect
                        value={joinDraft.toCol}
                        columns={columnsCache[joinDraft.toTable] ?? []}
                        loading={!!columnsLoading[joinDraft.toTable]}
                        onChange={v => setJoinDraft(d => ({ ...d, toCol: v }))}
                      />
                    </div>
                  </div>
                )}

                {joinDraft.toCol && (
                  <div className="instr-step">
                    <span className="instr-step-num">5</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">이 관계를 뭐라고 부르면 좋을까요? (선택)</label>
                      <input
                        className="proj-new-input instr-select"
                        placeholder="예: 거래처"
                        value={joinDraft.label}
                        onChange={e => setJoinDraft(d => ({ ...d, label: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') addJoin() }}
                      />
                      <button className="btn btn-sm primary instr-step-add" onClick={addJoin}>이 관계 추가</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'terms' && (
            <>
              <div className="instr-hint">
                <b>언제 필요한가요?</b> 컬럼에 저장된 <b>숫자 코드나 값이 실제로 무슨 뜻인지</b> AI가 모를 때 알려주세요.
                선택지(Picklist)가 있는 컬럼은 클릭 한 번으로 끝나고, 그 외에는 짧은 설명만 적으면 됩니다.
              </div>
              {terms.length === 0 && <div className="sb-empty">등록된 용어가 없습니다</div>}
              {terms.map((t, i) => {
                const incomplete = !t.table.trim() || !t.column.trim() || !t.def.trim()
                return (
                  <div className={`instr-row${incomplete ? ' instr-row-draft' : ''}`} key={i}>
                    <span className="instr-row-text">
                      {incomplete
                        ? <>✨ "{t.term}" <span className="instr-row-label">— 초안 후보, 테이블·컬럼·설명을 채워주세요</span></>
                        : <><b>{tableLabel(t.table) ?? t.table}</b>.{t.column} = "{t.term}" → {t.def}</>}
                    </span>
                    <button className="instr-row-del" title="삭제" onClick={() => setTerms(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                  </div>
                )
              })}

              <div className="instr-wizard">
                <div className="instr-step">
                  <span className="instr-step-num">1</span>
                  <div className="instr-step-body">
                    <label className="instr-step-q">어떤 테이블인가요?</label>
                    <TableSelect
                      value={termDraft.table}
                      catalog={scopedCatalog}
                      domains={domains}
                      onChange={v => { setTermDraft(d => ({ ...d, table: v, column: '' })); ensureColumns(v) }}
                    />
                  </div>
                </div>

                {termDraft.table && (
                  <div className="instr-step">
                    <span className="instr-step-num">2</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">그 테이블의 어떤 컬럼인가요?</label>
                      <ColumnSelect
                        value={termDraft.column}
                        columns={termColumns}
                        loading={!!columnsLoading[termDraft.table]}
                        onChange={v => setTermDraft(d => ({ ...d, column: v, term: '' }))}
                      />
                    </div>
                  </div>
                )}

                {termDraft.column && (
                  <div className="instr-step">
                    <span className="instr-step-num">3</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">업무에서는 이 컬럼 값을 뭐라고 부르나요?</label>
                      {termColumnOptions && (
                        <>
                          <div className="instr-hint" style={{ padding: '0 0 6px' }}>
                            {columnDesc(termDraft.table, termDraft.column)}에 등록된 선택값입니다 — <b>클릭 한 번이면 타이핑 없이 바로 추가됩니다</b>
                          </div>
                          <div className="instr-chip-row">
                            {termColumnOptions.map(opt => (
                              <button
                                type="button"
                                key={opt}
                                className={`instr-chip${termDraft.term === opt ? ' active' : ''}`}
                                onClick={() => setTermDraft(d => ({ ...d, term: opt, def: opt }))}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                      <input
                        className="proj-new-input instr-select"
                        placeholder="예: 진행중 (또는 위에서 선택)"
                        value={termDraft.term}
                        onChange={e => setTermDraft(d => ({ ...d, term: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                {termDraft.term && (
                  <div className="instr-step">
                    <span className="instr-step-num">4</span>
                    <div className="instr-step-body">
                      <label className="instr-step-q">
                        {termColumnOptions ? '설명을 그대로 쓰거나, 더 자세히 고쳐도 됩니다' : '그게 정확히 어떤 뜻인가요?'}
                      </label>
                      <input
                        className="proj-new-input instr-select"
                        placeholder="예: 값이 1이면 진행중 상태"
                        value={termDraft.def}
                        onChange={e => setTermDraft(d => ({ ...d, def: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') addTerm() }}
                      />
                      <button className="btn btn-sm primary instr-step-add" onClick={addTerm}>이 용어 추가</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'examples' && (
            <>
              <div className="instr-hint">
                <b>언제 필요한가요?</b> 같은 유형의 질문에 AI가 매번 다르게 답하거나 자꾸 헤맬 때, "이런 질문엔 이렇게 답해줘"라는
                대표 예시를 하나 등록해두세요. 위의 "✨ 초안 생성"이 실제 로그에서 후보를 찾아주거나, 아래 템플릿으로 바로 시작할 수도 있습니다.
              </div>
              <div className="instr-chip-row" style={{ padding: '0 10px 10px' }}>
                {EXAMPLE_TEMPLATES.map(t => (
                  <button
                    type="button"
                    key={t.label}
                    className="instr-chip"
                    onClick={() => setExampleDraft(t.ex)}
                    title="누르면 아래 입력칸에 그대로 채워집니다 — 단어만 바꿔서 쓰세요"
                  >
                    ✨ {t.label}
                  </button>
                ))}
              </div>
              {examples.length === 0 && <div className="sb-empty">등록된 예시가 없습니다</div>}
              {examples.map((ex, i) => (
                <div className="instr-row instr-row-example" key={i}>
                  <div className="instr-row-text">
                    <div><b>Q.</b> {ex.question}</div>
                    <div className="instr-example-answer"><b>A.</b> {ex.answer}</div>
                  </div>
                  <button className="instr-row-del" title="삭제" onClick={() => setExamples(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              <div className="instr-add-col">
                <input
                  className="proj-new-input"
                  placeholder="질문 예시 (이번 분기 매출 상위 5개 거래처는?)"
                  value={exampleDraft.question}
                  onChange={e => setExampleDraft(d => ({ ...d, question: e.target.value }))}
                />
                <textarea
                  className="instr-textarea"
                  placeholder="원하는 답변 형태 (표로, 거래처명·매출액 순으로…)"
                  rows={3}
                  value={exampleDraft.answer}
                  onChange={e => setExampleDraft(d => ({ ...d, answer: e.target.value }))}
                />
                <button className="btn btn-sm primary instr-add-col-btn" onClick={addExample}>추가</button>
              </div>
            </>
          )}
        </div>

        <div className="ts-modal-ftr">
          <span className="instr-total-count">{totalCount > 0 ? `총 ${totalCount}개 지침` : '등록된 지침 없음'}</span>
          <div className="h-spacer" />
          <button className="btn" onClick={onClose} disabled={saving}>취소</button>
          <button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
