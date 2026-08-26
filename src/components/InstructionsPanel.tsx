import { useEffect, useMemo, useRef, useState } from 'react'
import { API } from '../constants'
import { NOISE_COLUMN_RE, joinKey } from '../lib/schemaColumns'
import type { Cell, Instructions, JoinDef, TermDef, ExampleDef } from '../types'

interface Props {
  collapsed:        boolean
  projectId:        string
  projectName:      string
  projectTables:    string[]
  // 테이블 스코프 저장이 실제로 서버에 반영된 뒤(성공 응답의 새 updatedAt)에만
  // "관계를 찾았습니다" 후보를 다시 신뢰할 수 있다 — App.tsx의 saveProjectFieldWithRetry
  // 참고. projectTables만 의존하면 로컬 낙관적 갱신 시점(저장 전)에도 후보를 다시
  // 불러와서, 그 요청이 서버 저장보다 먼저 도착하면 옛 테이블 기준 후보가 그대로
  // 남는 경합이 있었다(2026-08-26 실측).
  projectUpdatedAt: string
  instructions:     Instructions
  cells:            Cell[]
  onSave:           (next: Instructions) => Promise<void>
  showToast:        (msg: string) => void
}

type Tab = 'joins' | 'terms' | 'examples'

interface TableMeta  { name: string; label: string; domain: string }
interface ColumnInfo { name: string; type: string; desc: string; options?: string[] }

const EMPTY_TERM:    TermDef    = { table: '', column: '', term: '', def: '' }
const EMPTY_EXAMPLE: ExampleDef = { question: '', answer: '' }

// "작은 화면에 너무 복잡해 보인다"는 피드백(2026-08-24) — 패널 고정폭(360px)이 테이블
// 연결·용어·예시를 다 담기엔 좁아서 줄바꿈·겹침이 잦았다. 폭을 늘리는 것만으론 화면
// 크기가 제각각인 사람들을 다 만족 못 시키므로, 기본폭을 좀 넉넉히 늘리고 + 드래그로
// 직접 조절할 수 있게 한다(리사이즈 핸들, VS Code 사이드바와 같은 패턴). localStorage에
// 저장해서 다음에 열 때도 유지된다.
const PANEL_WIDTH_KEY     = 'crm-ai-chat:instrPanelWidth'
const PANEL_WIDTH_DEFAULT = 420
const PANEL_WIDTH_MIN     = 340
const PANEL_WIDTH_MAX     = 720

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
  joins: '테이블 두 개를 엮는 질문에서 AI가 틀린다면 연결을 알려주세요. 전부 Dataverse가 이미 아는 실제 연결(FK)만 보여드리니, SQL을 몰라도 목록에서 눌러서 추가하기만 하면 됩니다 — 직접 정의할 필요는 없어요.',
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

// 연결 한 줄 — 예전엔 줄마다 "설명 없으면 ＋설명 추가" 프롬프트를 항상 띄워서
// 목록(특히 여러 개일 때)이 너무 길어 보인다는 피드백(2026-08-24)을 받았다. 값이
// 있을 때만 짧게 보여주는 건 그대로 두되(없으면 그냥 표시할 게 없는 것), 설명
// 입력칸은 다이어그램 제거(2026-08-26)로 갈 곳이 없어져서 이 행 안의 ✎ 아이콘으로
// 옮겼다 — 눌러야만 입력칸이 뜨는 TermQuickRow와 같은 "평소엔 숨김" 패턴.
function JoinRow({ join, fromLabel, toLabel, fromColLabel, onDelete, onSaveLabel }: {
  join: JoinDef; fromLabel: string; toLabel: string; fromColLabel: string
  onDelete?: () => void      // 없으면(읽기 전용) 삭제 버튼 자체를 안 그린다
  onSaveLabel?: (label: string) => void   // 없으면(읽기 전용) 설명 편집 자체를 안 그린다
}) {
  // 같은 테이블을 가리키는 자기참조 연결(예: 거래처의 "상위 거래처")은 위 굵은
  // 줄이 "거래처 → 거래처"로 뭉개져서 무슨 관계인지 사라진다 — 그 경우만 연결고리
  // 컬럼의 한국어 뜻을 굵은 줄에 같이 보여준다.
  const selfRef = fromLabel === toLabel && fromColLabel !== join.fromCol
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(join.label ?? '')

  const save = () => { onSaveLabel?.(draft.trim()); setEditing(false) }

  return (
    <div className="instr-join-row">
      <div className="instr-join-row-main">
        <span className="instr-join-row-tables">
          <b>{fromLabel}</b> → <b>{toLabel}</b>
          {selfRef && <span className="instr-join-row-selfnote"> · {fromColLabel} 기준</span>}
        </span>
        <div className="instr-join-row-actions">
          {onSaveLabel && !editing && (
            <button
              className="instr-row-edit" title="설명 추가/수정"
              onClick={() => { setDraft(join.label ?? ''); setEditing(true) }}
            >
              ✎
            </button>
          )}
          {onDelete && <button className="instr-row-del" title="삭제" onClick={onDelete}>×</button>}
        </div>
      </div>
      <div className="instr-join-row-cols">
        .{join.fromCol} → .{join.toCol}
        {!editing && join.label && <span className="instr-join-row-label"> · {join.label}</span>}
      </div>
      {editing && (
        <div className="instr-join-row-labelform">
          <input
            className="proj-new-input instr-select"
            placeholder="설명 (예: 어느 거래처의 영업기회인지) — 없어도 됩니다"
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }}
          />
          <button type="button" className="btn btn-sm primary" onClick={save}>저장</button>
        </div>
      )}
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
export default function InstructionsPanel({ collapsed, projectId, projectName, projectTables, projectUpdatedAt, instructions, cells, onSave, showToast }: Props) {
  const [tab, setTab] = useState<Tab>('joins')
  const [joins,    setJoins]    = useState<JoinDef[]>(instructions.joins)
  const [terms,    setTerms]    = useState<TermDef[]>(instructions.terms)
  const [examples, setExamples] = useState<ExampleDef[]>(instructions.examples)
  const [saving, setSaving] = useState(false)

  const [termDraft,    setTermDraft]    = useState<TermDef>(EMPTY_TERM)
  const [exampleDraft, setExampleDraft] = useState<ExampleDef>(EMPTY_EXAMPLE)

  // 탭 설명 팝업 — 물음표 아이콘을 눌렀을 때만 연다(자동으로 뜨지 않음).
  const [hintPopupTab, setHintPopupTab] = useState<Tab | null>(null)

  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
      if (saved >= PANEL_WIDTH_MIN && saved <= PANEL_WIDTH_MAX) return saved
    } catch { /* localStorage 접근 불가(프라이빗 모드 등) — 기본값 사용 */ }
    return PANEL_WIDTH_DEFAULT
  })
  const resizingRef = useRef(false)
  // 접혔다 펼쳐질 때의 슬라이드 애니메이션(.instr-panel의 transition: width)이 드래그
  // 중에도 그대로 걸리면 마우스를 따라오지 못하고 한 박자 늦게(고무줄처럼) 움직인다 —
  // 드래그하는 동안만 transition을 꺼야 한다.
  const [isResizing, setIsResizing] = useState(false)
  // 패널이 화면 오른쪽에 붙어 있어서, 왼쪽 가장자리(핸들)를 왼쪽으로 끌수록(마우스 X가
  // 줄어들수록) 폭이 늘어난다 — startX와의 차이를 그대로 더한다.
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    setIsResizing(true)
    const startX = e.clientX
    const startWidth = panelWidth
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      setPanelWidth(Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, startWidth + (startX - ev.clientX))))
    }
    const onUp = () => {
      resizingRef.current = false
      setIsResizing(false)
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      setPanelWidth(w => {
        try { localStorage.setItem(PANEL_WIDTH_KEY, String(w)) } catch { /* 저장 실패해도 이번 세션 폭은 유지됨 */ }
        return w
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // "등록된 목록"과 "새로 추가하는 UI"가 한 화면에 뒤섞여 보여서 헷갈린다는 피드백
  // (2026-08-24) — 용어·예시 탭은 추가 UI를 접을 수 있는 섹션으로 분리한다. 처음 쓰는
  // 사람(아직 하나도 등록 안 함)에게는 기본으로 펼쳐서 바로 추가하게 안내하고,
  // 이미 등록된 게 있으면 접어서 등록된 목록만 깔끔하게 보여준다. 조인 탭도
  // joinAddOpen으로 같은 패턴을 쓴다(아래 참고).
  const [termAddOpen,    setTermAddOpen]    = useState(() => terms.length === 0)
  const [exampleAddOpen, setExampleAddOpen] = useState(() => examples.length === 0)

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

  // 용어 탭과 조인 탭(수동 추가 드롭다운에 컬럼 목록이 필요)을 열 때 이 프로젝트의
  // 테이블 전부를 한 번에 불러온다. 이미 불러온 테이블은 ensureColumns가 다시 안 건드린다.
  useEffect(() => {
    if (tab !== 'terms' && tab !== 'joins') return
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
    // projectUpdatedAt도 의존성에 둔다 — 테이블을 바꾼 직후(로컬 낙관적 갱신, 아직
    // 서버 저장 전이라 옛 후보일 수 있음) 한 번 + 그 저장이 실제로 끝나
    // updatedAt이 갱신된 뒤(서버가 최신 스코프로 다시 계산한 권위 있는 결과) 한 번,
    // 이렇게 두 번 불러오게 해서 경합을 없앤다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, projectTables.join(','), projectUpdatedAt])

  // 후보 카드 클릭이나 다이어그램에서 만든 연결 — 위저드 없이 여기서 바로 만들어지므로 중복만 막는다.
  const addJoinIfNew = (join: JoinDef) => {
    setJoins(prev => (prev.some(j => joinKey(j) === joinKey(join)) ? prev : [...prev, join]))
  }

  // 이미 등록된 건 후보 목록에서 뺀다 — "관계를 찾았습니다" 섹션엔 아직 안 넣은 것만
  // 남는다. SQL을 모르는 사람은 테이블.컬럼을 직접 고르는 것보다 "이런 관계를
  // 찾았어요, 눌러서 추가하세요" 쪽이 훨씬 쉬우므로(2026-08-24 피드백) 이 섹션을
  // 아래 "다이어그램에서 새 연결 만들기" 버튼보다 먼저, 항상 펼쳐진 채로 보여준다.
  const joinCandidatesToShow = useMemo(
    () => joinCandidates.filter(c => !joins.some(j => joinKey(j) === joinKey(c))),
    [joinCandidates, joins],
  )

  // 다이어그램(드래그앤드롭 캔버스, 최대 2테이블 제한)을 없앴다(2026-08-26) — 다시
  // 보니 다이어그램이 위 자동 후보 대비 실제로 더 해주는 일이 없었다. 유일한 차이는
  // 아무 Lookup 컬럼이나 캔버스에 놓인 아무 테이블에나 드래그해 "이 컬럼이 이
  // 테이블을 가리킨다"고 실제 FK 여부와 무관하게 우길 수 있던 자유도인데, 이건
  // 기능이라기보다 잘못된 관계를 등록하기 쉬운 허점에 가까웠다. 대신 같은 자동 후보
  // 데이터를 테이블별로 묶어 펼쳐보는 목록으로 대체한다 — "용어 뜻" 탭의
  // instr-term-group과 같은 모양이라 새로 배울 게 없다.
  const joinCandidatesByTable = useMemo(() => {
    const byTable = new Map<string, JoinDef[]>()
    for (const c of joinCandidatesToShow) {
      const list = byTable.get(c.fromTable)
      if (list) list.push(c); else byTable.set(c.fromTable, [c])
    }
    // Map 삽입 순서 대신 projectTables(사이드바 트리와 같은 순서)를 그대로 따른다.
    return projectTables.filter(t => byTable.has(t)).map(t => [t, byTable.get(t)!] as const)
  }, [joinCandidatesToShow, projectTables])

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
  //
  // onSave(App.tsx의 handleSaveInstructions)는 서버 PATCH가 실패하면 이제 예외를
  // 던진다(2026-08-24 이전엔 api.ts의 updateProject가 응답 상태를 아예 안 봐서, 서버가
  // 저장을 거부해도 화면은 "지침이 저장됐습니다" 토스트까지 그대로 떴다 — "저장을
  // 눌러도 반영이 안 된다"는 피드백의 실제 원인). 여기서 잡아서 성공한 척하지 않고
  // 에러를 보여준다 — 실패 시 draftMsg도 건드리지 않아 "저장 안 된 것들" 안내가
  // 사라지지 않는다.
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
    } catch (err) {
      showToast(`저장 실패 — ${err instanceof Error ? err.message : '네트워크를 확인해주세요'}`)
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
  // 자동 후보를 보여주는 곳이 이제 이 섹션 하나뿐이라(2026-08-26 — "관계를 찾았습니다"를
  // 따로 또 보여주는 게 헷갈린다는 피드백으로 통합), 용어·예시 탭과 같은 규칙을 그대로
  // 적용한다: 아직 등록된 연결이 없으면 기본으로 펼쳐서 바로 보여준다.
  const [joinAddOpen, setJoinAddOpen] = useState(() => joins.length === 0)

  const tableLabel = (name: string) => catalog.find(t => t.name === name)?.label ?? name

  // 컬럼 raw name(new_l_parentaccountid 등)만으론 뭘 가리키는지 알기 어려워서,
  // describe 캐시의 한국어 설명(desc)을 찾아 라벨로 보여준다 — 자기참조 연결에서
  // JoinRow가 이걸로 구분한다.
  const columnLabel = (table: string, col: string): string => {
    const info = (columnsCache[table] ?? []).find(c => c.name === col)
    if (!info?.desc) return col
    return info.desc.split(' — ')[0].replace(/\s*\(.*\)\s*$/, '').trim() || col
  }

  return (
    <div
      className={`instr-panel${collapsed ? ' collapsed' : ''}${isResizing ? ' resizing' : ''}`}
      style={{ width: collapsed ? 0 : panelWidth }}
    >
      {!collapsed && (
        <div
          className="instr-resize-handle"
          onMouseDown={handleResizeStart}
          title="드래그해서 패널 너비 조절"
        />
      )}
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
            <HintIcon tab="joins" onOpen={setHintPopupTab} />
            {projectTables.length === 0 && (
              <div className="instr-hint" style={{ paddingTop: 0 }}>
                이 프로젝트는 테이블이 하나도 선택되지 않았습니다 — 사이드바 "＋테이블"에서 먼저 테이블을 골라야 여기서 연결을 만들 수 있습니다.
              </div>
            )}

            {/* 등록된 연결 — 저장된 것만, 항상 맨 위. 자동 후보는 아래 "테이블에서 찾아
                추가하기"(펼침 섹션) 한 곳에만 모아둔다 — 예전엔 이 목록 바로 아래
                "관계를 찾았습니다"(항상 펼침)를 따로 또 뒀는데, 같은 데이터를 두
                자리에서 보여주는 게 오히려 헷갈린다는 피드백(2026-08-26)으로 하나로
                합쳤다. */}
            <div className="instr-section-title">
              등록된 연결{joins.length > 0 && <span className="instr-section-count">{joins.length}</span>}
            </div>
            {joins.length === 0 && <div className="sb-empty">등록된 연결이 없습니다</div>}
            {joins.map((j, i) => (
              <JoinRow
                key={`s-${i}`}
                join={j}
                fromLabel={tableLabel(j.fromTable)}
                toLabel={tableLabel(j.toTable)}
                fromColLabel={columnLabel(j.fromTable, j.fromCol)}
                onDelete={() => setJoins(prev => prev.filter((_, idx) => idx !== i))}
                onSaveLabel={label => setJoins(prev => prev.map((jj, idx) => (idx === i ? { ...jj, label } : jj)))}
              />
            ))}
          </>
        )}

        {tab === 'terms' && (
          <>
            <HintIcon tab="terms" onOpen={setHintPopupTab} />
            <div className="instr-section-title">
              등록된 용어{terms.length > 0 && <span className="instr-section-count">{terms.length}</span>}
            </div>
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

            {projectTables.length === 0 && (
              <div className="instr-hint">이 프로젝트는 테이블 범위가 지정되지 않았습니다 — 사이드바에서 먼저 테이블을 선택하세요.</div>
            )}
          </>
        )}

        {tab === 'examples' && (
          <>
            <HintIcon tab="examples" onOpen={setHintPopupTab} />

            {/* 1) 등록된 예시 — 저장된 것만, 항상 맨 위. */}
            <div className="instr-section-title">
              등록된 예시{examples.length > 0 && <span className="instr-section-count">{examples.length}</span>}
            </div>
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
                        setExampleAddOpen(true)
                      }}
                    >
                      ✎
                    </button>
                  )}
                  <button className="instr-row-del" title="삭제" onClick={() => setExamples(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* 등록된 목록이 길어질수록 "추가하기" 토글이 화면 아래로 밀려나 안 보이게 된다는
          피드백(2026-08-24) — 스크롤되는 목록(.instr-panel-body) 밖, 저장 버튼
          바로 위에 항상 붙여둔다. 펼쳤을 때 내용이 길면(용어 탭의 테이블별 컬럼 등)
          이 영역 자체가 자기 스크롤을 가진다(.instr-add-pinned-body). */}
      {/* 다이어그램(드래그앤드롭 캔버스) 제거(2026-08-26) — Dataverse 실제 FK 기반 자동
          후보(joinCandidates)를 테이블별로 묶어 펼쳐보는 이 목록 하나로 통일했다.
          예전엔 이 위에 "관계를 찾았습니다"(항상 펼침, 같은 데이터의 평평한 목록)를
          따로 또 뒀는데, 같은 걸 두 자리에서 보여주는 게 오히려 헷갈린다는
          피드백(2026-08-26)으로 없앴다. "용어 뜻" 탭의
          instr-term-browser/instr-term-group과 같은 패턴이라 새로 배울 게 없다. */}
      {tab === 'joins' && projectTables.length > 0 && (
        <div className="instr-add-pinned">
          <button type="button" className="instr-add-toggle" onClick={() => setJoinAddOpen(o => !o)}>
            <span>➕ 테이블에서 찾아 추가하기</span>
            <span className="instr-add-toggle-arrow">{joinAddOpen ? '▾' : '▸'}</span>
          </button>
          {joinAddOpen && (
            <div className="instr-add-pinned-body">
              <div className="instr-field-label">
                Dataverse에 실제로 있는 관계(FK)만 보여드립니다 — 눌러서 추가하세요, 직접 설정할 필요 없어요
              </div>
              <div className="instr-term-browser">
                {joinCandidatesByTable.length === 0 ? (
                  <div className="instr-hint" style={{ padding: '0 0 4px' }}>
                    더 찾을 연결이 없습니다 — 등록되지 않은 실제 관계(FK)가 이 프로젝트
                    테이블 사이에 없습니다.
                  </div>
                ) : joinCandidatesByTable.map(([table, candidates]) => (
                  <div className="instr-term-group" key={table}>
                    <div className="instr-term-group-hdr">{tableLabel(table)}</div>
                    {candidates.map((c, i) => (
                      <button
                        type="button" key={i} className="instr-term-row-btn"
                        title="Dataverse에 실제로 있는 관계(FK)에서 찾았습니다 — 클릭하면 추가됩니다"
                        onClick={() => addJoinIfNew(c)}
                      >
                        <span className="instr-term-row-col">.{c.fromCol}</span>
                        <span className="instr-term-row-desc">
                          → {c.fromTable === c.toTable ? '같은 테이블(자기참조)' : tableLabel(c.toTable)}
                        </span>
                        <span className="instr-term-row-plus">＋</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'terms' && projectTables.length > 0 && (
        <div className="instr-add-pinned">
          <button type="button" className="instr-add-toggle" onClick={() => setTermAddOpen(o => !o)}>
            <span>➕ 컬럼에서 찾아 추가하기</span>
            <span className="instr-add-toggle-arrow">{termAddOpen ? '▾' : '▸'}</span>
          </button>
          {termAddOpen && (
            <div className="instr-add-pinned-body">
              <div className="instr-term-browser">
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
            </div>
          )}
        </div>
      )}

      {tab === 'examples' && (
        <div className="instr-add-pinned">
          <button type="button" className="instr-add-toggle" onClick={() => setExampleAddOpen(o => !o)}>
            <span>➕ 새 예시 추가하기</span>
            <span className="instr-add-toggle-arrow">{exampleAddOpen ? '▾' : '▸'}</span>
          </button>
          {exampleAddOpen && (
            <div className="instr-add-pinned-body">
              <div className="instr-add-col">
                {verifiedCells.length > 0 ? (
                  <>
                    <div className="instr-field-label">노트북에서 가져오기 — 눌러서 아래 칸에 채우기</div>
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
                  </>
                ) : (
                  <div className="instr-hint" style={{ padding: '0 0 4px' }}>
                    아직 이 프로젝트에서 실제로 조회에 성공한 셀이 없습니다 — 노트북에서 먼저 질문해보면 여기 후보로 뜹니다.
                    그전까지는 아래에서 질문·답변을 직접 입력해 시작할 수 있습니다.
                  </div>
                )}
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
            </div>
          )}
        </div>
      )}

      <div className="instr-panel-ftr">
        <span className="instr-total-count">{totalCount > 0 ? `총 ${totalCount}개 지침` : '등록된 지침 없음'}</span>
        <div className="h-spacer" />
        <button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? '저장 중…' : '저장'}</button>
      </div>
    </div>
  )
}
