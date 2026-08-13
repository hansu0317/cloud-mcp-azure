import { forwardRef, useImperativeHandle, useState, useCallback, useRef, useEffect } from 'react'
import NotebookCell from './NotebookCell'
import { streamChat } from '../api'
import { APP_NAME, CELLS_AUTOSAVE_DEBOUNCE_MS } from '../constants'
import type { Cell, NotebookHandle, QueryLog } from '../types'

interface Props {
  sessionId:      string
  initialCells?:  Cell[]                      // 프로젝트 전환 시 저장된 셀 복원
  onCellsChange?: (cells: Cell[]) => void      // 자동저장(디바운스)용
  showToast:      (msg: string) => void
}

const NotebookView = forwardRef<NotebookHandle, Props>(function NotebookView(
  { sessionId, initialCells, onCellsChange, showToast },
  ref
) {
  const [cells, setCells] = useState<Cell[]>(() => initialCells ?? [])

  const cellCounterRef = useRef(Math.max(0, ...(initialCells?.map(c => c.id) ?? [0])))
  const execCounterRef = useRef(0)
  const cellsRef       = useRef(cells)
  cellsRef.current     = cells

  // 자동저장 — 스트리밍 중 매 토큰마다 바로 저장하면 요청이 폭주하므로 디바운스.
  // 프로젝트를 전환하면 이 컴포넌트가 key로 통째로 리마운트되므로, 마운트 직후
  // (= 방금 복원한 initialCells 그대로) 한 번은 저장을 건너뛴다.
  const onCellsChangeRef = useRef(onCellsChange)
  onCellsChangeRef.current = onCellsChange
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    const t = setTimeout(() => onCellsChangeRef.current?.(cellsRef.current), CELLS_AUTOSAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [cells])

  const addCell = useCallback((text = ''): number => {
    const id = ++cellCounterRef.current
    setCells(prev => [...prev, { id, type: 'ai', text, output: null }])
    return id
  }, [])

  const deleteCell = useCallback((id: number) => {
    setCells(prev => prev.filter(c => c.id !== id))
  }, [])

  const updateText = useCallback((id: number, text: string) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, text } : c))
  }, [])

  const runCell = useCallback(async (id: number) => {
    const cell = cellsRef.current.find(c => c.id === id)
    if (!cell || !cell.text.trim()) return

    const n = ++execCounterRef.current
    const t0 = Date.now()

    const acc = { current: '' }
    const qs: QueryLog[] = []
    setCells(prev => prev.map(c => c.id === id
      ? { ...c, output: { loading: true, content: '', toolName: null, error: false, rawContent: '', execN: n, queries: [] } }
      : c
    ))

    try {
      await streamChat({
        message:  cell.text,
        sessionId,
        onText: (text) => {
          acc.current += text
          const snapshot = acc.current
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, content: snapshot } }
            : c
          ))
        },
        onTool: (name) => {
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, toolName: name } }
            : c
          ))
        },
        onQuery: (tool, input) => {
          qs.push({ tool, input })
          const snapshot = [...qs]
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, queries: snapshot } }
            : c
          ))
        },
        onDone: () => {
          const rawContent = acc.current
          const elapsedMs  = Date.now() - t0
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, loading: false, rawContent, toolName: null, queries: [...qs], elapsedMs } }
            : c
          ))
        },
        onError: (msg) => {
          const elapsedMs = Date.now() - t0
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { loading: false, content: `오류: ${msg}`, error: true, rawContent: '', execN: n, toolName: null, elapsedMs } }
            : c
          ))
        },
      })
    } catch (err) {
      const elapsedMs = Date.now() - t0
      setCells(prev => prev.map(c => c.id === id
        ? { ...c, output: { loading: false, content: `오류: ${(err as Error).message}`, error: true, rawContent: '', execN: n, toolName: null, elapsedMs } }
        : c
      ))
    }
  }, [sessionId])

  const runAll = useCallback(async () => {
    for (const cell of cellsRef.current) {
      await runCell(cell.id)
    }
  }, [runCell])

  const handleExport = useCallback((id: number) => {
    const cell = cellsRef.current.find(c => c.id === id)
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

  useImperativeHandle(ref, () => ({ addCell, runAll }), [addCell, runAll])

  return (
    <div className="notebook-view">
      <div className="notebook">
        <div className="nb-inner">
          {cells.length === 0 && (
            <div className="welcome">
              <h2>{APP_NAME} AI Notebook</h2>
              <p>
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
