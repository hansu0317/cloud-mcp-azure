"""backend/mcp_server.py 계약 테스트.

Dataverse 자격증명 없이도 검증 가능한 것만 다룬다:
  - MCP 서버가 chat_api의 같은 가드 함수를 그대로 재사용하는지(로직이 갈라지지
    않는지)
  - 도구/리소스가 MCP 데코레이터에 정상 등록되는지
  - dataverse_query가 화이트리스트 밖 엔티티를 여전히 거부하는지(가드 유지)

실제 Dataverse 호출(dataverse_query 성공 케이스)은 자격증명이 필요해 여기서
다루지 않는다 — 그건 tests_python/test_dataverse_runtime.py와 웹앱 안전 E2E가
이미 검증한다.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.dataverse import SchemaEntry
from backend import mcp_server


class McpServerRegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_registered(self) -> None:
        tools = await mcp_server.app.list_tools()
        self.assertEqual({t.name for t in tools}, {"dataverse_describe_table", "dataverse_query"})

    async def test_catalog_resource_registered(self) -> None:
        resources = await mcp_server.app.list_resources()
        self.assertTrue(any(str(r.uri) == "dataverse://catalog" for r in resources))


class McpServerToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._schema_patch = patch.object(
            mcp_server,
            "_read_schema_file",
            return_value={
                "new_q1": SchemaEntry(
                    label="거래처",
                    domain="영업",
                    schema="| 컬럼명 | 타입 | 한국어 설명 |\n|---|---|---|\n| name | String | 이름 |",
                    entity_set_name="new_q1s",
                )
            },
        )
        self._schema_patch.start()
        self.addCleanup(self._schema_patch.stop)

    async def test_describe_table_reuses_chat_api_cache_lookup(self) -> None:
        result = await mcp_server.dataverse_describe_table("new_q1")
        self.assertIn("new_q1", result)
        self.assertIn("엔티티집합명: new_q1s", result)

    async def test_describe_table_unknown_table(self) -> None:
        result = await mcp_server.dataverse_describe_table("no_such_table")
        self.assertIn("스키마 정보가 없습니다", result)

    async def test_query_rejects_entity_outside_whitelist(self) -> None:
        with patch.object(mcp_server, "dataverse_env_missing", return_value=None):
            with self.assertRaisesRegex(ValueError, "허용되지 않은 엔티티 집합명"):
                await mcp_server.dataverse_query("systemusers?$top=1")

    async def test_query_reports_missing_env_before_network_call(self) -> None:
        with patch.object(mcp_server, "dataverse_env_missing", return_value="DATAVERSE_URL"):
            result = await mcp_server.dataverse_query("new_q1s?$top=1")
        self.assertIn("DATAVERSE_URL", result)

    async def test_catalog_lists_registered_table(self) -> None:
        with patch.object(mcp_server, "dataverse_env_missing", return_value=None):
            result = await mcp_server.catalog()
        self.assertIn("new_q1", result)
        self.assertIn("new_q1s", result)


if __name__ == "__main__":
    unittest.main()
