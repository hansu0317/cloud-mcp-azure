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

  // 스트리밍 중(output.loading=true)에 새로고침·프로젝트 전환이 일어나면 그 순간의
  // 실제 요청/연결은 사라지는데, 위 자동저장이 그 스냅샷을 그대로 저장해버려 "로딩
  // 중"이 영원히 풀리지 않는 좀비 상태로 남는다(2026-08-31 — "질문 보내고 계속
  // 도는데 안 끝난다"는 피드백의 실제 원인. onDone/onError를 부를 streamChat 콜백은
  // 이전 세션의 runCell 클로저 안에만 있었고, 새로고침 후엔 그 클로저 자체가 없다).
  // 이 컴포넌트가 막 마운트된 시점엔 이 세션이 그 요청을 보낸 적이 없으므로
  // loading:true로 복원된 셀은 100% 좀비다 — 마운트 시 한 번만 훑어 중단된 것으로
  // 정리한다. setCells로 바뀌면 위 자동저장 effect를 그대로 타므로 서버 쪽 스냅샷도
  // 다음 저장 때 같이 고쳐진다.
  useEffect(() => {
    setCells(prev => {
      let changed = false
      const next = prev.map(c => {
        if (!c.output?.loading) return c
        changed = true
        return {
          ...c,
          output: {
            ...c.output,
            loading: false,
            error: true,
            content: '이전 세션에서 응답을 받지 못하고 연결이 끊겼습니다 — 다시 실행해주세요.',
          },
        }
      })
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addCell = useCallback((text = ''): number => {
    const id = ++cellCounterRef.current
    setCells(prev => [...prev, { id, type: 'ai', text, output: null }])
    return id
  }, [])

  // 실행 중인 셀마다 AbortController 하나 — 정지 버튼(stopCell)이 이걸로 fetch를
  // 끊는다. 서버는 연결 종료를 감지해 알아서 정리하므로(chat_api.py의 event_stream
  // finally 참고) 프론트는 끊기만 하면 된다.
  const controllersRef = useRef(new Map<number, AbortController>())

  const stopCell = useCallback((id: number) => {
    controllersRef.current.get(id)?.abort()
  }, [])

  // 실행 중에 삭제하면(예전엔 화면에서만 사라지고 백엔드 요청은 계속 돌았다 —
  // 2026-08-31 피드백의 근본 원인 중 하나) 같이 끊는다.
  const deleteCell = useCallback((id: number) => {
    stopCell(id)
    setCells(prev => prev.filter(c => c.id !== id))
  }, [stopCell])

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

    const controller = new AbortController()
    controllersRef.current.set(id, controller)

    try {
      await streamChat({
        message:  cell.text,
        sessionId,
        signal:   controller.signal,
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
      // stopCell()로 사용자가 직접 끊은 경우 fetch/reader가 AbortError로 reject한다 —
      // 서버 쪽 오류와 구분해서 보여준다(정지 버튼도 여기로 들어온다는 걸 알 수 있게).
      const cancelled = err instanceof DOMException && err.name === 'AbortError'
      setCells(prev => prev.map(c => c.id === id
        ? {
            ...c,
            output: {
              loading: false,
              content: cancelled ? '사용자가 정지했습니다.' : `오류: ${(err as Error).message}`,
              error: true,
              rawContent: '',
              execN: n,
              toolName: null,
              elapsedMs,
            },
          }
        : c
      ))
    } finally {
      controllersRef.current.delete(id)
    }
  }, [sessionId])

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

  useImperativeHandle(ref, () => ({ addCell }), [addCell])

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
              onStop={() => stopCell(cell.id)}
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
