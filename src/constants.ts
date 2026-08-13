export const APP_NAME  = import.meta.env.VITE_APP_NAME  ?? 'CRM AI'
export const CONN_NAME = import.meta.env.VITE_CONN_NAME ?? 'Cloud'

export const API = {
  CHAT:               '/api/chat',
  INSTRUCTIONS_DRAFT: '/api/instructions/draft',   // 지침 저장/조회는 PROJECTS(프로젝트별)로 이동, 초안 생성만 전역
  LOGS:               '/api/logs',
  DESCRIBE:           '/api/describe',
  TABLES:             '/api/tables',
  SCHEMA_REFRESH:     '/api/schemas/refresh',
  PROJECTS:           '/api/projects',
} as const

export const CELLS_AUTOSAVE_DEBOUNCE_MS = 900

export const SIDEBAR_MIN_W = 140
export const SIDEBAR_MAX_W = 480

export const CHAT_TA_MAX_H = 160
export const CELL_TA_MAX_H = 280

export const TOAST_DURATION_MS   = 2_200

export const LOG_REFRESH_MS   = 10_000
export const LOG_MAX_ENTRIES  = 200
export const LOG_DATA_PREVIEW = 160
