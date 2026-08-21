"""FastAPI 채팅 런타임의 도구 루프·동시성·메모리 경계 회귀 테스트."""

from __future__ import annotations

import asyncio
import json
import shutil
import unittest
import uuid
from copy import deepcopy
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI

from backend import chat_api
from backend.semaphore import Semaphore


def _assistant_done(text: str) -> dict[str, Any]:
    return {
        "type": "done",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
        "toolCalls": [],
        "stopReason": "end_turn",
        "usage": {"inputTokens": 3, "outputTokens": 2},
    }


class _ToolLoopProvider:
    kind = "anthropic"
    model = "deterministic-test"
    endpoint = "https://provider.invalid"

    def __init__(self) -> None:
        self.requests = []

    def is_configured(self) -> bool:
        return True

    async def stream(self, request):
        self.requests.append(
            {
                "system": request.system,
                "messages": deepcopy(list(request.messages)),
                "tools": tuple(tool.name for tool in request.tools),
            }
        )
        last_content = request.messages[-1].get("content", [])
        has_tool_result = any(
            isinstance(block, dict) and block.get("type") == "tool_result"
            for block in last_content
        )
        if has_tool_result:
            yield {"type": "text", "text": "실제 조회 완료"}
            yield _assistant_done("실제 조회 완료")
            return

        calls = [
            {
                "id": "describe-1",
                "name": "dataverse_describe_table",
                "input": {"table": "account"},
            },
            {
                "id": "query-1",
                "name": "dataverse_query",
                "input": {"path": "accounts?$select=name&$top=999"},
            },
        ]
        for call in calls:
            yield {"type": "tool_start", "name": call["name"]}
        yield {
            "type": "done",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_call",
                        "id": call["id"],
                        "name": call["name"],
                        "input": call["input"],
                    }
                    for call in calls
                ],
            },
            "toolCalls": calls,
            "stopReason": "tool_use",
            "usage": {"inputTokens": 5, "outputTokens": 1},
        }


class _SerialProvider:
    kind = "ollama"
    model = "deterministic-serial"
    endpoint = "http://provider.invalid"

    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.requests: list[list[dict[str, Any]]] = []

    def is_configured(self) -> bool:
        return True

    async def stream(self, request):
        self.requests.append(deepcopy(list(request.messages)))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0.03)
            yield {"type": "text", "text": "직렬 완료"}
            yield _assistant_done("직렬 완료")
        finally:
            self.active -= 1


class SemaphoreCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_waiters_do_not_leak_active_capacity(self) -> None:
        semaphore = Semaphore(1)
        await semaphore.acquire()

        cancelled_waiter = asyncio.create_task(semaphore.acquire())
        surviving_waiter = asyncio.create_task(semaphore.acquire())
        await asyncio.sleep(0)
        self.assertEqual(semaphore.pending, 2)

        cancelled_waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled_waiter
        self.assertEqual(semaphore.pending, 1)

        semaphore.release()
        await surviving_waiter
        self.assertEqual((semaphore.size, semaphore.pending), (1, 0))
        semaphore.release()
        self.assertEqual(semaphore.size, 0)

    async def test_release_skips_done_waiter_and_grant_cancel_returns_slot(self) -> None:
        semaphore = Semaphore(1)
        await semaphore.acquire()
        done_waiter = asyncio.create_task(semaphore.acquire())
        await asyncio.sleep(0)
        semaphore._queue[0].cancel()  # release가 stale/done future를 건너뛰는 회귀 조건
        semaphore.release()
        with self.assertRaises(asyncio.CancelledError):
            await done_waiter
        self.assertEqual((semaphore.size, semaphore.pending), (0, 0))

        await semaphore.acquire()
        granted_then_cancelled = asyncio.create_task(semaphore.acquire())
        await asyncio.sleep(0)
        semaphore.release()  # active 슬롯을 waiter에 이전하되 아직 task는 재개 전
        granted_then_cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await granted_then_cancelled
        self.assertEqual((semaphore.size, semaphore.pending), (0, 0))


class SessionLockCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        chat_api._history_map.clear()
        chat_api._session_locks.clear()

    async def asyncTearDown(self) -> None:
        chat_api._history_map.clear()
        chat_api._session_locks.clear()

    async def test_cancelled_lock_waiter_releases_reference_and_cleanup_removes_stale(self) -> None:
        owner = await chat_api._acquire_session_lock("same-session")
        waiter = asyncio.create_task(chat_api._acquire_session_lock("same-session"))
        await asyncio.sleep(0)
        self.assertEqual(owner.users, 2)

        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(owner.users, 1)

        chat_api._release_session_lock(owner)
        owner.last_used = 0
        removed_history, removed_locks = chat_api._cleanup_stale_sessions(
            chat_api.SESSION_TTL_S + 1
        )
        self.assertEqual((removed_history, removed_locks), (0, 1))
        self.assertNotIn("same-session", chat_api._session_locks)


class ChatRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.root.mkdir(parents=True)
        self.schema_file = self.root / "schema.json"
        self.schema_file.write_text(
            json.dumps(
                {
                    "account": {
                        "label": "고객",
                        "domain": "영업",
                        "entitySetName": "accounts",
                        "schema": "| 컬럼명 | 타입 | 설명 |\n|---|---|---|\n| name | String | 이름 |",
                    }
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.provider: Any = _ToolLoopProvider()
        self.saved_histories: list[list[dict[str, Any]]] = []

        def save_history(_session_id: str, messages: list[dict[str, Any]]) -> bool:
            self.saved_histories.append(deepcopy(messages))
            return True

        self.save_history = Mock(side_effect=save_history)
        self.dataverse_get = AsyncMock(
            return_value=json.dumps(
                {"value": [{"name": f"고객-{index}"} for index in range(120)]},
                ensure_ascii=False,
            )
        )
        self.log_info = Mock()
        self.log_error = Mock()
        self.patches = [
            patch.object(chat_api, "SCHEMA_FILE", self.schema_file),
            patch.object(chat_api, "_provider", side_effect=lambda: self.provider),
            patch.object(chat_api, "dataverse_env_missing", return_value=None),
            patch.object(chat_api, "dataverse_get", self.dataverse_get),
            patch.object(chat_api, "project_exists", return_value=True),
            patch.object(chat_api, "get_project_tables", return_value=["account"]),
            patch.object(
                chat_api,
                "get_project_instructions",
                return_value={
                    "joins": [],
                    "terms": [
                        {
                            "table": "account",
                            "column": "name",
                            "term": "서버 용어",
                            "def": "SERVER-INSTRUCTION",
                        }
                    ],
                    "examples": [],
                },
            ),
            patch.object(chat_api, "get_project_history", return_value=[]),
            patch.object(chat_api, "save_project_history", self.save_history),
            patch.object(chat_api.log, "info", self.log_info),
            patch.object(chat_api.log, "error", self.log_error),
            patch.object(chat_api, "api_semaphore", Semaphore(2)),
        ]
        for item in self.patches:
            item.start()
        chat_api._history_map.clear()
        chat_api._session_locks.clear()

        app = FastAPI()
        chat_api.register_chat_api(app)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        chat_api._history_map.clear()
        chat_api._session_locks.clear()
        for item in reversed(self.patches):
            item.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def _events(response: httpx.Response) -> list[dict[str, Any]]:
        return [
            json.loads(line.removeprefix("data: "))
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]

    async def _chat(self, message: str, session_id: str = "session-1") -> httpx.Response:
        return await self.client.post(
            "/api/chat", json={"message": message, "sessionId": session_id}
        )

    async def test_real_sse_tool_loop_uses_server_scope_and_saves_history(self) -> None:
        response = await self._chat("고객을 조회해줘")
        self.assertEqual(response.status_code, 200)
        events = self._events(response)
        self.assertEqual(
            [event["type"] for event in events],
            ["tool", "tool", "query", "query", "text", "done"],
        )

        self.assertEqual(len(self.provider.requests), 2)
        first = self.provider.requests[0]
        self.assertIn("SERVER-INSTRUCTION", first["system"])
        self.assertIn("account", first["system"])
        self.assertEqual(
            first["tools"], ("dataverse_query", "dataverse_describe_table")
        )
        self.dataverse_get.assert_awaited_once_with(
            "accounts?$select=name&$top=100"
        )

        second_messages = self.provider.requests[1]["messages"]
        tool_results = second_messages[-1]["content"]
        query_result = next(
            result for result in tool_results if result["name"] == "dataverse_query"
        )
        self.assertLessEqual(len(query_result["content"].encode("utf-8")), 8 * 1024)
        self.assertLessEqual(len(json.loads(query_result["content"])), 100)

        self.assertEqual(self.save_history.call_count, 1)
        self.assertEqual(self.saved_histories[-1][-1]["role"], "assistant")
        self.assertEqual(chat_api.api_status()["active"], 0)
        answer_log = next(
            call for call in self.log_info.call_args_list if call.args[0] == "API-답변"
        )
        data = answer_log.args[2]
        self.assertEqual(data["sessionId"], "session-1")
        self.assertTrue(data["requestId"])
        self.assertEqual(data["successfulDataverseQueries"], 1)

    async def test_same_session_requests_are_serialized(self) -> None:
        self.provider = _SerialProvider()
        responses = await asyncio.gather(
            self._chat("첫 번째", "same-session"),
            self._chat("두 번째", "same-session"),
        )
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertEqual(self.provider.max_active, 1)
        self.assertEqual(len(self.saved_histories), 2)
        self.assertGreater(len(self.saved_histories[1]), len(self.saved_histories[0]))
        self.assertEqual(chat_api.api_status()["active"], 0)
        lock_state = chat_api._session_locks["same-session"]
        self.assertEqual(lock_state.users, 0)
        self.assertFalse(lock_state.lock.locked())

    async def test_save_error_rolls_back_cached_history_and_releases_capacity(self) -> None:
        self.provider = _SerialProvider()
        first = await self._chat("성공", "rollback-session")
        self.assertEqual(self._events(first)[-1]["type"], "done")
        before = deepcopy(chat_api._history_map["rollback-session"].messages)

        self.save_history.side_effect = lambda *_args: False
        failed = await self._chat("저장 실패", "rollback-session")
        events = self._events(failed)
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("히스토리", events[-1]["message"])
        self.assertEqual(chat_api._history_map["rollback-session"].messages, before)
        self.assertEqual((chat_api.api_status()["active"], chat_api.api_status()["queued"]), (0, 0))
        error_data = self.log_error.call_args.args[2]
        self.assertEqual(error_data["sessionId"], "rollback-session")
        self.assertTrue(error_data["requestId"])

    async def test_tool_output_is_valid_utf8_bounded_json_after_full_body_return(self) -> None:
        # dataverse_get mock이 큰 본문을 반환한 뒤에도 chat 계층의 downstream
        # 8 KiB/100행 상한이 독립적으로 적용되는지 확인한다.
        huge_body = json.dumps(
            {"value": [{"name": "한" * 10_000} for _ in range(150)]},
            ensure_ascii=False,
        )
        with patch.object(chat_api, "dataverse_get", AsyncMock(return_value=huge_body)):
            result = await chat_api._dataverse_query("accounts?$count=true", ["account"])

        self.assertLessEqual(len(result.encode("utf-8")), 8 * 1024)
        parsed = json.loads(result)
        rows = parsed.get("value", []) if isinstance(parsed, dict) else parsed
        self.assertLessEqual(len(rows), 100)
        self.assertIn("dataverse_get", chat_api._dataverse_query.__doc__ or "")


if __name__ == "__main__":
    unittest.main()
