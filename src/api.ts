import { marked }     from 'marked'
import DOMPurify      from 'dompurify'
import { API } from './constants'
import type { AuthMe, Instructions, StreamChatOptions, ProjectDetail, ProjectSummary, SseEvent } from './types'

export function renderMd(text: string): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text) as string)
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { message, sessionId, onText, onTool, onQuery, onDone, onError } = opts

  const resp = await fetch(API.CHAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, sessionId }),
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)

  const reader  = resp.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let ev: SseEvent
      try { ev = JSON.parse(line.slice(6)) as SseEvent } catch { continue }
      if      (ev.type === 'text')  onText?.(ev.text)
      else if (ev.type === 'tool')  onTool?.(ev.name)
      else if (ev.type === 'query') onQuery?.(ev.tool, ev.input)
      else if (ev.type === 'done')  onDone?.()
      else if (ev.type === 'error') onError?.(ev.message)
    }
  }
}

// ─── 프로젝트 (구 "세션") — 이름 + 테이블 스코프 + 노트북 셀을 서버에 영속화 ──────
export async function listProjects(): Promise<ProjectSummary[]> {
  const { projects } = await fetch(API.PROJECTS).then(r => r.json()) as { projects: ProjectSummary[] }
  return projects
}

export async function createProject(name: string, tables: string[] = []): Promise<ProjectDetail> {
  return fetch(API.PROJECTS, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, tables }),
  }).then(r => r.json()) as Promise<ProjectDetail>
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
  const resp = await fetch(`${API.PROJECTS}/${id}`)
  if (!resp.ok) return null
  return resp.json() as Promise<ProjectDetail>
}

// 응답 상태를 확인 안 하고 그냥 fetch만 던지던 예전 버전은, 서버가 저장을 거부해도
// (400/500 등) 호출부가 항상 성공한 것처럼 넘어갔다 — InstructionsPanel에서 "저장을
// 눌러도 반영이 안 된다"는 피드백(2026-08-24)의 실제 원인이었다. 이제 실패하면
// 던져서 호출부(App.tsx handleSaveInstructions → InstructionsPanel handleSave)가
// 실제로 실패를 알고 사용자에게 보여줄 수 있게 한다.
export async function updateProject(
  id: string,
  patch: { name?: string; tables?: string[]; instructions?: Instructions; cells?: unknown[] },
): Promise<void> {
  const resp = await fetch(`${API.PROJECTS}/${id}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `저장 실패 (HTTP ${resp.status})`)
  }
}

export async function deleteProject(id: string): Promise<void> {
  await fetch(`${API.PROJECTS}/${id}`, { method: 'DELETE' })
}

// 사이드바 위/아래 버튼으로 만든 새 전체 순서를 그대로 보낸다 — 서버가 각 프로젝트의
// order를 배열 인덱스로 다시 쓴다(projects.py의 reorder_projects 참고).
export async function reorderProjects(orderedIds: string[]): Promise<ProjectSummary[]> {
  const { projects } = await fetch(`${API.PROJECTS}/reorder`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ order: orderedIds }),
  }).then(r => r.json()) as { projects: ProjectSummary[] }
  return projects
}

// ─── 로그인(Microsoft Entra ID) — 2026-08-25 ────────────────────────────────────
// /auth/* 는 /api/* 와 별개 경로다(백엔드 rate-limit·API 키 미들웨어가 /api만 보므로
// 로그인 자체가 그런 것에 걸리지 않게). App.tsx가 시작할 때 한 번 불러서 로그인
// 화면을 보여줄지 앱을 바로 보여줄지 정한다.
export async function getMe(): Promise<AuthMe> {
  const resp = await fetch('/auth/me')
  return resp.json() as Promise<AuthMe>
}

// "로그아웃" 대신 "계정 전환"(/auth/switch-account)만 있다 — App.tsx handleSwitchAccount
// 쪽 주석 참고. fetch가 아니라 브라우저가 실제로 이동해야 하는 흐름이라 여기 별도
// 함수는 없다(window.location.href로 직접 이동).

// ─── 관리자: 로그인 허용 명단·관리자 여부 관리 — 2026-08-25 ────────────────────────
// data/users.json을 화면에서 직접 고칠 수 있게 한 CRUD. 서버가 관리자 세션인지
// 매 요청마다 다시 확인하므로(main.py의 _require_admin) 프론트는 그냥 호출만 한다.
export interface AdminUser {
  email:    string
  isAdmin:  boolean
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const resp = await fetch('/api/admin/users')
  if (!resp.ok) {
    const body = await resp.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `사용자 목록 조회 실패 (HTTP ${resp.status})`)
  }
  const { users } = await resp.json() as { users: AdminUser[] }
  return users
}

export async function upsertAdminUser(user: AdminUser): Promise<AdminUser> {
  const resp = await fetch('/api/admin/users', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(user),
  })
  if (!resp.ok) {
    const body = await resp.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `저장 실패 (HTTP ${resp.status})`)
  }
  return resp.json() as Promise<AdminUser>
}

export async function deleteAdminUser(email: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, { method: 'DELETE' })
  if (!resp.ok) {
    const body = await resp.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || `삭제 실패 (HTTP ${resp.status})`)
  }
}

// ─── 지침 (조인 관계·용어·예시) — 2026-08-12부터 프로젝트별로 분리, updateProject로 저장 ──
// (예전엔 전역 POST /api/instructions 하나였음 — 프로젝트마다 다른 few-shot이 서로
// 섞여 들어가는 문제가 있어 폐기. InstructionsPanel은 activeProject.instructions를
// 받아 updateProject(id, { instructions })로 저장한다 — App.tsx의 handleSaveInstructions 참고.)
//
// 로그를 훑어 한 번에 채우던 전역 초안 생성(GET /api/instructions/draft)은 뺐다 —
// 조인은 다이어그램에서 클릭으로, 용어는 "정의 필요" 목록에서, 예시는 "노트북에서
// 가져오기"에서 각 탭이 이미 자기 프로젝트 범위의 후보를 보여줘서 중복이었다.
