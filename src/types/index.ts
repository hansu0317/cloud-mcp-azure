// FastAPI JSON 계약을 표현하는 프론트엔드 타입.
export type SseEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string }
  | { type: 'query'; tool: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface JoinDef {
  fromTable: string
  fromCol: string
  toTable: string
  toCol: string
  label?: string
}

export interface TermDef {
  table: string
  column: string
  term: string
  def: string
}

export interface ExampleDef {
  question: string
  answer: string
}

export interface Instructions {
  joins: JoinDef[]
  terms: TermDef[]
  examples: ExampleDef[]
}

export interface ChatRequest {
  message: string
  sessionId: string
}

export interface LogEntry {
  time: string
  level: 'info' | 'warn' | 'error' | 'tool'
  category: string
  message: string
  data?: Record<string, unknown>
}

export interface ProjectSummary {
  id: string
  name: string
  tables: string[]
  createdAt: string
  updatedAt: string
  order: number
  // v1(2026-08-25): 프로젝트는 전부 개인 소유(data/users/<이메일>/projects/) —
  // ownerEmail은 표시용일 뿐 화면에서 볼 수 있는 프로젝트는 항상 본인 것이다.
  ownerEmail?: string | null
}

// 노트북 셀
export interface CellOutput {
  loading:    boolean
  content:    string
  toolName:   string | null
  error:      boolean
  rawContent: string
  execN:      number
  queries?:   QueryLog[]
  elapsedMs?: number   // 응답 소요시간
}

export interface Cell {
  id:     number
  type:   'ai'
  text:   string
  output: CellOutput | null
}

// /api/projects/:id 응답 — 서버는 cells를 unknown[]로 다루지만 프론트에서는 Cell[]로 좁혀 쓴다.
// instructions는 2026-08-12부터 프로젝트별로 분리됨(이전엔 전역 /api/instructions
// 하나를 모든 프로젝트가 공유 — 관계없는 프로젝트의 few-shot이 매 질문에 섞여
// 들어가는 문제가 있었음). 오래된 캐시/서버 응답 호환을 위해 optional로 둔다.
export interface ProjectDetail {
  id:            string
  name:          string
  tables:        string[]
  instructions?: Instructions
  cells:         Cell[]
  createdAt:     string
  updatedAt:     string
  order:         number
  ownerEmail?:   string | null
  // 동시수정 감지용 버전(backend/stores의 DocumentStore가 매길 관리). 저장할 때
  // 그대로 되돌려보내면 서버가 그 사이 다른 곳에서 먼저 저장된 걸 알고 거절할 수
  // 있다(App.tsx의 저장 큐 참고). 오래된 캐시 호환을 위해 optional로 둔다.
  _rev?: number
}

export interface QueryLog {
  tool:  string
  input: Record<string, unknown>
}

// streamChat 옵션
export interface StreamChatOptions extends ChatRequest {

  onText?:   (text: string) => void
  onTool?:   (name: string) => void
  onQuery?:  (tool: string, input: Record<string, unknown>) => void
  onDone?:   () => void
  onError?:  (message: string) => void
}

// NotebookView forwardRef 핸들
export interface NotebookHandle {
  addCell: (text?: string) => number
}

// GET /auth/me 응답 — backend/auth/__init__.py 참고. loginRequired=false면 .env에
// LOGIN_*이 설정 안 된 환경(로컬 개발 클론 등)이라 로그인 화면 자체를 안 띄운다.
export type AuthMe =
  | { loginRequired: false }
  | { loginRequired: true; email: string; name: string; isAdmin: boolean }
