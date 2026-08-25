"""FastAPI 공통 구조화 로그.

``LLM_PROVIDER``에서 프로필을 파생해 Anthropic은
``logs/server.cloud.log``, Ollama는 ``logs/server.local.log`` 하나를
활성 로그로 사용한다. JSON Lines 필드와 콘솔 표시는
두 프로필에서 동일하다.
"""
from __future__ import annotations

import gzip
import json
import logging
import os
import sys
from datetime import datetime, time as datetime_time, timedelta, timezone
from logging.handlers import BaseRotatingHandler
from pathlib import Path
from typing import Any

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


SUPPORTED_LLM_PROVIDERS = ("anthropic", "ollama")


def resolve_llm_provider(raw_value: str | None = None) -> str:
    value = (raw_value if raw_value is not None else os.environ.get("LLM_PROVIDER", "anthropic")).strip().lower()
    if value not in SUPPORTED_LLM_PROVIDERS:
        allowed = ", ".join(SUPPORTED_LLM_PROVIDERS)
        raise RuntimeError(f'LLM_PROVIDER="{value}"는 지원하지 않습니다. 허용 값: {allowed}')
    return value


LLM_PROVIDER = resolve_llm_provider()
SERVER_PROFILE = "cloud" if LLM_PROVIDER == "anthropic" else "local"
LOGS_DIR = Path.cwd() / "logs"
LOG_FILE_NAME = f"server.{SERVER_PROFILE}.log"
LOG_FILE_PATH = LOGS_DIR / LOG_FILE_NAME
MAX_FILES = max(1, int(os.environ.get("LOG_MAX_FILES", "30")))
MAX_BYTES = max(1, int(os.environ.get("LOG_MAX_BYTES", str(50 * 1024 * 1024))))

LOGS_DIR.mkdir(parents=True, exist_ok=True)


def get_active_log_file_path() -> Path:
    return LOG_FILE_PATH


def _next_local_midnight_epoch(now: datetime | None = None) -> float:
    current = now or datetime.now().astimezone()
    tomorrow = current.date() + timedelta(days=1)
    return datetime.combine(tomorrow, datetime_time.min, tzinfo=current.tzinfo).timestamp()


class _TimedSizedRotatingFileHandler(BaseRotatingHandler):
    """일별 경계와 크기 상한을 함께 적용하는 gzip 회전 핸들러.

    ``TimedRotatingFileHandler``의 기본 날짜 이름은 같은 날 여러 번 크기 회전 시
    같아져 기존 압축본을 덮을 수 있다. 이 구현은 초 단위 시각과 증가 번호를 함께
    사용하고, 실제 archive 목록을 정리해 정확히 ``backup_count``개만 보존한다.
    """

    def __init__(self, filename: Path, *, max_bytes: int, backup_count: int) -> None:
        self.max_bytes = max_bytes
        self.backup_count = backup_count
        self.rollover_at = _next_local_midnight_epoch()
        super().__init__(filename, mode="a", encoding="utf-8", delay=False)

    def shouldRollover(self, record: logging.LogRecord) -> int:  # noqa: N802 - logging API
        if datetime.now().astimezone().timestamp() >= self.rollover_at:
            return 1
        if self.stream is None:
            self.stream = self._open()
        message = f"{self.format(record)}\n".encode("utf-8")
        self.stream.seek(0, os.SEEK_END)
        return 1 if self.stream.tell() + len(message) >= self.max_bytes else 0

    def _next_archive_path(self) -> Path:
        active = Path(self.baseFilename)
        stamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
        prefix = f"{active.name}.{stamp}"
        candidate = active.with_name(f"{prefix}.gz")
        sequence = 1
        while candidate.exists():
            candidate = active.with_name(f"{prefix}.{sequence:03d}.gz")
            sequence += 1
        return candidate

    def _purge_old_archives(self) -> None:
        active = Path(self.baseFilename)
        archives = sorted(
            active.parent.glob(f"{active.name}.*.gz"),
            key=lambda path: (path.stat().st_mtime_ns, path.name),
        )
        for expired in archives[: max(0, len(archives) - self.backup_count)]:
            try:
                expired.unlink()
            except FileNotFoundError:
                pass

    def doRollover(self) -> None:  # noqa: N802 - logging API
        if self.stream is not None:
            self.stream.close()
            self.stream = None

        active = Path(self.baseFilename)
        if active.exists() and active.stat().st_size:
            archive = self._next_archive_path()
            # archive는 새 이름으로만 열리므로 기존 로그를 덮어쓰지 않는다.
            with active.open("rb") as source, gzip.open(archive, "xb") as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
            active.unlink()

        self.rollover_at = _next_local_midnight_epoch()
        self._purge_old_archives()
        if not self.delay:
            self.stream = self._open()


_file_handler = _TimedSizedRotatingFileHandler(
    LOG_FILE_PATH,
    max_bytes=MAX_BYTES,
    backup_count=MAX_FILES,
)
_file_handler.setFormatter(logging.Formatter("%(message)s"))

_file_logger = logging.getLogger(f"crm.fastapi.{SERVER_PROFILE}")
_file_logger.setLevel(logging.INFO)
_file_logger.propagate = False
if not _file_logger.handlers:
    _file_logger.addHandler(_file_handler)

_RESET = "\x1b[0m"
_COLORS = {"info": "\x1b[36m", "error": "\x1b[31m"}


def _local_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def _write(level: str, category: str, message: str, data: Any = None) -> None:
    entry: dict[str, Any] = {
        "time": _local_iso(),
        "level": level,
        "category": category,
        "message": message,
    }
    if data is not None:
        entry["data"] = data
    _file_logger.info(json.dumps(entry, ensure_ascii=False))

    color = _COLORS.get(level, "")
    data_text = f" {json.dumps(data, ensure_ascii=False)}" if data is not None else ""
    print(f"{color}[{level.upper()}]{_RESET} [{category}] {message}{data_text}")


class _Log:
    @staticmethod
    def info(category: str, message: str, data: Any = None) -> None:
        _write("info", category, message, data)

    @staticmethod
    def error(category: str, message: str, data: Any = None) -> None:
        _write("error", category, message, data)


log = _Log()


def read_json_log_tail(limit: int, *, path: Path | None = None) -> list[dict[str, Any]]:
    """JSONL 파일의 끝부분만 역방향으로 읽어 최근 항목을 시간순으로 반환한다."""
    if limit <= 0:
        return []
    target = path or get_active_log_file_path()
    try:
        with target.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            position = stream.tell()
            chunks: list[bytes] = []
            newline_count = 0
            while position > 0 and newline_count <= limit:
                size = min(64 * 1024, position)
                position -= size
                stream.seek(position)
                chunk = stream.read(size)
                chunks.append(chunk)
                newline_count += chunk.count(b"\n")
        raw_lines = b"".join(reversed(chunks)).splitlines()[-limit:]
    except OSError:
        return []

    entries: list[dict[str, Any]] = []
    for raw_line in raw_lines:
        try:
            value = json.loads(raw_line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            entries.append(value)
    return entries
