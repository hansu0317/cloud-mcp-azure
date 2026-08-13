"""Dataverse REST 런타임의 크기 제한·재시도·Choice 스키마 계약 테스트."""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from backend import dataverse


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


class DataverseRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_limit_rejects_content_length_before_read(self) -> None:
        response = httpx.Response(
            200,
            headers={"Content-Length": "100", "Content-Type": "application/json; charset=utf-8"},
            stream=_ChunkStream([b"{}"]),
        )
        with patch.object(dataverse, "dataverse_fetch", AsyncMock(return_value=response)):
            with self.assertRaisesRegex(RuntimeError, "허용 크기"):
                await dataverse.dataverse_get("accounts?$top=1", max_bytes=10)

        self.assertTrue(response.is_closed)

    async def test_response_limit_stops_chunked_body(self) -> None:
        response = httpx.Response(
            200,
            headers={"Content-Type": "application/json; charset=utf-8"},
            stream=_ChunkStream([b"1234", b"5678"]),
        )
        with patch.object(dataverse, "dataverse_fetch", AsyncMock(return_value=response)):
            with self.assertRaisesRegex(RuntimeError, "허용 크기"):
                await dataverse.dataverse_get("accounts?$top=1", max_bytes=6)

        self.assertTrue(response.is_closed)

    async def test_429_uses_bounded_retry_after_then_succeeds(self) -> None:
        throttled = httpx.Response(429, headers={"Retry-After": "30"}, content=b"throttled")
        success = httpx.Response(
            200,
            headers={"Content-Type": "application/json; charset=utf-8"},
            content=b'{"value":[]}',
        )
        fetch = AsyncMock(side_effect=[throttled, success])
        sleep = AsyncMock()
        with (
            patch.object(dataverse, "dataverse_fetch", fetch),
            patch.object(dataverse, "RETRY_MAX_DELAY_S", 1.5),
            patch.object(dataverse.asyncio, "sleep", sleep),
        ):
            text = await dataverse.dataverse_get("accounts?$top=0")

        self.assertEqual(json.loads(text), {"value": []})
        self.assertEqual(fetch.await_count, 2)
        sleep.assert_awaited_once_with(1.5)
        self.assertTrue(throttled.is_closed)

    async def test_transport_retry_count_is_bounded(self) -> None:
        request = httpx.Request("GET", "https://example.invalid")
        fetch = AsyncMock(side_effect=httpx.ConnectError("offline", request=request))
        sleep = AsyncMock()
        with (
            patch.object(dataverse, "dataverse_fetch", fetch),
            patch.object(dataverse, "MAX_RETRIES", 2),
            patch.object(dataverse, "RETRY_BASE_S", 0.1),
            patch.object(dataverse, "RETRY_MAX_DELAY_S", 1.0),
            patch.object(dataverse.asyncio, "sleep", sleep),
        ):
            with self.assertRaises(httpx.ConnectError):
                await dataverse.dataverse_get("accounts?$top=0")

        self.assertEqual(fetch.await_count, 3)
        self.assertEqual(sleep.await_count, 2)

    async def test_429_retry_count_is_bounded(self) -> None:
        responses = [httpx.Response(429, content=b"throttled") for _ in range(3)]
        fetch = AsyncMock(side_effect=responses)
        with (
            patch.object(dataverse, "dataverse_fetch", fetch),
            patch.object(dataverse, "MAX_RETRIES", 2),
            patch.object(dataverse.asyncio, "sleep", AsyncMock()),
        ):
            with self.assertRaisesRegex(RuntimeError, "OData 429"):
                await dataverse.dataverse_get("accounts?$top=0")

        self.assertEqual(fetch.await_count, 3)
        self.assertTrue(all(response.is_closed for response in responses))

    async def test_choice_types_include_numeric_codes_in_schema(self) -> None:
        attributes = [
            {"LogicalName": "categorycode", "AttributeType": "Picklist", "DisplayName": {}},
            {"LogicalName": "statecode", "AttributeType": "State", "DisplayName": {}},
            {"LogicalName": "statuscode", "AttributeType": "Status", "DisplayName": {}},
            {
                "LogicalName": "interests",
                "AttributeType": "MultiSelectPicklist",
                "DisplayName": {},
            },
        ]
        root_metadata = json.dumps({"EntitySetName": "samples", "Attributes": attributes})
        option_metadata = json.dumps(
            {
                "OptionSet": {
                    "Options": [
                        {
                            "Value": 1,
                            "Label": {"UserLocalizedLabel": {"Label": "활성"}},
                        }
                    ]
                }
            },
            ensure_ascii=False,
        )
        calls: list[tuple[str, int | None]] = []

        async def fake_get(path: str, *, max_bytes: int | None = None) -> str:
            calls.append((path, max_bytes))
            return root_metadata if "?$select=EntitySetName" in path else option_metadata

        with patch.object(dataverse, "dataverse_get", side_effect=fake_get):
            result = await dataverse.fetch_entity_schema("sample")

        self.assertEqual(result.entity_set_name, "samples")
        self.assertEqual(result.markdown.count("1=활성"), 4)
        for cast_name in (
            "PicklistAttributeMetadata",
            "StateAttributeMetadata",
            "StatusAttributeMetadata",
            "MultiSelectPicklistAttributeMetadata",
        ):
            self.assertTrue(any(cast_name in path for path, _ in calls))
        self.assertTrue(all(limit == dataverse.METADATA_MAX_RESPONSE_BYTES for _, limit in calls))

    async def test_picklist_option_requests_share_concurrency_limit(self) -> None:
        active = 0
        maximum_active = 0

        async def fake_get(_path: str, *, max_bytes: int | None = None) -> str:
            nonlocal active, maximum_active
            self.assertEqual(max_bytes, dataverse.METADATA_MAX_RESPONSE_BYTES)
            active += 1
            maximum_active = max(maximum_active, active)
            await asyncio.sleep(0)
            active -= 1
            return '{"OptionSet":{"Options":[{"Value":1,"Label":{}}]}}'

        with (
            patch.object(dataverse, "_picklist_semaphore", asyncio.Semaphore(2)),
            patch.object(dataverse, "dataverse_get", side_effect=fake_get),
        ):
            results = await asyncio.gather(
                *(dataverse._fetch_picklist_options("sample", f"choice{index}") for index in range(6))
            )

        self.assertEqual(maximum_active, 2)
        self.assertEqual(results, ["1=1"] * 6)

    async def test_close_dataverse_client_closes_global_pool(self) -> None:
        client = AsyncMock()
        client.is_closed = False
        with patch.object(dataverse, "_http", client):
            await dataverse.close_dataverse_client()

        client.aclose.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
