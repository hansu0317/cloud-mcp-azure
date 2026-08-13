"""FastAPI의 프로젝트·채팅 입구 계약 테스트(LLM/Dataverse 네트워크 미사용)."""

from __future__ import annotations

import json
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import main, projects
from backend.logger import read_json_log_tail


class FastApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.projects_dir = self.root / "data" / "projects"
        self.projects_dir.mkdir(parents=True)

        self._patches = [
            patch.object(projects, "PROJECTS_DIR", self.projects_dir),
            patch.object(
                projects,
                "_LEGACY_GLOBAL_INST_FILE",
                self.root / "data" / "instructions.json",
            ),
            patch.object(projects.log, "info"),
            patch.object(projects.log, "error"),
        ]
        for item in self._patches:
            item.start()

        self._old_schema_meta = dict(main.schema_meta)
        self._old_schema_cache = dict(main.schema_cache)
        main.schema_meta.clear()
        main.schema_meta.update({"account": {"label": "고객", "domain": "영업"}})
        main.schema_cache.clear()
        main.schema_cache.update({"account": "| 컬럼명 | 타입 | 설명 |"})

        # 예상치 못한 서버 예외도 HTTP 500 응답으로 관찰해 계약 실패로 명확히 표시한다.
        self.client = TestClient(main.app, raise_server_exceptions=False)
        self.auth_headers = (
            {"x-api-key": main.API_KEY} if getattr(main, "API_KEY", "") else {}
        )

    def tearDown(self) -> None:
        self.client.close()
        main.schema_meta.clear()
        main.schema_meta.update(self._old_schema_meta)
        main.schema_cache.clear()
        main.schema_cache.update(self._old_schema_cache)
        for item in reversed(self._patches):
            item.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def request(self, method: str, path: str, **kwargs):
        headers = dict(self.auth_headers)
        headers.update(kwargs.pop("headers", {}))
        return self.client.request(method, path, headers=headers, **kwargs)

    def test_project_crud_validates_shapes_and_never_exposes_history(self) -> None:
        invalid_creates = (
            {"name": 123},
            {"tables": "account"},
            {"tables": ["account", 123]},
            {"tables": ["not_registered"]},
        )
        for body in invalid_creates:
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/api/projects", json=body).status_code, 400)

        created_response = self.request(
            "POST",
            "/api/projects",
            json={"name": "고객 분석", "tables": ["account"]},
        )
        self.assertEqual(created_response.status_code, 200)
        created = created_response.json()
        project_id = created["id"]
        self.assertNotIn("history", created)

        self.assertTrue(
            projects.save_project_history(
                project_id,
                [{"role": "user", "content": [{"type": "text", "text": "내부 기록"}]}],
            )
        )
        detail = self.request("GET", f"/api/projects/{project_id}")
        listing = self.request("GET", "/api/projects")
        self.assertEqual(detail.status_code, 200)
        self.assertNotIn("history", detail.json())
        self.assertNotIn("history", listing.json()["projects"][0])

        invalid_patches = (
            {"name": []},
            {"tables": "account"},
            {"tables": ["not_registered"]},
            {"instructions": {"joins": [], "terms": []}},
            {"cells": {}},
        )
        for body in invalid_patches:
            with self.subTest(body=body):
                response = self.request("PATCH", f"/api/projects/{project_id}", json=body)
                self.assertEqual(response.status_code, 400)

        instructions = {"joins": [], "terms": [], "examples": []}
        updated = self.request(
            "PATCH",
            f"/api/projects/{project_id}",
            json={"instructions": instructions, "cells": []},
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["instructions"], instructions)

        deleted = self.request("DELETE", f"/api/projects/{project_id}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.request("GET", f"/api/projects/{project_id}").status_code, 404)

    def test_malformed_json_is_client_error_not_internal_error(self) -> None:
        response = self.request(
            "POST",
            "/api/projects",
            content=b"{",
            headers={"content-type": "application/json"},
        )
        self.assertEqual(response.status_code, 400)

    def test_chat_rejects_bad_or_unknown_project_before_provider_call(self) -> None:
        missing = self.request("POST", "/api/chat", json={})
        self.assertEqual(missing.status_code, 400)

        unknown = self.request(
            "POST",
            "/api/chat",
            json={
                "message": "고객을 보여줘",
                "sessionId": "11111111-1111-1111-1111-111111111111",
            },
        )
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(list(self.projects_dir.glob("*.json")), [])

        created = projects.create_project("서버 범위", ["account"])
        client_scope = self.request(
            "POST",
            "/api/chat",
            json={
                "message": "고객을 보여줘",
                "sessionId": created["id"],
                # 범위는 서버가 프로젝트 파일에서만 읽으므로 클라이언트 필드는 거절한다.
                "tables": ["not_registered"],
            },
        )
        self.assertEqual(client_scope.status_code, 400)

    def test_expected_api_surface_and_health_shape(self) -> None:
        expected = {
            ("GET", "/api/projects"),
            ("POST", "/api/projects"),
            ("GET", "/api/projects/{project_id}"),
            ("PATCH", "/api/projects/{project_id}"),
            ("DELETE", "/api/projects/{project_id}"),
            ("POST", "/api/chat"),
            ("GET", "/api/tables"),
            ("POST", "/api/schemas/refresh"),
            ("GET", "/api/describe"),
            ("GET", "/api/instructions/draft"),
            ("GET", "/api/logs"),
            ("GET", "/api/health"),
        }
        actual = {
            (method, route.path)
            for route in main.app.routes
            for method in (route.methods or set())
        }
        self.assertTrue(expected.issubset(actual), expected - actual)

        with (
            patch.object(
                main,
                "provider_status",
                return_value={
                    "provider": "anthropic",
                    "model": "test-model",
                    "endpoint": "https://provider.invalid",
                    "configured": True,
                },
            ),
            patch.object(main, "provider_health", AsyncMock(return_value={"status": "ok"})),
            patch.object(main, "dataverse_env_missing", return_value=None),
        ):
            response = self.request("GET", "/api/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["schemaTables"], 1)
        self.assertEqual(payload["chat"]["provider"], "anthropic")
        self.assertTrue(payload["chat"]["enabled"])

    def test_logs_endpoint_reads_only_the_active_profile_file(self) -> None:
        active_log = self.root / "server.cloud.log"
        active_log.write_text(
            "\n".join(
                json.dumps({"time": index, "message": f"entry-{index}"})
                for index in range(3)
            ),
            encoding="utf-8",
        )
        with patch.object(
            main,
            "read_json_log_tail",
            side_effect=lambda n, **_kwargs: read_json_log_tail(n, path=active_log),
        ):
            response = self.request("GET", "/api/logs?n=2")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            [entry["message"] for entry in response.json()],
            ["entry-2", "entry-1"],
        )


if __name__ == "__main__":
    unittest.main()
