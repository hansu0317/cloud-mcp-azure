export const APP_NAME  = import.meta.env.VITE_APP_NAME  ?? 'CRM AI'
export const CONN_NAME = import.meta.env.VITE_CONN_NAME ?? 'Cloud'

// 네비게이션 허브 — 설정 시에만 헤더에 "마케팅 포털" 링크 노출 (선택)
export const MARKETING_PORTAL_URL: string | undefined = import.meta.env.VITE_MARKETING_PORTAL_URL

export const API = {
  CHAT:           '/api/chat',
  INSTRUCTIONS:   '/api/instructions',
  LOGS:           '/api/logs',
  DESCRIBE:       '/api/describe',
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
