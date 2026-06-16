import type { Response } from 'express'
import type { SseEvent } from '../shared/types'

// HTTP 상태 코드 — 매직 넘버 대신 이름으로 참조
export const HttpStatus = {
  OK:                    200,
  BAD_REQUEST:           400,
  UNAUTHORIZED:          401,
  TOO_MANY_REQUESTS:     429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED:       501,
  SERVICE_UNAVAILABLE:   503,
} as const

// SSE 응답 헤더를 설정하고 이벤트 전송 함수를 반환
export function setupSse(res: Response): (event: SseEvent) => void {
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  return (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}
