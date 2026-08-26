"""Dataverse 조회 경로와 프로젝트 스코프의 fail-closed 계약 테스트."""

from __future__ import annotations

import json
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend import chat_api
from backend.stores.local_file_store import LocalFileStore


class DataverseGuardContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.root.mkdir(parents=True)
        self.store = LocalFileStore(root=self.root)
        self.store.put(
            chat_api.SCHEMA_COLLECTION, chat_api.SCHEMA_KEY,
            {
                "tables": {
                    "account": {
                        "label": "고객",
                        "domain": "영업",
                        "entitySetName": "accounts",
                        "schema": "| 컬럼명 | 타입 | 설명 |\n|---|---|---|",
                    },
                    "contact": {
                        "label": "담당자",
                        "domain": "영업",
                        "entitySetName": "contacts",
                        "schema": "| 컬럼명 | 타입 | 설명 |\n|---|---|---|",
                    },
                },
            },
        )
        self._schema_patch = patch.object(chat_api, "get_store", lambda: self.store)
        self._schema_patch.start()

    def tearDown(self) -> None:
        self._schema_patch.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_collection_query_gets_default_top_and_keeps_explicit_limits(self) -> None:
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$select=name", []),
            "accounts?$select=name&$top=100",
        )
        self.assertEqual(
            chat_api._guard_odata_path("/accounts?$top=5", []),
            "accounts?$top=5",
        )
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$top=0&$count=true", []),
            "accounts?$top=0&$count=true",
        )
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$top=10000", []),
            "accounts?$top=100",
        )
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$count=true", []),
            "accounts?$count=true&$top=100",
        )
        self.assertEqual(
            chat_api._guard_odata_path("accounts/$count", []),
            "accounts/$count",
        )
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$apply=aggregate(revenue with sum as total)", []),
            "accounts?$apply=aggregate(revenue with sum as total)",
        )

    def test_scope_and_schema_allowlist_are_fail_closed(self) -> None:
        self.assertEqual(
            chat_api._guard_odata_path("accounts?$top=1", ["account"]),
            "accounts?$top=1",
        )
        with self.assertRaises(ValueError):
            chat_api._guard_odata_path("contacts?$top=1", ["account"])
        with self.assertRaises(ValueError):
            chat_api._guard_odata_path("invented_entities?$top=1", [])

        self.store.put(chat_api.SCHEMA_COLLECTION, chat_api.SCHEMA_KEY, {"tables": {}})
        with self.assertRaises(ValueError):
            chat_api._guard_odata_path("accounts?$top=1", [])

    def test_absolute_control_and_non_json_odata_paths_are_rejected(self) -> None:
        unsafe_paths = (
            "https://evil.example/accounts",
            "//evil.example/accounts",
            "accounts\r\nX-Test: injected",
            "accounts%0d%0aX-Test:%20injected",
            "accounts\\child",
            "accounts%5cchild",
            "accounts#fragment",
            "$batch",
            "accounts/$ref",
            "accounts(00000000-0000-0000-0000-000000000000)/$value",
        )

        for rel_path in unsafe_paths:
            with self.subTest(rel_path=rel_path), self.assertRaises(ValueError):
                chat_api._guard_odata_path(rel_path, [])

    def test_describe_respects_project_scope(self) -> None:
        allowed = chat_api._describe_table_from_cache("account", ["account"])
        denied = chat_api._describe_table_from_cache("contact", ["account"])

        self.assertIn("엔티티집합명: accounts", allowed)
        self.assertIn("스코프 밖", denied)


class SensitiveFieldRedactionTests(unittest.IsolatedAsyncioTestCase):
    """2026-08-26: 테스트 프로젝트 스코프에 실수로 들어간 계정관리 테이블의
    new_txt_password 값이 채팅 답변에 평문으로 그대로 노출된 실측 사고 이후 추가한
    계약 — 프로젝트 테이블 스코프 큐레이션이 실수해도 이 서버 쪽 가드가 한 번 더
    막는다는 걸 회귀로 잡아둔다."""

    async def test_password_like_fields_are_redacted_from_query_results(self) -> None:
        payload = json.dumps({
            "value": [
                {"new_txt_id": "adcrm1@qualisoft.co.kr", "new_txt_password": "roqkf@0309", "new_name": "퀄리"},
            ]
        })
        with (
            patch.object(chat_api, "_guard_odata_path", return_value="new_account_maintances"),
            patch.object(chat_api, "dataverse_get", AsyncMock(return_value=payload)),
        ):
            result = await chat_api._dataverse_query("new_account_maintances", ["new_account_maintance"])

        self.assertNotIn("roqkf@0309", result)
        self.assertIn("비공개 처리됨", result)
        self.assertIn("퀄리", result)   # 민감하지 않은 다른 필드는 그대로 남아야 한다

    async def test_nested_sensitive_fields_are_also_redacted(self) -> None:
        payload = json.dumps({"value": [{"outer": {"api_key": "sk-live-abc123"}, "safe": "ok"}]})
        with (
            patch.object(chat_api, "_guard_odata_path", return_value="whatever"),
            patch.object(chat_api, "dataverse_get", AsyncMock(return_value=payload)),
        ):
            result = await chat_api._dataverse_query("whatever", [])

        self.assertNotIn("sk-live-abc123", result)
        self.assertIn("ok", result)


if __name__ == "__main__":
    unittest.main()
