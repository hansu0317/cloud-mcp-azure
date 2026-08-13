"""Dataverse 조회 경로와 프로젝트 스코프의 fail-closed 계약 테스트."""

from __future__ import annotations

import json
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from backend import chat_api


class DataverseGuardContractTests(unittest.TestCase):
    def setUp(self) -> None:
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
                        "schema": "| 컬럼명 | 타입 | 설명 |\n|---|---|---|",
                    },
                    "contact": {
                        "label": "담당자",
                        "domain": "영업",
                        "entitySetName": "contacts",
                        "schema": "| 컬럼명 | 타입 | 설명 |\n|---|---|---|",
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self._schema_patch = patch.object(chat_api, "SCHEMA_FILE", self.schema_file)
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

        self.schema_file.write_text("{}", encoding="utf-8")
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


if __name__ == "__main__":
    unittest.main()
