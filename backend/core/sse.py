"""SSE(Server-Sent Events) 헬퍼 + HTTP 상태 코드 상수.

15초 간격 하트비트(SSE 주석 라인)를 함께 보내 프록시(nginx 등)의 유휴 타임아웃으로
스트림이 조용히 끊기는 것을 막는다 — 클라이언트 파서는 'data: ' 라인만 읽으므로 무해.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from starlette.requests import Request

HEARTBEAT_INTERVAL_S = 15


class HttpStatus:
    OK = 200
    BAD_REQUEST = 400
    UNAUTHORIZED = 401
    FORBIDDEN = 403
    NOT_FOUND = 404
    TOO_MANY_REQUESTS = 429
    INTERNAL_SERVER_ERROR = 500
    NOT_IMPLEMENTED = 501
    SERVICE_UNAVAILABLE = 503


class SseChannel:
    """이벤트 발행측(send/close)과 스트리밍 응답측(generator)을 잇는 큐."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._closed = False

    def send(self, event: dict[str, Any]) -> None:
        if not self._closed:
            self._queue.put_nowait(event)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def stream(self, request: Request) -> AsyncIterator[bytes]:
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=HEARTBEAT_INTERVAL_S)
            except asyncio.TimeoutError:
                yield b":hb\n\n"
                continue
            if event is None:
                break
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


SSE_HEADERS = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}
