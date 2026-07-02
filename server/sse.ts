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

// SSE 응답 헤더를 설정하고 이벤트 전송 함수를 반환.
// 15초 간격 하트비트(SSE 주석 라인)를 함께 보내 프록시(nginx 등)의 유휴 타임아웃으로
// 스트림이 조용히 끊기는 것을 막는다 — 클라이언트 파서는 'data: ' 라인만 읽으므로 무해.
export function setupSse(res: Response): (event: SseEvent) => void {
  res.setHeader('Content-Type',      'text/event-stream')
  res.setHeader('Cache-Control',     'no-cache')
  res.setHeader('Connection',        'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(':hb\n\n')
  }, 15_000)
  heartbeat.unref()
  res.on('close', () => clearInterval(heartbeat))

  return (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
}
