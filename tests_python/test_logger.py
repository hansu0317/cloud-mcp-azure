"""로그 회전 핸들러 계약 테스트 — 특히 재시작 사이 자정 경계를 넘기지 못해
날짜 기준 회전이 영원히 안 걸리던 문제(2026-08-31 실측)의 회귀 방지."""

from __future__ import annotations

import gzip
import os
import shutil
import unittest
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from backend.core.logger import _TimedSizedRotatingFileHandler


class LogRolloverContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path.cwd() / "data" / ".python-tests" / str(uuid.uuid4())
        self.root.mkdir(parents=True)
        self.log_path = self.root / "server.cloud.log"

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_stale_previous_day_file_is_rolled_over_on_startup(self) -> None:
        self.log_path.write_text('{"time": "yesterday"}\n', encoding="utf-8")
        yesterday = (datetime.now() - timedelta(days=1)).timestamp()
        os.utime(self.log_path, (yesterday, yesterday))

        handler = _TimedSizedRotatingFileHandler(self.log_path, max_bytes=1024, backup_count=30)
        try:
            self.assertEqual(self.log_path.read_text(encoding="utf-8"), "")

            archives = list(self.root.glob("server.cloud.log.*.gz"))
            self.assertEqual(len(archives), 1)
            with gzip.open(archives[0], "rt", encoding="utf-8") as f:
                self.assertIn("yesterday", f.read())
        finally:
            handler.close()

    def test_fresh_today_file_is_left_alone_on_startup(self) -> None:
        self.log_path.write_text('{"time": "today"}\n', encoding="utf-8")
        # os.utime 없이 그대로 둔다 — 방금 쓴 파일이라 mtime이 이미 오늘.

        handler = _TimedSizedRotatingFileHandler(self.log_path, max_bytes=1024, backup_count=30)
        try:
            self.assertIn("today", self.log_path.read_text(encoding="utf-8"))
            self.assertEqual(list(self.root.glob("server.cloud.log.*.gz")), [])
        finally:
            handler.close()

    def test_missing_file_does_not_error_on_startup(self) -> None:
        handler = _TimedSizedRotatingFileHandler(self.log_path, max_bytes=1024, backup_count=30)
        try:
            self.assertTrue(self.log_path.exists())
            self.assertEqual(list(self.root.glob("server.cloud.log.*.gz")), [])
        finally:
            handler.close()


if __name__ == "__main__":
    unittest.main()
