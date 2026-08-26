"""DocumentStore의 기본(default) 구현 — 로컬 디스크 JSON 파일.

지금까지 ``backend/store/projects.py``와 ``backend/main.py``가 각자 따로 짜 놓았던
"임시파일에 쓰고 fsync한 뒤 원자적으로 교체" 로직을 여기 한 곳으로 모은다. collection은
디렉터리 경로(``/``로 중첩 가능, 예: ``"users/kim@example.com/projects"``), key는 그 안의
파일 하나(``<key>.json``)에 대응한다.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from .base import DocumentStore, VersionConflict

# collection 경로 한 세그먼트(디렉터리 이름) — 이메일처럼 특수문자가 있을 수 있는 값은
# 호출부(store/projects.py)가 미리 안전한 문자로 치환해서 넘긴다는 전제. 여기서는 방어적으로
# 경로 구분자·상위 이동(".."))만 확실히 막는다.
_SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.@-]+$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class LocalFileStore(DocumentStore):
    def __init__(self, root: Path) -> None:
        self._root = root.resolve()
        # 프로세스 내에서 같은 문서를 향한 read-check-write 경합을 막는다 — 이전
        # main.py의 _schema_write_lock이 schema.json 하나만 보호하던 걸 모든
        # collection/key로 일반화한 것. 여러 프로세스(다중 서버 인스턴스) 간 경합까지는
        # 막지 못하지만, 로컬 파일 백엔드는 원래 프로세스 하나짜리 배포를 전제로 한다.
        self._lock = threading.Lock()

    def _dir(self, collection: str) -> Path:
        parts = [p for p in collection.split("/") if p]
        # "."/".."은 문자 자체는 _SEGMENT_RE를 통과하지만(이메일에 점이 들어가므로 "."을
        # 허용해야 한다) 세그먼트 전체가 "."이나 ".."이면 상위 디렉터리 이동이 되므로
        # 별도로 막는다 — 아래 resolve() 검사보다 먼저 해야 한다. mkdir이 resolve 검사보다
        # 먼저 일어나면, 검사에 걸리기 전에 이미 루트 밖에 디렉터리를 만들어버리기 때문이다.
        if not parts or any(not _SEGMENT_RE.fullmatch(p) or p in (".", "..") for p in parts):
            raise ValueError(f'유효하지 않은 collection입니다: "{collection}"')
        path = self._root
        for part in parts:
            path = path / part
        resolved = path.resolve()
        if self._root != resolved and self._root not in resolved.parents:
            raise ValueError("collection 경로가 저장 루트를 벗어났습니다.")
        resolved.mkdir(parents=True, exist_ok=True)
        return resolved

    def _file(self, collection: str, key: str) -> Path:
        if not isinstance(key, str) or not _KEY_RE.fullmatch(key):
            raise ValueError(f'유효하지 않은 key입니다: "{key}"')
        directory = self._dir(collection)
        path = (directory / f"{key}.json").resolve()
        if path.parent != directory:
            raise ValueError("경로가 저장 디렉터리를 벗어났습니다.")
        return path

    def _read(self, path: Path) -> dict[str, Any] | None:
        try:
            if not path.exists():
                return None
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _atomic_write(self, path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=path.parent,
                prefix=f".{path.name}.", suffix=".tmp", delete=False,
            ) as temporary:
                temporary_name = temporary.name
                json.dump(value, temporary, ensure_ascii=False, indent=2)
                temporary.write("\n")
                temporary.flush()
                os.fsync(temporary.fileno())
            os.replace(temporary_name, path)
            temporary_name = None
        finally:
            if temporary_name is not None:
                try:
                    Path(temporary_name).unlink()
                except FileNotFoundError:
                    pass

    def get(self, collection: str, key: str) -> dict[str, Any] | None:
        return self._read(self._file(collection, key))

    def put(
        self, collection: str, key: str, value: dict[str, Any], *, expected_rev: int | None = None,
    ) -> dict[str, Any]:
        path = self._file(collection, key)
        with self._lock:
            current = self._read(path)
            current_rev = current.get("_rev") if current else None
            current_rev = current_rev if isinstance(current_rev, int) else None
            if expected_rev is not None and expected_rev != current_rev:
                raise VersionConflict(collection, key)
            new_value = {**value, "_rev": (current_rev or 0) + 1}
            self._atomic_write(path, new_value)
            return new_value

    def delete(self, collection: str, key: str) -> bool:
        path = self._file(collection, key)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False

    def list_keys(self, collection: str) -> list[str]:
        try:
            return [f.stem for f in self._dir(collection).iterdir() if f.suffix == ".json"]
        except OSError:
            return []
