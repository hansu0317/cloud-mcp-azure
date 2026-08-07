"""동시 실행 제어 — Claude API 스트림 수 제한 (대기열 + 포화 시 즉시 429 판단).

server/semaphore.ts 포팅. asyncio.Semaphore는 대기열 길이를 노출하지 않으므로
직접 큐를 관리한다.
"""
from __future__ import annotations

import asyncio


class Semaphore:
    def __init__(self, max_: int) -> None:
        self._max = max_
        self._active = 0
        self._queue: list[asyncio.Future[None]] = []

    async def acquire(self) -> None:
        if self._active < self._max:
            self._active += 1
            return
        fut: asyncio.Future[None] = asyncio.get_event_loop().create_future()
        self._queue.append(fut)
        await fut

    def release(self) -> None:
        if self._queue:
            fut = self._queue.pop(0)
            if not fut.done():
                fut.set_result(None)
        else:
            self._active -= 1

    @property
    def size(self) -> int:
        return self._active

    @property
    def pending(self) -> int:
        return len(self._queue)

    def is_overloaded(self) -> bool:
        """활성 + 대기가 모두 꽉 찬 경우 (즉시 거절 기준)."""
        return self._active >= self._max and len(self._queue) >= self._max * 2
