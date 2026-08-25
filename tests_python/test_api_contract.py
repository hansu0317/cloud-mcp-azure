"""FastAPI의 프로젝트·채팅 입구 계약 테스트(LLM/Dataverse 네트워크 미사용)."""

from __future__ import annotations

import json
import shutil
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from backend import main
from backend.auth import LOCAL_DEV_EMAIL
from backend.store import projects
from backend.core.logger import read_json_log_tail


class FastApiContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.root.mkdir(parents=True)
        self.users_root = self.root / "data" / "users"
        # auth_is_configured를 False로 패치해두면(아래) viewer_email()이 항상
        # LOCAL_DEV_EMAIL을 돌려준다 — 이 파일의 모든 /api/projects 요청은 그
        # 고정 계정의 개인 폴더를 쓴다.
        self.projects_dir = self.users_root / LOCAL_DEV_EMAIL / "projects"

        self._patches = [
            patch.object(projects, "USERS_ROOT", self.users_root),
            patch.object(projects.log, "info"),
            patch.object(projects.log, "error"),
            # 이 파일은 API 계약(요청 검증·응답 형태)을 다루지 로그인을 다루지 않는다 —
            # 로컬 .env에 LOGIN_*이 채워져 있으면 LoginSessionMiddleware가 세션 없는
            # /api/* 요청을 다른 검증보다 먼저 401로 끊어서 이 테스트들이 보려는
            # 코드에 아예 도달을 못 한다(test_operations.py와 같은 이유). main이
            # import 시점에 복사해온 이름(auth_is_configured)과 auth 모듈 자신의
            # is_configured(viewer_email이 내부에서 그대로 부름) 둘 다 별개
            # 바인딩이라 각자 패치해야 한다.
            patch("backend.main.auth_is_configured", return_value=False),
            patch("backend.auth.is_configured", return_value=False),
        ]
        for item in self._patches:
            item.start()

        self._old_schema_meta = dict(main.schema_meta)
        self._old_schema_cache = dict(main.schema_cache)
        self._old_schema_lookups = dict(main.schema_lookups)
        main.schema_meta.clear()
        main.schema_meta.update({"account": {"label": "고객", "domain": "영업"}})
        main.schema_cache.clear()
        main.schema_cache.update({"account": "| 컬럼명 | 타입 | 설명 |"})
        main.schema_lookups.clear()
        main.schema_lookups.update({"contact": {"new_l_account": ["account"], "ownerid": ["systemuser"]}})

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
        main.schema_lookups.clear()
        main.schema_lookups.update(self._old_schema_lookups)
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
                LOCAL_DEV_EMAIL, project_id,
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

    def test_join_candidates_only_offers_fks_inside_project_table_scope(self) -> None:
        # main.schema_meta는 setUp에서 "account" 하나만 등록해두므로, 이 테스트에서만
        # "contact"를 더해 project.tables 유효성 검사(_validate_project_tables)를
        # 통과시킨다 — tearDown이 매 테스트 후 schema_meta를 통째로 복원하므로 다른
        # 테스트(schemaTables 개수 등)에 영향이 없다.
        # main.schema_lookups: contact.new_l_account → account (스코프 안),
        # contact.ownerid → systemuser (스코프 밖이자 시스템 엔터티라 제외 대상).
        main.schema_meta["contact"] = {"label": "연락처", "domain": "영업"}
        scoped = self.request(
            "POST", "/api/projects", json={"name": "범위 있음", "tables": ["account", "contact"]},
        ).json()
        response = self.request("GET", f"/api/projects/{scoped['id']}/join-candidates")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["joins"],
            [{"fromTable": "contact", "fromCol": "new_l_account", "toTable": "account", "toCol": "accountid", "label": ""}],
        )

        # 대상 테이블이 스코프 밖이면(contact 미포함) 후보가 없다.
        no_target = self.request(
            "POST", "/api/projects", json={"name": "대상 없음", "tables": ["account"]},
        ).json()
        self.assertEqual(
            self.request("GET", f"/api/projects/{no_target['id']}/join-candidates").json(), {"joins": []},
        )

        # 스코프 미지정(전체 허용) 프로젝트는 카탈로그 전체로 커질 수 있어 건너뛴다.
        unscoped = self.request("POST", "/api/projects", json={"name": "전체 허용"}).json()
        self.assertEqual(
            self.request("GET", f"/api/projects/{unscoped['id']}/join-candidates").json(), {"joins": []},
        )

        self.assertEqual(self.request("GET", "/api/projects/no-such-id/join-candidates").status_code, 404)

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

        created = projects.create_project(LOCAL_DEV_EMAIL, "서버 범위", ["account"])
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
