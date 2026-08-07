"""구조화 로그 — logs/app.log에 JSON 라인 기록 + 컬러 콘솔 출력.

server/logger.ts 포팅. 필드(time/level/category/message/data)와 로테이션 정책
(1일 주기, LOG_MAX_FILES개 보관, gzip 압축)을 그대로 유지한다.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import shutil
import sys
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from typing import Any

# Windows 콘솔 기본 코드페이지(CP949 등)는 '—' 같은 한글 로그의 문자를 인코딩하지
# 못해 print()가 그대로 죽는다. 콘솔의 chcp 설정과 무관하게 항상 UTF-8로 출력되도록
# 강제한다(scripts/server.ps1의 chcp 65001과 별개로, 어떤 실행 경로에서도 안전하게).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass  # 콘솔이 없는 호스트(예: 일부 서비스 매니저) 등에서는 무시

LOGS_DIR = Path.cwd() / "logs"
MAX_FILES = int(os.environ.get("LOG_MAX_FILES", "30"))

LOGS_DIR.mkdir(parents=True, exist_ok=True)


def _rotator(source: str, dest: str) -> None:
    """회전된 로그 파일을 gzip으로 압축한다 (rotating-file-stream의 compress:'gzip' 대응)."""
    with open(source, "rb") as f_in, gzip.open(dest, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(source)


def _namer(name: str) -> str:
    return name + ".gz"


_file_handler = TimedRotatingFileHandler(
    LOGS_DIR / "app.log", when="midnight", interval=1, backupCount=MAX_FILES, encoding="utf-8",
)
_file_handler.rotator = _rotator
_file_handler.namer = _namer
_file_handler.setFormatter(logging.Formatter("%(message)s"))

_file_logger = logging.getLogger("crm.app.file")
_file_logger.setLevel(logging.INFO)
_file_logger.propagate = False
_file_logger.addHandler(_file_handler)

_RESET = "\x1b[0m"
_COLORS = {"info": "\x1b[36m", "error": "\x1b[31m"}


def _local_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _write(level: str, category: str, message: str, data: Any = None) -> None:
    entry: dict[str, Any] = {"time": _local_iso(), "level": level, "category": category, "message": message}
    if data is not None:
        entry["data"] = data
    _file_logger.info(json.dumps(entry, ensure_ascii=False))

    color = _COLORS.get(level, "")
    data_str = f" {json.dumps(data, ensure_ascii=False)}" if data is not None else ""
    print(f"{color}[{level.upper()}]{_RESET} [{category}] {message}{data_str}")


class _Log:
    @staticmethod
    def info(category: str, message: str, data: Any = None) -> None:
        _write("info", category, message, data)

    @staticmethod
    def error(category: str, message: str, data: Any = None) -> None:
        _write("error", category, message, data)


log = _Log()
