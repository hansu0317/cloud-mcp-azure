import { useState, useCallback, useEffect, useRef } from 'react'
import Header             from './components/Header'
import Sidebar            from './components/Sidebar'
import NotebookView       from './components/NotebookView'
import InstructionsPanel  from './components/InstructionsPanel'
import { TOAST_DURATION_MS } from './constants'
import {
  listProjects, createProject, getProject, updateProject, deleteProject as apiDeleteProject, reorderProjects,
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
  // 왼쪽 카탈로그 사이드바와 대칭 — 상시 패널이라 "열림/닫힘"만 토글한다(모달 아님).
  const [instructionsCollapsed, setInstructionsCollapsed] = useState(true)
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
        setProjectList([{ id: created.id, name: created.name, tables: created.tables, createdAt: created.createdAt, updatedAt: created.updatedAt, order: created.order }])
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
    return { id: created.id, name: created.name, tables: created.tables, createdAt: created.createdAt, updatedAt: created.updatedAt, order: created.order }
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

  // 사이드바 ▲▼ 버튼 — 화면에 이미 보이는(검색으로 걸러졌을 수도 있는) 목록 기준으로
  // 두 항목의 위치를 바꾼 새 전체 순서를 만들어 즉시 화면에 반영하고, 서버에도 그
  // 순서 그대로 저장한다(reorderProjects). 실패해도 다음 목록 새로고침에서 서버
  // 값으로 다시 맞춰지므로 롤백은 따로 안 한다.
  const handleReorderProjects = useCallback((orderedIds: string[]) => {
    setProjectList(prev => {
      const byId = new Map(prev.map(p => [p.id, p]))
      return orderedIds.map(id => byId.get(id)).filter((p): p is ProjectSummary => !!p)
    })
    reorderProjects(orderedIds).catch(() => {})
  }, [])

  // 노트북 셀 자동저장(디바운스는 NotebookView 쪽에서 처리). 서버 저장뿐 아니라
  // activeProject.cells도 같이 갱신해야 InstructionsPanel의 "노트북에서 가져오기"가
  // 방금 실행한 셀을 바로 볼 수 있다(안 그러면 최초 로드 시점 cells로 고정돼버림) —
  // InstructionsPanel은 activeProject.id로만 key를 주므로 이 갱신으로 리마운트되진 않는다.
  const handleCellsChange = useCallback((cells: Cell[]) => {
    if (!activeProject) return
    setActiveProject(prev => (prev && prev.id === activeProject.id ? { ...prev, cells } : prev))
    updateProject(activeProject.id, { cells })
  }, [activeProject])

  // 헤더의 "📁 프로젝트명" 버튼 — 예전엔 항상 열기만 했는데(이미 열려 있으면 눌러도
  // 그대로), ≡ 버튼과 똑같이 토글로 바꿨다 — 왼쪽 패널도 오른쪽 지침 패널처럼
  // 눌러서 접었다 폈다 할 수 있어야 한다는 피드백.
  const toggleSidebar = useCallback(() => setSidebarCollapsed(c => !c), [])

  // 2026-08-12: 지침은 프로젝트별로 분리됐다(activeProject.instructions) — 저장도
  // updateProject로 그 프로젝트의 필드만 바꾼다. 저장 성공 시 App 상태도 즉시
  // 갱신한다. 서버가 매 질문마다 저장된 최신 지침을 직접 읽으므로 재접속은 필요 없다.
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
        onOpenProjects={toggleSidebar}
        onToggleSidebar={toggleSidebar}
        sidebarOpen={!sidebarCollapsed}
        onToggleInstructions={() => setInstructionsCollapsed(c => !c)}
        instructionsOpen={!instructionsCollapsed}
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
          onReorderProjects={handleReorderProjects}
        />
        {activeProject && (
          <NotebookView
            key={`nb-${activeProject.id}`}
            ref={notebookRef}
            sessionId={activeProject.id}
            initialCells={activeProject.cells}
            onCellsChange={handleCellsChange}
            showToast={showToast}
          />
        )}
        {activeProject && (
          <InstructionsPanel
            key={`ip-${activeProject.id}`}
            collapsed={instructionsCollapsed}
            projectId={activeProject.id}
            projectName={activeProject.name}
            projectTables={activeProject.tables ?? []}
            instructions={activeProject.instructions ?? EMPTY_INSTRUCTIONS}
            cells={activeProject.cells}
            onSave={handleSaveInstructions}
          />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
