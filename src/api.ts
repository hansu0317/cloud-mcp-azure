import { marked }     from 'marked'
import DOMPurify      from 'dompurify'
import { API } from './constants'
import type { Instructions, StreamChatOptions, ProjectDetail } from './types'
import type { SseEvent, ProjectSummary } from '../shared/types'

export function renderMd(text: string): string {
  if (!text) return ''
  return DOMPurify.sanitize(marked.parse(text) as string)
}

// 세션별 instructions 전송 여부 추적 — 첫 메시지에만 지침 첨부 (스키마는 서버에서 주입)
const contextSentSessions = new Set<string>()

export function buildMessage(question: string, sessionId: string, instructions: Partial<Instructions> = {}): string {
  if (contextSentSessions.has(sessionId)) return question
  contextSentSessions.add(sessionId)

  const parts: string[] = []

  if (instructions.joins?.length)
    parts.push(`[테이블 관계: ${instructions.joins.map(j =>
      `${j.fromTable}.${j.fromCol}=${j.toTable}.${j.toCol}${j.label ? `(${j.label})` : ''}`
    ).join(', ')}]`)

  if (instructions.terms?.length)
    parts.push(`[컬럼 용어: ${instructions.terms.map(t =>
      `${t.table}.${t.column}="${t.term}":${t.def}`
    ).join(' / ')}]`)

  if (instructions.examples?.length)
    parts.push(`[참고 예시]\n${instructions.examples.map(e =>
      `Q: ${e.question}\nA: ${e.answer}`
    ).join('\n\n')}`)

  return parts.length ? `${parts.join('\n')}\n\n${question}` : question
}

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { message, sessionId, tables, onText, onTool, onQuery, onDone, onError } = opts

  const resp = await fetch(API.CHAT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message, sessionId, tables }),
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
  patch: { name?: string; tables?: string[]; cells?: unknown[] },
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

// ─── 지침 (조인 관계·용어·예시) — InstructionsModal이 씀 ────────────────────
export async function saveInstructions(instructions: Instructions): Promise<void> {
  await fetch(API.INSTRUCTIONS, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(instructions),
  })
}
