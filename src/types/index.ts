// 프론트엔드 타입 (구 shared/types.ts 인라인 — 백엔드가 Python으로 바뀌며
// TS/Python 간 공유 타입 파일 대신 프론트 쪽에 독립적으로 정의한다.
// 서버 응답 JSON 모양은 그대로이므로 여기 필드는 backend/*.py와 계속 맞춰 유지한다.)

// SSE 스트리밍 이벤트 (서버 → 클라이언트)
export type SseEvent =
  | { type: 'text';  text: string }
  | { type: 'tool';  name: string }
  | { type: 'query'; tool: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done' }

// 지침 설정
export interface JoinDef {
  fromTable: string
  fromCol:   string
  toTable:   string
  toCol:     string
  label?:    string
}

export interface TermDef {
  table:  string
  column: string
  term:   string
  def:    string
}

export interface ExampleDef {
  question: string
  answer:   string
}

export interface Instructions {
  joins:    JoinDef[]
  terms:    TermDef[]
  examples: ExampleDef[]
}

// 로그 엔트리
export interface LogEntry {
  time:      string
  level:     'info' | 'warn' | 'error' | 'tool'
  category:  string
  message:   string
  data?:     Record<string, unknown>
}

// 프로젝트("새 세션"을 대체) — 이름 + 테이블 스코프 + 노트북 셀을 서버가 영속화한다.
// cells는 프론트 전용 구조라 서버는 내용을 해석하지 않고 그대로 저장/반환만 한다.
export interface ProjectSummary {
  id:         string
  name:       string
  tables:     string[]   // 이 프로젝트의 테이블 스코프 (빈 배열 = 전체 테이블)
  createdAt:  string
  updatedAt:  string
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
export interface ProjectDetail {
  id:        string
  name:      string
  tables:    string[]
  cells:     Cell[]
  createdAt: string
  updatedAt: string
}

export interface QueryLog {
  tool:  string
  input: Record<string, unknown>
}

// streamChat 옵션
export interface StreamChatOptions {
  message:   string
  sessionId: string
  tables?:   string[]   // 프로젝트 테이블 스코프 — 빈 배열/미지정이면 전체 테이블

  onText?:   (text: string) => void
  onTool?:   (name: string) => void
  onQuery?:  (tool: string, input: Record<string, unknown>) => void
  onDone?:   () => void
  onError?:  (message: string) => void
}

// NotebookView forwardRef 핸들
export interface NotebookHandle {
  addCell: (text?: string) => number
  runAll:  () => Promise<void>
}
