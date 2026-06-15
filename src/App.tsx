import { useState, useCallback, useEffect, useRef } from 'react'
import Header       from './components/Header'
import Sidebar      from './components/Sidebar'
import NotebookView from './components/NotebookView'
import { API, TOAST_DURATION_MS } from './constants'
import type { LlmMode } from './constants'
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
  const [llmMode,          setLlmMode]          = useState<LlmMode>('claude')

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

  const handleToggleLlm = useCallback(() => {
    setLlmMode(prev => {
      const next = prev === 'claude' ? 'groq' : 'claude'
      showToast(next === 'groq' ? '⚡ Groq로 전환 (빠름)' : '◆ Claude MCP로 전환')
      return next
    })
    // LLM 전환 시 세션도 초기화
    setSessionId(prev => { resetSessionContext(prev); return mkUUID() })
    setResetKey(k => k + 1)
  }, [showToast])

  const handleInstructionsChange = useCallback(async (newInst: Instructions) => {
    setInstructions(newInst)
    try {
      await fetch(API.INSTRUCTIONS, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(newInst),
      })
    } catch {
      showToast('지침 저장 실패')
    }
  }, [showToast])

  return (
    <div className="app">
      <Header
        onNewSession={handleNewSession}
        onToggleSidebar={() => setSidebarCollapsed(c => !c)}
        notebookRef={notebookRef}
        llmMode={llmMode}
        onToggleLlm={handleToggleLlm}
      />
      <div className="body">
        <Sidebar collapsed={sidebarCollapsed} />
        <NotebookView
          ref={notebookRef}
          key={`nb-${resetKey}`}
          sessionId={sessionId}
          instructions={instructions}
          showToast={showToast}
          chatEndpoint={llmMode === 'groq' ? API.GROQ_CHAT : API.CHAT}
        />
      </div>

{toast && <div className="toast">{toast}</div>}
    </div>
  )
}
