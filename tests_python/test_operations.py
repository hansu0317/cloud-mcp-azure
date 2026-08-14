"""운영 안전성 계약: body 제한, 로그 회전/꼬리 읽기, 스키마 원자 저장."""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import main
from backend.instructions_draft import _draft_examples, _draft_joins
from backend.logger import _TimedSizedRotatingFileHandler, read_json_log_tail


class OperationContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.temp_root.mkdir(parents=True)
        self.client = TestClient(main.app, raise_server_exceptions=False)
        self.headers = {"x-api-key": main.API_KEY} if main.API_KEY else {}

    def tearDown(self) -> None:
        self.client.close()
        shutil.rmtree(self.temp_root, ignore_errors=True)

    def request(self, method: str, path: str, **kwargs):
        headers = dict(self.headers)
        headers.update(kwargs.pop("headers", {}))
        return self.client.request(method, path, headers=headers, **kwargs)

    def test_json_body_guard_rejects_large_malformed_and_wrong_media_type(self) -> None:
        oversized = b'"' + (b"x" * (main.MAX_REQUEST_BODY_BYTES + 1)) + b'"'
        self.assertEqual(
            self.request(
                "POST", "/api/projects", content=oversized,
                headers={"content-type": "application/json"},
            ).status_code,
            413,
        )
        self.assertEqual(
            self.request(
                "POST", "/api/projects", content=b"{",
                headers={"content-type": "application/json"},
            ).status_code,
            400,
        )
        self.assertEqual(
            self.request(
                "POST", "/api/projects", content=b"{}",
                headers={"content-type": "text/plain"},
            ).status_code,
            415,
        )

    def test_unknown_api_and_api_docs_are_not_spa_fallback(self) -> None:
        response = self.request("GET", "/api/not-a-route")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers["content-type"].split(";", 1)[0], "application/json")
        if not main.ENABLE_API_DOCS:
            self.assertEqual(self.request("GET", "/docs").status_code, 404)
            self.assertEqual(self.request("GET", "/openapi.json").status_code, 404)

    def test_same_day_size_rollovers_are_unique_and_bounded(self) -> None:
        path = self.temp_root / "server.cloud.log"
        handler = _TimedSizedRotatingFileHandler(path, max_bytes=80, backup_count=2)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = logging.getLogger(f"rotation-test-{id(handler)}")
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(logging.INFO)
        for index in range(12):
            logger.info("%02d-%s", index, "x" * 60)
        handler.close()

        archives = sorted(path.parent.glob("server.cloud.log.*.gz"))
        self.assertEqual(len(archives), 2)
        self.assertEqual(len({archive.name for archive in archives}), 2)

    def test_log_tail_does_not_require_read_text(self) -> None:
        path = self.temp_root / "server.log"
        path.write_text(
            "\n".join(json.dumps({"index": index}) for index in range(1000)) + "\n",
            encoding="utf-8",
        )
        with patch.object(Path, "read_text", side_effect=AssertionError("whole-file read")):
            entries = read_json_log_tail(3, path=path)
        self.assertEqual([entry["index"] for entry in entries], [997, 998, 999])

    def test_draft_examples_exclude_failed_and_describe_only(self) -> None:
        entries = [
            {"category": "API-질문", "message": "A", "data": {"requestId": "a"}},
            {"category": "API-쿼리", "message": "[dataverse_describe_table]", "data": {"requestId": "a", "tool": "dataverse_describe_table", "error": False}},
            {"category": "API-답변", "message": "답 A", "data": {"requestId": "a", "successfulDataverseQueries": 0}},
            {"category": "API-질문", "message": "B", "data": {"requestId": "b"}},
            {"category": "API-쿼리", "message": "[dataverse_query]", "data": {"requestId": "b", "tool": "dataverse_query", "error": True}},
            {"category": "API-답변", "message": "답 B", "data": {"requestId": "b", "successfulDataverseQueries": 0}},
            {"category": "API-질문", "message": "C", "data": {"requestId": "c"}},
            {"category": "API-쿼리", "message": "[dataverse_query]", "data": {"requestId": "c", "tool": "dataverse_query", "error": False}},
            {"category": "API-답변", "message": "답 C", "data": {"requestId": "c", "successfulDataverseQueries": 1}},
        ]
        self.assertEqual(_draft_examples(entries), [{"question": "C", "answer": "답 C"}])

    def test_draft_joins_only_include_cataloged_targets(self) -> None:
        schema_data = {
            "opportunity": {"lookups": {"customerid": ["account", "contact"], "ownerid": ["systemuser"]}},
            "account": {},
            # "contact"와 "systemuser"는 카탈로그에 없음 — 후보에서 빠져야 한다.
        }
        self.assertEqual(
            _draft_joins(schema_data),
            [{"fromTable": "opportunity", "fromCol": "customerid", "toTable": "account", "toCol": "accountid", "label": ""}],
        )

    def test_draft_joins_exclude_self_reference_and_dedupe(self) -> None:
        schema_data = {
            "account": {"lookups": {"parentaccountid": ["account"]}},  # 자기 자신 참조는 제외
            "opportunity": {"lookups": {"customerid": ["account"], "parentcontactid": ["account"]}},
        }
        joins = _draft_joins(schema_data)
        self.assertEqual(
            sorted(joins, key=lambda j: j["fromCol"]),
            [
                {"fromTable": "opportunity", "fromCol": "customerid", "toTable": "account", "toCol": "accountid", "label": ""},
                {"fromTable": "opportunity", "fromCol": "parentcontactid", "toTable": "account", "toCol": "accountid", "label": ""},
            ],
        )

    def test_draft_joins_respects_max_n_and_ignores_malformed_entries(self) -> None:
        schema_data = {
            "t0": {"lookups": {"fk": ["target"]}},
            "target": {},
            "bad1": "not-a-dict",
            "bad2": {"lookups": "not-a-dict"},
            "bad3": {"lookups": {"fk": "not-a-list"}},
        }
        self.assertEqual(_draft_joins(schema_data, max_n=1), _draft_joins(schema_data))
        self.assertEqual(len(_draft_joins(schema_data, max_n=1)), 1)

    def test_get_instructions_draft_endpoint_reads_cached_schema_lookups(self) -> None:
        schema_data = {
            "opportunity": {"lookups": {"customerid": ["account"]}},
            "account": {},
        }
        with (
            patch.object(main, "_read_json_file", return_value=schema_data),
            patch("backend.instructions_draft._read_log_entries", return_value=[]),
        ):
            response = self.request("GET", "/api/instructions/draft")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["joins"],
            [{"fromTable": "opportunity", "fromCol": "customerid", "toTable": "account", "toCol": "accountid", "label": ""}],
        )

    def test_describe_write_failure_does_not_mutate_memory_cache(self) -> None:
        previous = main.schema_cache.get("account")
        result = SimpleNamespace(markdown="new schema", entity_set_name="accounts", lookups={})
        with (
            patch.object(main, "dataverse_env_missing", return_value=None),
            patch.object(main, "fetch_entity_schema", AsyncMock(return_value=result)),
            patch.object(main, "_read_json_file", return_value={"account": {}}),
            patch.object(main, "_atomic_write_json", side_effect=OSError("disk full")),
        ):
            with self.assertRaises(OSError):
                asyncio.run(main.describe_table("account"))
        self.assertEqual(main.schema_cache.get("account"), previous)


if __name__ == "__main__":
    unittest.main()
