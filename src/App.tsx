import { useState, useCallback, useEffect, useRef } from 'react'
import Header       from './components/Header'
import Sidebar      from './components/Sidebar'
import NotebookView from './components/NotebookView'
import TimingModal  from './components/TimingModal'
import { API, TOAST_DURATION_MS } from './constants'
import { resetSessionContext } from './api'
import type { Instructions, NotebookHandle, CellEngine, TimingEntry } from './types'
import './App.css'

function mkUUID(): string {
  return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)
}

const TIMING_KEY = 'crm_timing_log'
const TIMING_MAX = 300

function loadTimingLog(): TimingEntry[] {
  try {
    const raw = localStorage.getItem(TIMING_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

export default function App() {
  const [engine,           setEngine]           = useState<CellEngine>('cli')
  // 모드별 독립 세션 ID → 대화 이력이 서로 섞이지 않음
  const [sessions,         setSessions]         = useState<Record<CellEngine, string>>(() => ({ cli: mkUUID(), api: mkUUID() }))
  const [instructions,     setInstructions]     = useState<Instructions>({ joins: [], terms: [], examples: [] })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [toast,            setToast]            = useState<string | null>(null)
  const [timingLog,        setTimingLog]        = useState<TimingEntry[]>(loadTimingLog)
  const [showTiming,       setShowTiming]       = useState(false)

  const sessionId = sessions[engine]

  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notebookRef = useRef<NotebookHandle>(null)

  useEffect(() => {
    fetch(API.INSTRUCTIONS)
      .then(r => r.json())
      .then((d: Instructions) => setInstructions(d))
      .catch(() => {})
  }, [])

  const showToast = useCallback((msg: string, ms = TOAST_DURATION_MS) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const recordTiming = useCallback((entry: TimingEntry) => {
    setTimingLog(prev => {
      const next = [...prev, entry].slice(-TIMING_MAX)
      try { localStorage.setItem(TIMING_KEY, JSON.stringify(next)) } catch { /* 용량 초과 등 무시 */ }
      return next
    })
  }, [])

  const clearTiming = useCallback(() => {
    setTimingLog([])
    try { localStorage.removeItem(TIMING_KEY) } catch { /* 무시 */ }
  }, [])

  // 현재 모드만 새 세션 + 현재 모드 셀만 초기화 (반대 모드는 그대로)
  const handleNewSession = useCallback(() => {
    setSessions(prev => {
      resetSessionContext(prev[engine])
      return { ...prev, [engine]: mkUUID() }
    })
    notebookRef.current?.clearActive()
    showToast(`새 세션 시작 (${engine === 'api' ? 'API' : 'CLI'} 모드)`)
  }, [engine, showToast])

  return (
    <div className="app">
      <Header
        engine={engine}
        onEngineChange={setEngine}
        onNewSession={handleNewSession}
        onToggleSidebar={() => setSidebarCollapsed(c => !c)}
        onShowTiming={() => setShowTiming(true)}
        notebookRef={notebookRef}
      />
      <div className="body">
        <Sidebar collapsed={sidebarCollapsed} />
        <NotebookView
          ref={notebookRef}
          engine={engine}
          sessionId={sessionId}
          instructions={instructions}
          showToast={showToast}
          onTiming={recordTiming}
        />
      </div>

      {showTiming && (
        <TimingModal entries={timingLog} onClear={clearTiming} onClose={() => setShowTiming(false)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
