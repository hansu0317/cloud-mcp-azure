// 프론트엔드 전용 타입 + shared 타입 재수출

export type {
  Instructions, JoinDef, TermDef, ExampleDef,
  LogEntry, ProjectSummary,
} from '../../shared/types'

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
