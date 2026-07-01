import { forwardRef, useImperativeHandle, useState, useCallback, useRef } from 'react'
import NotebookCell from './NotebookCell'
import { streamChat, buildMessage } from '../api'
import { APP_NAME } from '../constants'
import type { Instructions, Cell, CellEngine, NotebookHandle, QueryLog, TimingEntry } from '../types'

interface Props {
  sessionId:    string
  engine:       CellEngine
  instructions: Instructions
  showToast:    (msg: string) => void
  onTiming:     (entry: TimingEntry) => void
}

const NotebookView = forwardRef<NotebookHandle, Props>(function NotebookView(
  { sessionId, engine, instructions, showToast, onTiming },
  ref
) {
  // 엔진(모드)별로 셀 리스트를 분리 보관 → 전환해도 서로 사라지지 않음
  const [cellsByEngine, setCellsByEngine] = useState<Record<CellEngine, Cell[]>>({ cli: [], api: [] })
  const cells = cellsByEngine[engine]

  const cellCounterRef = useRef(0)
  const execCounterRef = useRef(0)
  const stateRef       = useRef({ cellsByEngine, engine })
  stateRef.current     = { cellsByEngine, engine }

  // 현재 엔진 리스트만 갱신하는 헬퍼
  const setActive = useCallback((updater: (prev: Cell[]) => Cell[]) => {
    setCellsByEngine(prev => ({ ...prev, [engine]: updater(prev[engine]) }))
  }, [engine])

  const addCell = useCallback((text = ''): number => {
    const id = ++cellCounterRef.current
    setActive(prev => [...prev, { id, type: 'ai', engine, text, output: null }])
    return id
  }, [setActive, engine])

  const deleteCell = useCallback((id: number) => {
    setActive(prev => prev.filter(c => c.id !== id))
  }, [setActive])

  const updateText = useCallback((id: number, text: string) => {
    setActive(prev => prev.map(c => c.id === id ? { ...c, text } : c))
  }, [setActive])

  const clearActive = useCallback(() => {
    setCellsByEngine(prev => ({ ...prev, [engine]: [] }))
  }, [engine])

  const runCell = useCallback(async (id: number) => {
    const cell = stateRef.current.cellsByEngine[engine].find(c => c.id === id)
    if (!cell || !cell.text.trim()) return

    const n = ++execCounterRef.current
    const t0 = Date.now()

    const acc = { current: '' }
    const qs: QueryLog[] = []
    setActive(prev => prev.map(c => c.id === id
      ? { ...c, output: { loading: true, content: '', toolName: null, error: false, rawContent: '', execN: n, queries: [] } }
      : c
    ))

    try {
      await streamChat({
        message:  buildMessage(cell.text, sessionId, instructions),
        sessionId,
        engine,
        onText: (text) => {
          acc.current += text
          const snapshot = acc.current
          setActive(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, loading: false, content: snapshot } }
            : c
          ))
        },
        onTool: (name) => {
          setActive(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, toolName: name } }
            : c
          ))
        },
        onQuery: (tool, input) => {
          qs.push({ tool, input })
          const snapshot = [...qs]
          setActive(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, queries: snapshot } }
            : c
          ))
        },
        onDone: () => {
          const rawContent = acc.current
          const elapsedMs  = Date.now() - t0
          setActive(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, loading: false, rawContent, toolName: null, queries: [...qs], elapsedMs } }
            : c
          ))
          onTiming({ time: new Date().toISOString(), engine, question: cell.text, elapsedMs, error: false })
        },
        onError: (msg) => {
          const elapsedMs = Date.now() - t0
          setActive(prev => prev.map(c => c.id === id
            ? { ...c, output: { loading: false, content: `오류: ${msg}`, error: true, rawContent: '', execN: n, toolName: null, elapsedMs } }
            : c
          ))
          onTiming({ time: new Date().toISOString(), engine, question: cell.text, elapsedMs, error: true })
        },
      })
    } catch (err) {
      const elapsedMs = Date.now() - t0
      setActive(prev => prev.map(c => c.id === id
        ? { ...c, output: { loading: false, content: `오류: ${(err as Error).message}`, error: true, rawContent: '', execN: n, toolName: null, elapsedMs } }
        : c
      ))
      onTiming({ time: new Date().toISOString(), engine, question: cell.text, elapsedMs, error: true })
    }
  }, [sessionId, instructions, engine, setActive, onTiming])

  const runAll = useCallback(async () => {
    for (const cell of stateRef.current.cellsByEngine[stateRef.current.engine]) {
      await runCell(cell.id)
    }
  }, [runCell])

  const handleExport = useCallback((id: number) => {
    const cell = stateRef.current.cellsByEngine[stateRef.current.engine].find(c => c.id === id)
    if (!cell?.output?.rawContent) { showToast('내보낼 데이터가 없습니다.'); return }

    const outEl = document.getElementById(`nb-out-${id}`)
    const table = outEl?.querySelector('table')
    const raw   = cell.output.rawContent

    if (table) {
      const csv = Array.from(table.querySelectorAll('tr'))
        .map(row => Array.from(row.querySelectorAll('th,td'))
          .map(td => `"${td.textContent?.trim().replace(/"/g, '""') ?? ''}"`)
          .join(','))
        .join('\n')
      downloadFile(`crm_result_${id}.csv`, '﻿' + csv, 'text/csv')
      showToast('CSV 다운로드 중...')
    } else {
      downloadFile(`crm_result_${id}.txt`, raw, 'text/plain')
      showToast('텍스트 다운로드 중...')
    }
  }, [showToast])

  useImperativeHandle(ref, () => ({ addCell, runAll, clearActive }), [addCell, runAll, clearActive])

  return (
    <div className="notebook-view">
      <div className="notebook">
        <div className="nb-inner">
          {cells.length === 0 && (
            <div className="welcome">
              <h2>{APP_NAME} AI Notebook</h2>
              <p>
                현재 모드: <strong>{engine === 'api' ? '⚡ Claude API' : '⌨ Claude Code CLI'}</strong> ·{' '}
                자연어로 질문하면 Dataverse 데이터를 조회합니다 ·{' '}
                <kbd style={{ background: '#1e2533', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>
                  Shift+Enter
                </kbd>{' '}
                실행
              </p>
            </div>
          )}
          {cells.map(cell => (
            <NotebookCell
              key={cell.id}
              cell={cell}
              onRun={() => runCell(cell.id)}
              onDelete={() => deleteCell(cell.id)}
              onTextChange={(text) => updateText(cell.id, text)}
              onExport={() => handleExport(cell.id)}
            />
          ))}
          <div className="add-bar">
            <button className="btn" onClick={() => addCell()}>＋ 셀 추가</button>
          </div>
        </div>
      </div>
    </div>
  )
})

function downloadFile(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const a   = document.createElement('a')
  a.href     = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 100)
}

export default NotebookView
