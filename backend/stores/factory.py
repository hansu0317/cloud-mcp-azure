"""환경변수(STORAGE_BACKEND)에 맞는 DocumentStore를 생성·공유한다.

``backend/providers/provider_factory.py``(LLM provider 선택)와 같은 모양이다 — 지금은
``"local"`` 하나만 구현돼 있고, 나중에 온프레미스 DB나 Azure Table Storage로 옮길 때 이
파일에 분기를 하나 추가하면 된다(호출부인 ``backend/store/projects.py``, ``backend/main.py``는
``get_store()``만 알지 어떤 구현체인지 모른다).
"""
from __future__ import annotations

import os
from pathlib import Path

from .base import DocumentStore
from .local_file_store import LocalFileStore

_singleton: DocumentStore | None = None


def configured_backend_kind() -> str:
    value = os.environ.get("STORAGE_BACKEND", "local").strip().lower()
    if value != "local":
        raise RuntimeError(f'지원하지 않는 STORAGE_BACKEND "{value}"입니다. 현재는 local만 지원합니다.')
    return value


def create_store(kind: str | None = None) -> DocumentStore:
    selected = kind or configured_backend_kind()
    if selected == "local":
        return LocalFileStore(root=Path.cwd() / "data")
    raise RuntimeError(f'지원하지 않는 STORAGE_BACKEND "{selected}"입니다.')


def get_store() -> DocumentStore:
    """현재 프로필 store 하나를 프로세스 전체에서 공유한다."""
    global _singleton
    if _singleton is None:
        _singleton = create_store()
    return _singleton


async def close_store() -> None:
    """FastAPI lifespan 종료 시 호출 — 로컬 구현은 할 일이 없지만, 나중에 네트워크
    클라이언트를 들고 있는 백엔드가 정리할 자리를 미리 만들어둔다."""
    global _singleton
    if _singleton is not None:
        _singleton.close()
        _singleton = None
