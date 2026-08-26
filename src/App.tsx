import { useState, useCallback, useEffect, useRef } from 'react'
import Header             from './components/Header'
import Sidebar            from './components/Sidebar'
import NotebookView       from './components/NotebookView'
import InstructionsPanel  from './components/InstructionsPanel'
import LoginGate          from './components/LoginGate'
import UserAdminModal     from './components/UserAdminModal'
import { TOAST_DURATION_MS } from './constants'
import {
  listProjects, createProject, getProject, updateProject, deleteProject as apiDeleteProject, reorderProjects,
  getMe, ProjectConflictError,
} from './api'
import type { AuthMe, Instructions, NotebookHandle, ProjectSummary, ProjectDetail, Cell } from './types'
import './App.css'

// LOGIN_*이 .env에 없는 환경(로컬 개발 클론 등)에서는 로그인한 사람 개념 자체가
// 없다 — authUser=null이면 Header가 로그인 배지·로그아웃 버튼을 그냥 안 보여준다.
type AuthUser = { email: string; name: string; isAdmin: boolean }

// 마지막으로 열어둔 프로젝트만 기억하는 UI 편의용 키 — 실제 데이터(이름·테이블 스코프·
// 셀·대화 기록)는 전부 서버 파일(data/projects/<id>.json)에 있으므로, 이 값이 없거나
// 가리키는 프로젝트가 삭제됐어도 목록의 최신 프로젝트로 대체될 뿐 데이터 유실은 없다.
const LAST_ACTIVE_KEY = 'crm-ai-chat:lastActiveProjectId'

// 프로젝트 응답에 instructions가 없는(마이그레이션 전 캐시 등) 경우를 대비한 안전값.
const EMPTY_INSTRUCTIONS: Instructions = { joins: [], terms: [], examples: [] }

export default function App() {
  // 'checking' 동안은 아무것도 렌더링 안 한다 — Header/Sidebar 등을 먼저 마운트했다가
  // 로그인 안 된 걸 알고 도로 LoginGate로 바꾸면, 그 사이 /api/* 401들이 토스트로
  // 우수수 뜨는 걸 막기 위함이다.
  const [authState, setAuthState] = useState<'checking' | 'gate' | 'ok'>('checking')
  const [authUser,  setAuthUser]  = useState<AuthUser | null>(null)
  const [userAdminOpen, setUserAdminOpen] = useState(false)

  const [projectList,   setProjectList]   = useState<ProjectSummary[]>([])
  const [activeProject, setActiveProject] = useState<ProjectDetail | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 왼쪽 카탈로그 사이드바와 대칭 — 상시 패널이라 "열림/닫힘"만 토글한다(모달 아님).
  const [instructionsCollapsed, setInstructionsCollapsed] = useState(true)
  const [toast,         setToast]         = useState<string | null>(null)

  const toastTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notebookRef = useRef<NotebookHandle>(null)
  const initRanRef  = useRef(false)   // StrictMode 이중 실행 시 기본 프로젝트 중복 생성 방지

  // activeProject를 항상 최신값으로 읽기 위한 ref — 아래 큐에 쌓인 저장 함수는 클로저가
  // 만들어질 때가 아니라 "실제로 실행될 때" 최신 _rev를 읽어야 한다(state는 그 시점에
  // 최신이 아닐 수 있음).
  const activeProjectRef = useRef<ProjectDetail | null>(null)
  useEffect(() => { activeProjectRef.current = activeProject }, [activeProject])

  const showToast = useCallback((msg: string, ms = TOAST_DURATION_MS) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  // 같은 프로젝트로 가는 저장 요청(테이블 선택·셀 자동저장·지침 저장)을 순서대로만
  // 내보낸다 — 줄을 안 세우면, 사용자가 빠르게 여러 번 고쳤을 때 뒤 요청이 앞 요청의
  // 응답(과 그 안의 새 _rev)이 오기 전에 만들어져 옛 _rev를 들고 나가버려서, 다른 탭이
  // 아니라 "나 자신의 이전 저장"과 충돌하는 것처럼 보이는 오탐이 날 수 있다.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const queueProjectSave = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const result = saveQueueRef.current.then(run, run)
    saveQueueRef.current = result.catch(() => {})
    return result
  }, [])

  // 2026-08-25: Microsoft 로그인 게이트 — 앱 첫 로드 시 한 번만 확인한다. LOGIN_*이
  // 서버에 설정 안 돼 있으면(loginRequired:false) 로그인 화면 없이 바로 통과.
  useEffect(() => {
    getMe().then((me: AuthMe) => {
      if (!me.loginRequired) { setAuthState('ok'); return }
      if ('email' in me) {
        setAuthUser({ email: me.email, name: me.name, isAdmin: me.isAdmin })
        setAuthState('ok')
      } else {
        setAuthState('gate')
      }
    }).catch(() => setAuthState('gate'))
  }, [])

  // "로그아웃"이 아니라 "계정 전환"인 이유는 Header.tsx 주석 참고 — 진짜 Microsoft
  // 로그아웃은 같은 브라우저의 다른 회사 M365 웹앱(Outlook/Teams 등)까지 로그아웃
  // 시켜버려서, 우리 세션만 지우고 계정 선택 화면을 강제로 띄우는 쪽으로 갔다.
  const handleSwitchAccount = useCallback(() => {
    window.location.href = '/auth/switch-account'
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

  // ChatGPT/Claude Desktop에서 같은 대화를 여러 탭으로 열어도 매번 "충돌났다"는
  // 경고를 보여주지 않는 것처럼, 여기서도 흔한 충돌(다른 탭이 "다른 필드"를 먼저
  // 저장한 경우)은 사용자에게 알리지 않고 조용히 다시 맞춘다 — update_project는
  // 이 호출이 지정한 필드만 건드리고 나머지는 서버에 이미 있는 값을 그대로 두므로,
  // 최신 _rev만 다시 받아 같은 필드값으로 재시도하면 데이터 유실 없이 저절로
  // 풀린다. 정말 드물게 "같은 필드를 같은 순간에" 두 곳에서 고친 경우만 재시도도
  // 충돌하는데, 그때만 아래 handleProjectSaveError로 사용자에게 알린다.
  const saveProjectFieldWithRetry = useCallback(async (
    projectId: string,
    patch: { name?: string; tables?: string[]; instructions?: Instructions; cells?: unknown[] },
  ): Promise<ProjectDetail> => {
    const revNow = () => (activeProjectRef.current?.id === projectId ? activeProjectRef.current._rev : undefined)
    try {
      return await updateProject(projectId, { ...patch, _rev: revNow() })
    } catch (err) {
      if (!(err instanceof ProjectConflictError)) throw err
      const latest = await getProject(projectId)
      if (!latest) throw err
      return updateProject(projectId, { ...patch, _rev: latest._rev })   // 한 번만 자동 재시도
    }
  }, [])

  // 자동 재시도(위)까지 실패한 진짜 드문 경우에만 탄다 — 이땐 뭘 병합해야 할지 알
  // 수 없으니 안내하고 최신 내용을 다시 불러와, 그다음 저장부터 새 _rev로 정상
  // 진행되게 한다.
  const handleProjectSaveError = useCallback((err: unknown, fallbackMsg: string) => {
    if (err instanceof ProjectConflictError) {
      showToast('다른 탭·기기에서 방금 저장한 내용이 있어 이 변경은 반영되지 않았습니다 — 최신 내용을 다시 불러옵니다')
      const id = activeProjectRef.current?.id
      if (id) openProject(id)
      return
    }
    showToast(fallbackMsg)
  }, [showToast, openProject])

  // 최초 로드: 프로젝트 목록을 불러와 마지막에 쓰던 프로젝트(없으면 최신순 1번)를 연다.
  // 프로젝트가 하나도 없으면(첫 실행) 기본 프로젝트를 하나 만들어 시작한다.
  // authState==='ok'가 되기 전엔 실행하지 않는다 — 로그인 확인 useEffect와 동시에
  // 마운트돼서, 로그인 게이트에 걸린 상태에서도 /api/projects를 불러버리면 401을
  // 그대로 밟고 지나가 createProject()의 응답(에러 JSON)을 정상 프로젝트인 것처럼
  // 다루다가 터졌다(실제 재현: "Cannot read properties of undefined" 콘솔 에러).
  useEffect(() => {
    if (authState !== 'ok') return
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
  }, [authState])

  // 생성 직후 사이드바가 바로 테이블 선택 팝업을 띄울 수 있도록 만든 프로젝트를 반환한다.
  const handleCreateProject = useCallback(async (name: string): Promise<ProjectSummary> => {
    const created = await createProject(name, [])
    refreshProjectList()
    setActiveProject(created)
    localStorage.setItem(LAST_ACTIVE_KEY, created.id)
    showToast(`"${created.name}" 프로젝트 생성됨`)
    return {
      id: created.id, name: created.name, tables: created.tables,
      createdAt: created.createdAt, updatedAt: created.updatedAt, order: created.order,
      ownerEmail: created.ownerEmail,
    }
  }, [refreshProjectList, showToast])

  const handleSwitchProject = useCallback((id: string) => {
    if (activeProject?.id === id) return
    openProject(id)
  }, [activeProject, openProject])

  const handleRenameProject = useCallback(async (id: string, name: string) => {
    try {
      await updateProject(id, { name })
    } catch {
      showToast('이름 변경 실패 — 다시 시도해주세요')
      return
    }
    refreshProjectList()
    setActiveProject(prev => (prev && prev.id === id ? { ...prev, name } : prev))
  }, [refreshProjectList, showToast])

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
    queueProjectSave(() => saveProjectFieldWithRetry(projectId, { tables }))
      .then(updated => {
        setActiveProject(prev => (prev && prev.id === projectId ? { ...prev, _rev: updated._rev, updatedAt: updated.updatedAt } : prev))
      })
      .catch(err => handleProjectSaveError(err, '테이블 선택 저장 실패 — 새로고침 후 다시 시도해주세요'))
  }, [queueProjectSave, saveProjectFieldWithRetry, handleProjectSaveError])

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
    const projectId = activeProject.id
    setActiveProject(prev => (prev && prev.id === projectId ? { ...prev, cells } : prev))
    queueProjectSave(() => saveProjectFieldWithRetry(projectId, { cells }))
      .then(updated => {
        setActiveProject(prev => (prev && prev.id === projectId ? { ...prev, _rev: updated._rev, updatedAt: updated.updatedAt } : prev))
      })
      .catch(err => handleProjectSaveError(err, '셀 저장 실패 — 새로고침 후 다시 시도해주세요'))
  }, [activeProject, queueProjectSave, saveProjectFieldWithRetry, handleProjectSaveError])

  // 헤더의 "📁 프로젝트명" 버튼 — 예전엔 항상 열기만 했는데(이미 열려 있으면 눌러도
  // 그대로), ≡ 버튼과 똑같이 토글로 바꿨다 — 왼쪽 패널도 오른쪽 지침 패널처럼
  // 눌러서 접었다 폈다 할 수 있어야 한다는 피드백.
  const toggleSidebar = useCallback(() => setSidebarCollapsed(c => !c), [])

  // 2026-08-12: 지침은 프로젝트별로 분리됐다(activeProject.instructions) — 저장도
  // updateProject로 그 프로젝트의 필드만 바꾼다. 저장 성공 시 App 상태도 즉시
  // 갱신한다. 서버가 매 질문마다 저장된 최신 지침을 직접 읽으므로 재접속은 필요 없다.
  const handleSaveInstructions = useCallback(async (next: Instructions) => {
    if (!activeProject) return
    const projectId = activeProject.id
    let updated: ProjectDetail
    try {
      updated = await queueProjectSave(() => saveProjectFieldWithRetry(projectId, { instructions: next }))
    } catch (err) {
      // 자동 재시도까지 충돌한 진짜 드문 경우 — 최신 내용으로 다시 불러와서 다음
      // 저장(다시 누르면)은 새 _rev로 나가게 한다. InstructionsPanel은
      // activeProject.id가 안 바뀌므로 리마운트되지 않고, 사용자가 지금 화면에
      // 입력해둔 내용은 그대로 남는다. 메시지는 InstructionsPanel의 handleSave가
      // err.message로 보여주므로 여기선 다시 던지기만 한다.
      if (err instanceof ProjectConflictError) await openProject(projectId)
      throw err
    }
    setActiveProject(prev => (prev && prev.id === projectId ? { ...prev, instructions: next, _rev: updated._rev, updatedAt: updated.updatedAt } : prev))
    showToast('지침이 저장됐습니다')
  }, [activeProject, queueProjectSave, saveProjectFieldWithRetry, openProject, showToast])

  if (authState === 'checking') return null
  if (authState === 'gate') return <LoginGate />

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
        authUser={authUser}
        onSwitchAccount={handleSwitchAccount}
        onOpenUserAdmin={() => setUserAdminOpen(true)}
      />
      {userAdminOpen && <UserAdminModal onClose={() => setUserAdminOpen(false)} />}
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
            projectUpdatedAt={activeProject.updatedAt}
            instructions={activeProject.instructions ?? EMPTY_INSTRUCTIONS}
            cells={activeProject.cells}
            onSave={handleSaveInstructions}
            showToast={showToast}
          />
        )}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
