"""프로젝트 파일 저장소의 보안·API 노출 계약 테스트 (v1: 전부 개인 프로젝트).

외부 서비스와 실제 프로젝트 파일은 사용하지 않는다. Git에서 제외된
``data/.python-tests/<uuid>``에 격리하고 종료 시 정리한다. 표준 라이브러리
``unittest``만 사용하므로 별도 테스트 러너 의존성도 필요 없다.
"""

from __future__ import annotations

import shutil
import json
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from backend.store import projects
from backend.stores import local_file_store
from backend.stores.local_file_store import LocalFileStore

EMAIL = "test@example.com"


class ProjectStoreContractTests(unittest.TestCase):
    def setUp(self) -> None:
        # Windows의 제한된 실행 환경에서도 tempfile의 ACL 영향을 받지 않도록
        # 프로젝트의 git-ignore된 data/ 아래에 테스트 전용 UUID 디렉터리를 쓴다.
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.users_root = self.root / "data" / "users"
        self.projects_dir = self.users_root / EMAIL / "projects"
        self._store = LocalFileStore(root=self.root / "data")

        self._patches = [
            patch.object(projects, "get_store", lambda: self._store),
            patch.object(projects.log, "info"),
            patch.object(projects.log, "error"),
        ]
        for item in self._patches:
            item.start()

    def tearDown(self) -> None:
        for item in reversed(self._patches):
            item.stop()
        shutil.rmtree(self.root, ignore_errors=True)

    def test_project_lifecycle_keeps_history_private(self) -> None:
        created = projects.create_project(EMAIL, "  영업 현황  ", ["account"])
        project_id = created["id"]

        self.assertEqual(created["name"], "영업 현황")
        self.assertEqual(created["tables"], ["account"])
        self.assertEqual(created["ownerEmail"], EMAIL)
        self.assertNotIn("history", created)
        self.assertTrue(projects.project_exists(EMAIL, project_id))

        instructions = {
            "joins": [{"from": "account", "to": "contact"}],
            "terms": [{"term": "고객", "table": "account"}],
            "examples": [{"question": "고객 수", "answer": "집계합니다."}],
        }
        updated = projects.update_project(
            EMAIL, project_id,
            instructions=instructions,
            cells=[{"id": "cell-1", "question": "고객 수"}],
        )
        self.assertIsNotNone(updated)
        self.assertNotIn("history", updated or {})
        self.assertEqual(projects.get_project_instructions(EMAIL, project_id), instructions)

        history = [{"role": "user", "content": [{"type": "text", "text": "질문"}]}]
        self.assertTrue(projects.save_project_history(EMAIL, project_id, history))
        self.assertEqual(projects.get_project_history(EMAIL, project_id), history)

        detail = projects.get_project(EMAIL, project_id)
        self.assertIsNotNone(detail)
        self.assertNotIn("history", detail or {})
        self.assertNotIn("history", projects.list_projects(EMAIL)[0])

        self.assertTrue(projects.delete_project(EMAIL, project_id))
        self.assertFalse(projects.project_exists(EMAIL, project_id))
        self.assertFalse(projects.delete_project(EMAIL, project_id))

    def test_other_users_cannot_see_or_touch_each_others_projects(self) -> None:
        other = "other@example.com"
        created = projects.create_project(EMAIL, "내 프로젝트", ["account"])
        project_id = created["id"]

        self.assertIsNone(projects.get_project(other, project_id))
        self.assertFalse(projects.project_exists(other, project_id))
        self.assertEqual(projects.list_projects(other), [])
        self.assertFalse(projects.delete_project(other, project_id))
        self.assertIsNone(projects.update_project(other, project_id, name="가로채기"))
        # 남의 계정으로는 원본이 그대로 살아있어야 한다.
        self.assertEqual(projects.get_project(EMAIL, project_id)["name"], "내 프로젝트")

    def test_history_save_never_creates_an_unknown_project(self) -> None:
        unknown_id = "11111111-1111-1111-1111-111111111111"

        self.assertFalse(projects.project_exists(EMAIL, unknown_id))
        self.assertFalse(projects.save_project_history(EMAIL, unknown_id, [{"role": "user"}]))
        self.assertFalse((self.projects_dir / f"{unknown_id}.json").exists())
        self.assertEqual(projects.list_projects(EMAIL), [])

    def test_invalid_ids_cannot_escape_the_projects_directory(self) -> None:
        outside = self.root / "escape.json"
        invalid_ids = (
            "../escape",
            "..\\escape",
            "folder/project",
            "folder\\project",
            "",
            ".",
            "한글-id",
        )

        for project_id in invalid_ids:
            with self.subTest(project_id=project_id):
                self.assertFalse(projects.project_exists(EMAIL, project_id))
                self.assertIsNone(projects.get_project(EMAIL, project_id))
                self.assertFalse(projects.save_project_history(EMAIL, project_id, []))
                self.assertFalse(projects.delete_project(EMAIL, project_id))

        self.assertFalse(outside.exists())
        self.assertEqual(list(self.projects_dir.glob("*.json")) if self.projects_dir.exists() else [], [])

    def test_malformed_project_files_are_skipped_without_breaking_list(self) -> None:
        valid = projects.create_project(EMAIL, "정상 프로젝트", ["account"])
        malformed = {
            "bad-root": [],
            "missing-required": {"id": "missing-required", "name": "누락"},
            "wrong-id": {
                "id": "different-id",
                "name": "불일치",
                "tables": [],
                "createdAt": "2026-08-13T00:00:00+09:00",
                "updatedAt": "2026-08-13T00:00:00+09:00",
            },
            "bad-tables": {
                "id": "bad-tables",
                "name": "잘못된 테이블",
                "tables": [123],
                "createdAt": "2026-08-13T00:00:00+09:00",
                "updatedAt": "2026-08-13T00:00:00+09:00",
            },
        }
        for project_id, payload in malformed.items():
            (self.projects_dir / f"{project_id}.json").write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
        (self.projects_dir / "invalid-json.json").write_text("{", encoding="utf-8")

        listed = projects.list_projects(EMAIL)

        self.assertEqual([item["id"] for item in listed], [valid["id"]])
        for project_id in malformed:
            self.assertIsNone(projects.get_project(EMAIL, project_id))
        self.assertIsNone(projects.get_project(EMAIL, "invalid-json"))

    def test_writes_are_atomic_and_leave_original_on_replace_failure(self) -> None:
        created = projects.create_project(EMAIL, "원본", ["account"])
        target = self.projects_dir / f"{created['id']}.json"
        original = target.read_bytes()

        with patch.object(local_file_store.os, "replace", side_effect=OSError("replace failed")):
            with self.assertRaises(OSError):
                projects.update_project(EMAIL, created["id"], name="변경본")

        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(list(self.projects_dir.glob("*.tmp")), [])
        self.assertEqual(projects.get_project(EMAIL, created["id"])["name"], "원본")

    def test_stale_expected_rev_is_rejected_as_version_conflict(self) -> None:
        """두 탭이 같은 프로젝트를 동시에 고치는 상황의 핵심 계약: 먼저 읽은 _rev로
        나중에 저장하려 하면(그 사이 다른 곳에서 이미 한 번 저장했으므로) 조용히
        덮어쓰지 않고 ProjectVersionConflict를 던져야 한다."""
        created = projects.create_project(EMAIL, "원본", ["account"])
        project_id = created["id"]
        stale_rev = created["_rev"]

        # 다른 탭이 먼저 저장 — _rev가 하나 올라간다.
        projects.update_project(EMAIL, project_id, name="다른 탭이 바꿈")

        with self.assertRaises(projects.ProjectVersionConflict):
            projects.update_project(EMAIL, project_id, name="내 탭이 덮어쓰려 함", expected_rev=stale_rev)
        # 거절됐으니 다른 탭의 변경이 그대로 남아있어야 한다.
        self.assertEqual(projects.get_project(EMAIL, project_id)["name"], "다른 탭이 바꿈")

        # 최신 _rev로 다시 시도하면 성공한다(충돌 후 새로고침 → 재시도 흐름).
        latest_rev = projects.get_project(EMAIL, project_id)["_rev"]
        updated = projects.update_project(EMAIL, project_id, name="재시도 성공", expected_rev=latest_rev)
        assert updated is not None
        self.assertEqual(updated["name"], "재시도 성공")
        self.assertGreater(updated["_rev"], latest_rev)

    def test_expected_rev_none_always_overwrites_like_before(self) -> None:
        """expected_rev를 안 주면(지금 대부분의 호출부) 예전처럼 무조건 덮어쓴다 —
        기존 동작을 깨지 않는다는 걸 명시적으로 잡아둔다."""
        created = projects.create_project(EMAIL, "원본", ["account"])
        project_id = created["id"]
        projects.update_project(EMAIL, project_id, name="변경 1")
        updated = projects.update_project(EMAIL, project_id, name="변경 2", expected_rev=None)
        assert updated is not None
        self.assertEqual(updated["name"], "변경 2")

    def test_inputs_and_return_values_are_deep_copied(self) -> None:
        tables = ["account"]
        created = projects.create_project(EMAIL, "복사 안전성", tables)
        project_id = created["id"]
        tables.append("contact")
        created["tables"].append("lead")
        self.assertEqual(projects.get_project_tables(EMAIL, project_id), ["account"])

        instructions = {
            "joins": [{"from": "account", "to": "contact"}],
            "terms": [],
            "examples": [],
        }
        updated = projects.update_project(EMAIL, project_id, instructions=instructions)
        instructions["joins"][0]["from"] = "mutated-input"
        assert updated is not None
        updated["instructions"]["joins"][0]["from"] = "mutated-output"
        self.assertEqual(projects.get_project_instructions(EMAIL, project_id)["joins"][0]["from"], "account")

        history = [{"role": "user", "content": [{"type": "text", "text": "원본"}]}]
        self.assertTrue(projects.save_project_history(EMAIL, project_id, history))
        history[0]["content"][0]["text"] = "변경"
        returned = projects.get_project_history(EMAIL, project_id)
        returned[0]["content"][0]["text"] = "반환값 변경"
        self.assertEqual(projects.get_project_history(EMAIL, project_id)[0]["content"][0]["text"], "원본")


if __name__ == "__main__":
    unittest.main()
