"""LocalFileStore(DocumentStore 기본 구현)의 계약 테스트.

나중에 다른 백엔드(온프레미스 DB, Azure Table Storage 등)를 추가할 때 이 파일과
같은 계약(get/put/delete/list_keys, expected_rev 낙관적 동시성)을 그 구현체에도
그대로 적용해 회귀를 잡을 수 있다.
"""
from __future__ import annotations

import shutil
import unittest
import uuid
from pathlib import Path

from backend.stores.base import VersionConflict
from backend.stores.local_file_store import LocalFileStore


class LocalFileStoreContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.store = LocalFileStore(root=self.root)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_get_missing_returns_none(self) -> None:
        self.assertIsNone(self.store.get("widgets", "nope"))

    def test_put_then_get_round_trips_and_assigns_rev(self) -> None:
        written = self.store.put("widgets", "a", {"name": "gear"})
        self.assertEqual(written["_rev"], 1)
        self.assertEqual(self.store.get("widgets", "a"), written)

    def test_put_without_expected_rev_always_overwrites(self) -> None:
        self.store.put("widgets", "a", {"name": "gear"})
        second = self.store.put("widgets", "a", {"name": "cog"})
        self.assertEqual(second["name"], "cog")
        self.assertEqual(second["_rev"], 2)

    def test_put_with_matching_expected_rev_succeeds(self) -> None:
        first = self.store.put("widgets", "a", {"name": "gear"})
        second = self.store.put("widgets", "a", {"name": "cog"}, expected_rev=first["_rev"])
        self.assertEqual(second["_rev"], 2)

    def test_put_with_stale_expected_rev_raises_version_conflict(self) -> None:
        self.store.put("widgets", "a", {"name": "gear"})
        self.store.put("widgets", "a", {"name": "cog"})   # _rev는 이제 2
        with self.assertRaises(VersionConflict):
            self.store.put("widgets", "a", {"name": "sprocket"}, expected_rev=1)

    def test_put_with_expected_rev_on_missing_document_raises_version_conflict(self) -> None:
        with self.assertRaises(VersionConflict):
            self.store.put("widgets", "new", {"name": "gear"}, expected_rev=1)

    def test_list_keys_returns_all_written_keys(self) -> None:
        self.store.put("widgets", "a", {"name": "gear"})
        self.store.put("widgets", "b", {"name": "cog"})
        self.assertEqual(set(self.store.list_keys("widgets")), {"a", "b"})

    def test_list_keys_on_empty_collection_returns_empty_list(self) -> None:
        self.assertEqual(self.store.list_keys("nothing-here"), [])

    def test_delete_removes_document(self) -> None:
        self.store.put("widgets", "a", {"name": "gear"})
        self.assertTrue(self.store.delete("widgets", "a"))
        self.assertIsNone(self.store.get("widgets", "a"))

    def test_delete_missing_returns_false(self) -> None:
        self.assertFalse(self.store.delete("widgets", "nope"))

    def test_nested_collection_path_is_supported(self) -> None:
        written = self.store.put("users/kim@example.com/projects", "p1", {"name": "test"})
        self.assertEqual(self.store.get("users/kim@example.com/projects", "p1"), written)

    def test_collection_path_traversal_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self.store.put("../escape", "a", {"name": "gear"})


if __name__ == "__main__":
    unittest.main()
