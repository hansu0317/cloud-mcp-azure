// 서버 ↔ 클라이언트 공유 타입

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

