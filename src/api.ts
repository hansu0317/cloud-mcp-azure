import { marked }     from 'marked'
import DOMPurify      from 'dompurify'
import { API } from './constants'
import type { Instructions, StreamChatOptions, ProjectDetail, ProjectSummary, SseEvent } from './types'

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

export async function updateProject(
  id: string,
  patch: { name?: string; tables?: string[]; instructions?: Instructions; cells?: unknown[] },
): Promise<void> {
  await fetch(`${API.PROJECTS}/${id}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(patch),
  })
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

// ─── 지침 (조인 관계·용어·예시) — 2026-08-12부터 프로젝트별로 분리, updateProject로 저장 ──
// (예전엔 전역 POST /api/instructions 하나였음 — 프로젝트마다 다른 few-shot이 서로
// 섞여 들어가는 문제가 있어 폐기. InstructionsPanel은 activeProject.instructions를
// 받아 updateProject(id, { instructions })로 저장한다 — App.tsx의 handleSaveInstructions 참고.)
//
// 로그를 훑어 한 번에 채우던 전역 초안 생성(GET /api/instructions/draft)은 뺐다 —
// 조인은 다이어그램에서 클릭으로, 용어는 "정의 필요" 목록에서, 예시는 "노트북에서
// 가져오기"에서 각 탭이 이미 자기 프로젝트 범위의 후보를 보여줘서 중복이었다.
