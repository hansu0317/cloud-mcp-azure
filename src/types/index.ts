// 프론트엔드 전용 타입 + shared 타입 재수출

export type {
  Instructions, JoinDef, TermDef, ExampleDef,
  LogEntry, ServerStats,
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
}

export interface Cell {
  id:     number
  type:   'ai'
  text:   string
  output: CellOutput | null
}

// 채팅 메시지
export type MessageStatus = 'typing' | 'streaming' | 'tool' | 'done' | 'error'

export interface QueryLog {
  tool:  string
  input: Record<string, unknown>
}

export interface Message {
  id:       number
  role:     'user' | 'ai'
  content:  string
  status?:  MessageStatus
  toolName?: string | null
  queries?: QueryLog[]
}

// 즐겨찾기
export interface Bookmark {
  text: string
  type: 'ai'
  at:   string
}

// 카탈로그
export interface TableEntry {
  name:  string
  label: string
}

export interface CatalogGroup {
  domain: string
  icon:   string
  tables: TableEntry[]
}

export interface TableMeta extends TableEntry {
  domain: string
}

// streamChat 옵션
export interface StreamChatOptions {
  message:   string
  sessionId: string
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
