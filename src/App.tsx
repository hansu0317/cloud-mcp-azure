import { useState, useCallback, useEffect, useRef } from 'react'
import Header       from './components/Header'
import Sidebar      from './components/Sidebar'
import NotebookView from './components/NotebookView'
import { API, TOAST_DURATION_MS } from './constants'
import { resetSessionContext } from './api'
import type { Instructions, NotebookHandle } from './types'
import './App.css'

function mkUUID(): string {
  return crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2)
}

export default function App() {
  const [sessionId,        setSessionId]        = useState<string>(mkUUID)
  const [instructions,     setInstructions]     = useState<Instructions>({ joins: [], terms: [], examples: [] })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [resetKey,         setResetKey]         = useState(0)
  const [toast,            setToast]            = useState<string | null>(null)

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

  const handleNewSession = useCallback(() => {
    setSessionId(prev => { resetSessionContext(prev); return mkUUID() })
    setResetKey(k => k + 1)
    showToast('새 세션이 시작되었습니다.')
  }, [showToast])

  return (
    <div className="app">
      <Header
        onNewSession={handleNewSession}
        onToggleSidebar={() => setSidebarCollapsed(c => !c)}
        notebookRef={notebookRef}
      />
      <div className="body">
        <Sidebar collapsed={sidebarCollapsed} />
        <NotebookView
          ref={notebookRef}
          key={`nb-${resetKey}`}
          sessionId={sessionId}
          instructions={instructions}
          showToast={showToast}
        />
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
