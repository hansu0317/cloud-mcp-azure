import { forwardRef, useImperativeHandle, useState, useCallback, useRef } from 'react'
import NotebookCell from './NotebookCell'
import { streamChat, buildMessage } from '../api'
import { API, APP_NAME } from '../constants'
import type { Instructions, Cell, CellType, NotebookHandle, QueryLog } from '../types'

interface Props {
  sessionId:    string
  instructions: Instructions
  showToast:    (msg: string) => void
  chatEndpoint?: string
}

const NotebookView = forwardRef<NotebookHandle, Props>(function NotebookView(
  { sessionId, instructions, showToast, chatEndpoint = API.CHAT },
  ref
) {
  const [cells, setCells] = useState<Cell[]>([])

  const cellCounterRef = useRef(0)
  const execCounterRef = useRef(0)
  const cellsRef       = useRef<Cell[]>(cells)
  cellsRef.current     = cells

  const addCell = useCallback((type: CellType = 'ai', text = ''): number => {
    const id = ++cellCounterRef.current
    setCells(prev => [...prev, { id, type, text, output: null }])
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

    if (cell.type === 'sql') {
      setCells(prev => prev.map(c => c.id === id
        ? { ...c, output: { loading: false, content: 'SQL 직접 실행은 아직 준비 중입니다.\nDB 커넥션 연결 후 사용 가능합니다.', error: true, rawContent: '', execN: n, toolName: null } }
        : c
      ))
      return
    }

    const acc = { current: '' }
    const qs: QueryLog[] = []
    setCells(prev => prev.map(c => c.id === id
      ? { ...c, output: { loading: true, content: '', toolName: null, error: false, rawContent: '', execN: n, queries: [] } }
      : c
    ))

    try {
      await streamChat({
        message:  buildMessage(cell.text, sessionId, instructions),
        sessionId,
        cellType: 'ai_cell',
        endpoint: chatEndpoint,
        onText: (text) => {
          acc.current += text
          const snapshot = acc.current
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, loading: false, content: snapshot } }
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
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { ...c.output!, loading: false, rawContent, toolName: null, queries: [...qs] } }
            : c
          ))
        },
        onError: (msg) => {
          setCells(prev => prev.map(c => c.id === id
            ? { ...c, output: { loading: false, content: `오류: ${msg}`, error: true, rawContent: '', execN: n, toolName: null } }
            : c
          ))
        },
      })
    } catch (err) {
      setCells(prev => prev.map(c => c.id === id
        ? { ...c, output: { loading: false, content: `오류: ${(err as Error).message}`, error: true, rawContent: '', execN: n, toolName: null } }
        : c
      ))
    }
  }, [sessionId, instructions])

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
                자연어로 질문하거나 SQL을 직접 실행하세요 ·{' '}
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
            <button className="btn" onClick={() => addCell('ai')}>＋ AI 셀 추가</button>
            <button className="btn" onClick={() => addCell('sql')}>＋ SQL 셀 추가</button>
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
