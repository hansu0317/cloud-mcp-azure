"""동시 실행 제어 — LLM provider 스트림 수 제한 (대기열 + 포화 시 즉시 429 판단).

asyncio.Semaphore는 대기열 길이를 노출하지 않으므로
직접 큐를 관리한다.
"""
from __future__ import annotations

import asyncio


class Semaphore:
    def __init__(self, max_: int) -> None:
        if max_ <= 0:
            raise ValueError("max_ must be greater than zero")
        self._max = max_
        self._active = 0
        self._queue: list[asyncio.Future[None]] = []

    async def acquire(self) -> None:
        if self._active < self._max:
            self._active += 1
            return
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._queue.append(fut)
        try:
            await fut
        except BaseException:
            # 대기 중 취소되면 큐에서 제거한다. release()가 이미 이 waiter에
            # 용량을 넘긴 직후 취소된 경우에는 그 용량을 다음 waiter로 다시
            # 전달(또는 active 감소)해야 슬롯이 영구 누수되지 않는다.
            try:
                self._queue.remove(fut)
            except ValueError:
                if fut.done() and not fut.cancelled():
                    self.release()
            raise

    def release(self) -> None:
        while self._queue:
            fut = self._queue.pop(0)
            if fut.done():
                continue
            # 활성 슬롯은 감소시키지 않고 대기자에게 소유권을 이전한다.
            fut.set_result(None)
            return
        if self._active <= 0:
            raise RuntimeError("Semaphore released too many times")
        self._active -= 1

    @property
    def size(self) -> int:
        return self._active

    @property
    def pending(self) -> int:
        return sum(1 for fut in self._queue if not fut.done())

    def is_overloaded(self) -> bool:
        """활성 + 대기가 모두 꽉 찬 경우 (즉시 거절 기준)."""
        return self._active >= self._max and self.pending >= self._max * 2
