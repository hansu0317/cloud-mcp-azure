export const APP_NAME  = import.meta.env.VITE_APP_NAME  ?? 'CRM AI'
export const CONN_NAME = import.meta.env.VITE_CONN_NAME ?? 'Cloud'

export const API = {
  CHAT:           '/api/chat',
  CHAT_API:       '/api/chat-api',
  INSTRUCTIONS:   '/api/instructions',
  LOGS:           '/api/logs',
  STATS:          '/api/stats',
  DESCRIBE:       '/api/describe',
  SESSION_NEW:    '/api/session/new',
  TABLES:         '/api/tables',
  SCHEMA_REFRESH: '/api/schemas/refresh',
} as const

export const SIDEBAR_MIN_W = 140
export const SIDEBAR_MAX_W = 480

export const CHAT_TA_MAX_H = 160
export const CELL_TA_MAX_H = 280

export const TOAST_DURATION_MS   = 2_200

export const LOG_REFRESH_MS   = 10_000
export const LOG_MAX_ENTRIES  = 200
export const LOG_DATA_PREVIEW = 160
