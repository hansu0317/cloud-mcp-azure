// 서버 ↔ 클라이언트 공유 타입

export type CellType = 'ai' | 'sql'

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

// 서버 통계
export interface ServerStats {
  uptime:          number
  sessions:        number
  queries:         number
  toolCalls:       number
  securityBlocks:  number
  activeSessions:  number
  activeProcs?:    number
  maxProcs?:       number
  queuedRequests?: number
}
