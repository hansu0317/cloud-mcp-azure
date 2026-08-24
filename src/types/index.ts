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
