import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { Instructions, JoinDef, TermDef, ExampleDef } from '../types'

interface Props {
  instructions: Instructions
  onSave:       (next: Instructions) => Promise<void>
  onClose:      () => void
}

type Tab = 'joins' | 'terms' | 'examples'

const EMPTY_JOIN:    JoinDef    = { fromTable: '', fromCol: '', toTable: '', toCol: '', label: '' }
const EMPTY_TERM:    TermDef    = { table: '', column: '', term: '', def: '' }
const EMPTY_EXAMPLE: ExampleDef = { question: '', answer: '' }

// "지침" 설정 팝업 — 테이블 조인 관계·컬럼 용어·질문 예시를 등록해두면 매 세션 첫
// 메시지에 자동으로 붙어(src/api.ts의 buildMessage) 모델이 참고한다. TableScopeModal과
// 같은 모달 셸(.ts-modal*)을 재사용해 기존 UI 톤을 그대로 유지한다.
export default function InstructionsModal({ instructions, onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('joins')
  const [joins,    setJoins]    = useState<JoinDef[]>(instructions.joins)
  const [terms,    setTerms]    = useState<TermDef[]>(instructions.terms)
  const [examples, setExamples] = useState<ExampleDef[]>(instructions.examples)
  const [saving, setSaving] = useState(false)

  const [joinDraft,    setJoinDraft]    = useState<JoinDef>(EMPTY_JOIN)
  const [termDraft,    setTermDraft]    = useState<TermDef>(EMPTY_TERM)
  const [exampleDraft, setExampleDraft] = useState<ExampleDef>(EMPTY_EXAMPLE)

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

  return createPortal(
    <div className="ts-modal" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ts-modal-inner instr-modal-inner">
        <div className="ts-modal-hdr">
          <div>
            <div className="ts-modal-title">지침 설정</div>
            <div className="ts-modal-sub">조인 관계·용어·예시를 알려주면 질문마다 자동으로 참고해 답변 품질이 좋아집니다</div>
          </div>
          <button className="btn btn-xs" onClick={onClose}>✕</button>
        </div>

        <div className="instr-tabs">
          <button className={`instr-tab${tab === 'joins' ? ' active' : ''}`} onClick={() => setTab('joins')}>
            🔗 조인 관계{joins.length > 0 && <span className="instr-tab-count">{joins.length}</span>}
          </button>
          <button className={`instr-tab${tab === 'terms' ? ' active' : ''}`} onClick={() => setTab('terms')}>
            📖 용어 정의{terms.length > 0 && <span className="instr-tab-count">{terms.length}</span>}
          </button>
          <button className={`instr-tab${tab === 'examples' ? ' active' : ''}`} onClick={() => setTab('examples')}>
            💬 질문 예시{examples.length > 0 && <span className="instr-tab-count">{examples.length}</span>}
          </button>
        </div>

        <div className="ts-modal-body instr-modal-body">
          {tab === 'joins' && (
            <>
              <div className="instr-hint">두 테이블을 어떤 컬럼으로 연결해야 하는지 알려주세요. 예: 영업기회(new_q3)의 customerid = 거래처(new_q1)의 new_q1id</div>
              {joins.length === 0 && <div className="sb-empty">등록된 조인 관계가 없습니다</div>}
              {joins.map((j, i) => (
                <div className="instr-row" key={i}>
                  <span className="instr-row-text">
                    <b>{j.fromTable}</b>.{j.fromCol} → <b>{j.toTable}</b>.{j.toCol}
                    {j.label && <span className="instr-row-label"> ({j.label})</span>}
                  </span>
                  <button className="instr-row-del" title="삭제" onClick={() => setJoins(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              <div className="instr-add-row">
                <input className="proj-new-input instr-input-sm" placeholder="시작 테이블 (new_q3)" value={joinDraft.fromTable} onChange={e => setJoinDraft(d => ({ ...d, fromTable: e.target.value }))} />
                <input className="proj-new-input instr-input-sm" placeholder="컬럼 (customerid)" value={joinDraft.fromCol} onChange={e => setJoinDraft(d => ({ ...d, fromCol: e.target.value }))} />
                <span className="instr-arrow">→</span>
                <input className="proj-new-input instr-input-sm" placeholder="연결 테이블 (new_q1)" value={joinDraft.toTable} onChange={e => setJoinDraft(d => ({ ...d, toTable: e.target.value }))} />
                <input className="proj-new-input instr-input-sm" placeholder="컬럼 (new_q1id)" value={joinDraft.toCol} onChange={e => setJoinDraft(d => ({ ...d, toCol: e.target.value }))} />
                <input
                  className="proj-new-input instr-input-sm"
                  placeholder="설명(선택, 거래처)"
                  value={joinDraft.label}
                  onChange={e => setJoinDraft(d => ({ ...d, label: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addJoin() }}
                />
                <button className="btn btn-sm primary" onClick={addJoin}>추가</button>
              </div>
            </>
          )}

          {tab === 'terms' && (
            <>
              <div className="instr-hint">컬럼 값이나 코드가 실제로 무엇을 뜻하는지 알려주세요. 예: statuscode 값 1은 "진행중"</div>
              {terms.length === 0 && <div className="sb-empty">등록된 용어가 없습니다</div>}
              {terms.map((t, i) => (
                <div className="instr-row" key={i}>
                  <span className="instr-row-text">
                    <b>{t.table}</b>.{t.column} = "{t.term}" → {t.def}
                  </span>
                  <button className="instr-row-del" title="삭제" onClick={() => setTerms(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                </div>
              ))}
              <div className="instr-add-row">
                <input className="proj-new-input instr-input-sm" placeholder="테이블 (new_q3)" value={termDraft.table} onChange={e => setTermDraft(d => ({ ...d, table: e.target.value }))} />
                <input className="proj-new-input instr-input-sm" placeholder="컬럼 (statuscode)" value={termDraft.column} onChange={e => setTermDraft(d => ({ ...d, column: e.target.value }))} />
                <input className="proj-new-input instr-input-sm" placeholder="용어 (진행중)" value={termDraft.term} onChange={e => setTermDraft(d => ({ ...d, term: e.target.value }))} />
                <input
                  className="proj-new-input instr-input-sm instr-input-wide"
                  placeholder="설명 (값이 1이면 진행중 상태)"
                  value={termDraft.def}
                  onChange={e => setTermDraft(d => ({ ...d, def: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addTerm() }}
                />
                <button className="btn btn-sm primary" onClick={addTerm}>추가</button>
              </div>
            </>
          )}

          {tab === 'examples' && (
            <>
              <div className="instr-hint">자주 묻는 질문과 원하는 답변 형태를 예시로 보여주면 비슷한 질문에 더 잘 답합니다.</div>
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
