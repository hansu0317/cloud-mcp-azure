import { useState, useCallback, useEffect, useRef } from 'react'
import Header             from './components/Header'
import Sidebar            from './components/Sidebar'
import NotebookView       from './components/NotebookView'
import InstructionsModal  from './components/InstructionsModal'
import { TOAST_DURATION_MS } from './constants'
import {
  listProjects, createProject, getProject, updateProject, deleteProject as apiDeleteProject,
} from './api'
import type { Instructions, NotebookHandle, ProjectSummary, ProjectDetail, Cell } from './types'
import './App.css'

// 마지막으로 열어둔 프로젝트만 기억하는 UI 편의용 키 — 실제 데이터(이름·테이블 스코프·
// 셀·대화 기록)는 전부 서버 파일(data/projects/<id>.json)에 있으므로, 이 값이 없거나
// 가리키는 프로젝트가 삭제됐어도 목록의 최신 프로젝트로 대체될 뿐 데이터 유실은 없다.
const LAST_ACTIVE_KEY = 'crm-ai-chat:lastActiveProjectId'

// 프로젝트 응답에 instructions가 없는(마이그레이션 전 캐시 등) 경우를 대비한 안전값.
const EMPTY_INSTRUCTIONS: Instructions = { joins: [], terms: [], examples: [] }

export default function App() {
  const [projectList,   setProjectList]   = useState<ProjectSummary[]>([])
  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)
  const [toast,         setToast]         = useState<string | null>(null)

  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notebookRef = useRef<NotebookHandle>(null)
  const initRanRef  = useRef(false)   // StrictMode 이중 실행 시 기본 프로젝트 중복 생성 방지

  const showToast = useCallback((msg: string, ms = TOAST_DURATION_MS) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const refreshProjectList = useCallback(() => {
    listProjects().then(setProjectList).catch(() => {})
  }, [])

  const openProject = useCallback(async (id: string) => {
    const p = await getProject(id)
    if (!p) { showToast('프로젝트를 열 수 없습니다.'); return }
    setActiveProject(p)
    localStorage.setItem(LAST_ACTIVE_KEY, id)
  }, [showToast])

  // 최초 로드: 프로젝트 목록을 불러와 마지막에 쓰던 프로젝트(없으면 최신순 1번)를 연다.
  // 프로젝트가 하나도 없으면(첫 실행) 기본 프로젝트를 하나 만들어 시작한다.
  useEffect(() => {
    if (initRanRef.current) return
    initRanRef.current = true
    ;(async () => {
      const list = await listProjects().catch(() => [] as ProjectSummary[])
      if (list.length === 0) {
        const created = await createProject('새 프로젝트', [])
        setProjectList([{ id: created.id, name: created.name, tables: created.tables, createdAt: created.createdAt, updatedAt: created.updatedAt }])
        setActiveProject(created)
        localStorage.setItem(LAST_ACTIVE_KEY, created.id)
        return
      }
      setProjectList(list)
      const lastId  = localStorage.getItem(LAST_ACTIVE_KEY)
      const target  = list.find(p => p.id === lastId) ?? list[0]
      const full    = await getProject(target.id)
      if (full) { setActiveProject(full); localStorage.setItem(LAST_ACTIVE_KEY, full.id) }
    })()
  }, [])

  // 생성 직후 사이드바가 바로 테이블 선택 팝업을 띄울 수 있도록 만든 프로젝트를 반환한다.
  const handleCreateProject = useCallback(async (name: string): Promise<ProjectSummary> => {
    const created = await createProject(name, [])
    refreshProjectList()
    setActiveProject(created)
    localStorage.setItem(LAST_ACTIVE_KEY, created.id)
    showToast(`"${created.name}" 프로젝트 생성됨`)
    return { id: created.id, name: created.name, tables: created.tables, createdAt: created.createdAt, updatedAt: created.updatedAt }
  }, [refreshProjectList, showToast])

  const handleSwitchProject = useCallback((id: string) => {
    if (activeProject?.id === id) return
    openProject(id)
  }, [activeProject, openProject])

  const handleRenameProject = useCallback(async (id: string, name: string) => {
    await updateProject(id, { name })
    refreshProjectList()
    setActiveProject(prev => (prev && prev.id === id ? { ...prev, name } : prev))
  }, [refreshProjectList])

  const handleDeleteProject = useCallback(async (id: string) => {
    await apiDeleteProject(id)
    const remaining = projectList.filter(p => p.id !== id)
    if (activeProject?.id === id) {
      if (remaining.length > 0) {
        await openProject(remaining[0].id)
      } else {
        const created = await createProject('새 프로젝트', [])
        setActiveProject(created)
        localStorage.setItem(LAST_ACTIVE_KEY, created.id)
      }
    }
    refreshProjectList()
    showToast('프로젝트 삭제됨')
  }, [projectList, activeProject, openProject, refreshProjectList, showToast])

  // 사이드바 트리에서 테이블 체크박스를 누르면 즉시 화면에 반영 + 서버에 저장.
  // 활성 프로젝트가 아니어도(다른 프로젝트를 미리 펼쳐서) 스코프를 바꿀 수 있으므로
  // projectId로 대상을 받아 activeProject/projectList 양쪽에서 해당 항목만 갱신한다.
  const handleSelectTables = useCallback((projectId: string, tables: string[]) => {
    setActiveProject(prev => (prev && prev.id === projectId ? { ...prev, tables } : prev))
    setProjectList(prev => prev.map(p => (p.id === projectId ? { ...p, tables } : p)))
    updateProject(projectId, { tables })
  }, [])

  // 노트북 셀 자동저장(디바운스는 NotebookView 쪽에서 처리)
  const handleCellsChange = useCallback((cells: Cell[]) => {
    if (!activeProject) return
    updateProject(activeProject.id, { cells })
  }, [activeProject])

  const openProjectsPanel = useCallback(() => {
    setSidebarCollapsed(false)
  }, [])

  // 2026-08-12: 지침은 프로젝트별로 분리됐다(activeProject.instructions) — 저장도
  // updateProject로 그 프로젝트의 필드만 바꾼다. 저장 성공 시 App 상태도 즉시
  // 갱신해 NotebookView가 다음 질문부터 바로 새 지침을 반영한다(재접속 불필요).
  const handleSaveInstructions = useCallback(async (next: Instructions) => {
    if (!activeProject) return
    await updateProject(activeProject.id, { instructions: next })
    setActiveProject(prev => (prev ? { ...prev, instructions: next } : prev))
    showToast('지침이 저장됐습니다')
  }, [activeProject, showToast])

  return (
    <div className="app">
      <Header
        activeProjectName={activeProject?.name ?? ''}
        onOpenProjects={openProjectsPanel}
        onToggleSidebar={() => setSidebarCollapsed(c => !c)}
        onOpenInstructions={() => setShowInstructions(true)}
        notebookRef={notebookRef}
      />
      <div className="body">
        <Sidebar
          collapsed={sidebarCollapsed}
          projects={projectList}
          activeProjectId={activeProject?.id ?? null}
          onSwitchProject={handleSwitchProject}
          onCreateProject={handleCreateProject}
          onRenameProject={handleRenameProject}
          onDeleteProject={handleDeleteProject}
          onSelectTables={handleSelectTables}
        />
        {activeProject && (
          <NotebookView
            key={activeProject.id}
            ref={notebookRef}
            sessionId={activeProject.id}
            instructions={activeProject.instructions ?? EMPTY_INSTRUCTIONS}
            tables={activeProject.tables}
            initialCells={activeProject.cells}
            onCellsChange={handleCellsChange}
            showToast={showToast}
          />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}

      {showInstructions && activeProject && (
        <InstructionsModal
          projectName={activeProject.name}
          instructions={activeProject.instructions ?? EMPTY_INSTRUCTIONS}
          onSave={handleSaveInstructions}
          onClose={() => setShowInstructions(false)}
        />
      )}
    </div>
  )
}
