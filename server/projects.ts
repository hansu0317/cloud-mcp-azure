// ─────────────────────────────────────────────────────────────────────────────
// 프로젝트 영속화 — data/projects/<id>.json 파일 하나당 프로젝트 하나.
//
// "새 세션"(휘발성, 이름 없음)을 완전히 대체하는 개념이다. 프로젝트는
//   - 이름
//   - 테이블 스코프(tables — 빈 배열이면 "전체 테이블", 즉 스코프 제한 없음)
//   - 노트북 셀(cells — 프론트 전용 구조, 서버는 내용을 해석하지 않고 그대로 보관)
//   - Claude 대화 히스토리(history — 프론트에는 절대 내려주지 않음, chat-api.ts 전용)
// 를 파일로 들고 있어 서버 재시작·새 브라우저 창에서도 사용자가 직접 삭제하기
// 전까지 사라지지 않는다.
//
// data/ 전체가 .gitignore 대상이라 별도 조치 없이 커밋에서 제외된다.
// ─────────────────────────────────────────────────────────────────────────────
import fs     from 'fs'
import path   from 'path'
import crypto from 'crypto'
import log    from './logger'

const PROJECTS_DIR = path.join(process.cwd(), 'data', 'projects')
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true })

interface StoredProject {
  id:        string
  name:      string
  tables:    string[]   // 빈 배열 = 전체 테이블(스코프 제한 없음)
  cells:     unknown[]
  history:   unknown[]
  createdAt: string
  updatedAt: string
}

export interface ProjectSummary {
  id:         string
  name:       string
  tables:     string[]
  createdAt:  string
  updatedAt:  string
}

export type ProjectDetail = Omit<StoredProject, 'history'>

// UUID 형태만 허용 — 경로 탈출(예: "../../etc") 방지
const ID_RE = /^[a-zA-Z0-9-]+$/

function filePath(id: string): string {
  return path.join(PROJECTS_DIR, `${id}.json`)
}

// 아래 두 함수는 절대 await를 포함하지 않는다(동기 fs 호출만 사용) — Node는
// 단일 스레드라 동기 함수 하나가 event loop 틱 중간에 끊기지 않으므로, 같은
// 프로젝트 id에 대한 동시 요청(예: 셀 자동저장 PATCH와 채팅 히스토리 저장)이
// 읽기-수정-쓰기 사이에 서로 끼어들 수 없다. 즉 별도 락 없이 안전하다.
function readProject(id: string): StoredProject | null {
  if (!ID_RE.test(id)) return null
  try { return JSON.parse(fs.readFileSync(filePath(id), 'utf8')) as StoredProject }
  catch { return null }
}

function writeProject(p: StoredProject): void {
  fs.writeFileSync(filePath(p.id), JSON.stringify(p, null, 2))
}

function toSummary(p: StoredProject): ProjectSummary {
  return { id: p.id, name: p.name, tables: p.tables, createdAt: p.createdAt, updatedAt: p.updatedAt }
}

function toDetail(p: StoredProject): ProjectDetail {
  const { history: _history, ...rest } = p
  return rest
}

export function listProjects(): ProjectSummary[] {
  let files: string[] = []
  try { files = fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')) }
  catch { return [] }

  const list = files
    .map(f => readProject(path.basename(f, '.json')))
    .filter((p): p is StoredProject => p !== null)
    .map(toSummary)
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))   // 최근 사용순
  return list
}

export function getProject(id: string): ProjectDetail | null {
  const p = readProject(id)
  return p ? toDetail(p) : null
}

export function createProject(name: string, tables: string[] = []): ProjectDetail {
  const id  = crypto.randomUUID()
  const now = new Date().toISOString()
  const p: StoredProject = {
    id, name: name.trim() || '제목 없는 프로젝트', tables, cells: [], history: [],
    createdAt: now, updatedAt: now,
  }
  writeProject(p)
  log.info('PROJECT', `생성: "${p.name}" (${id})`)
  return toDetail(p)
}

export function updateProject(
  id: string,
  patch: { name?: string; tables?: string[]; cells?: unknown[] },
): ProjectDetail | null {
  const p = readProject(id)
  if (!p) return null
  if (patch.name   !== undefined) p.name   = patch.name.trim() || p.name
  if (patch.tables !== undefined) p.tables = patch.tables
  if (patch.cells  !== undefined) p.cells  = patch.cells
  p.updatedAt = new Date().toISOString()
  writeProject(p)
  return toDetail(p)
}

export function deleteProject(id: string): boolean {
  if (!ID_RE.test(id)) return false
  try { fs.unlinkSync(filePath(id)); log.info('PROJECT', `삭제: ${id}`); return true }
  catch { return false }
}

// ─── 채팅 히스토리(LLM 컨텍스트) — chat-api.ts 전용, /api/projects 응답에는 절대 포함하지 않음 ──
export function getProjectHistory(id: string): unknown[] {
  return readProject(id)?.history ?? []
}

export function getProjectTables(id: string): string[] {
  return readProject(id)?.tables ?? []
}

export function saveProjectHistory(id: string, history: unknown[]): void {
  const existing = readProject(id)
  const now = new Date().toISOString()
  const p: StoredProject = existing ?? {
    id, name: '제목 없는 프로젝트', tables: [], cells: [], history: [], createdAt: now, updatedAt: now,
  }
  p.history   = history
  p.updatedAt = now
  writeProject(p)
}
