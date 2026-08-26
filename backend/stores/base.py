"""문서(JSON dict) 하나를 collection/key로 저장·조회하는 최소 인터페이스.

프로젝트 파일(``backend/store/projects.py``)과 스키마 카탈로그(``backend/main.py``)가
지금은 로컬 JSON 파일을 직접 여닫는데, 이 계약 뒤로 옮겨두면 나중에 온프레미스 DB나
Azure Table Storage 같은 실제 서버로 옮길 때 새 구현체(``DocumentStore`` 하위 클래스) 하나만
추가하면 되고 호출부는 손댈 필요가 없다 — ``backend/providers``의 ``LlmProvider`` 인터페이스와
같은 목적, 같은 모양이다.

동기(sync) 인터페이스로 둔다 — 지금 프로젝트 저장소가 "동기 파일 I/O만 쓴다"는 전제로
짜여 있고(같은 이유로 기존 테스트도 전부 동기 호출), 그 전제를 지금 깨면 테스트까지 전부
바꿔야 해서 범위가 커진다. 나중에 실제로 네트워크를 타는 백엔드를 붙일 때는 그 라우트
호출부에서 ``asyncio.to_thread(...)``로 감싸면 된다.

``_rev``: ``put()``이 문서마다 관리하는 정수 버전 필드. 로컬 파일이든 나중의 DB/Table
Storage든 "내가 마지막으로 본 버전과 다르면 거절"이라는 낙관적 동시성 계약을 이 필드
하나로 통일한다.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class VersionConflict(RuntimeError):
    """expected_rev가 현재 저장된 문서의 _rev와 다를 때 put()이 던진다."""

    def __init__(self, collection: str, key: str) -> None:
        super().__init__(f'"{collection}/{key}" 문서가 그 사이 다른 곳에서 갱신되었습니다.')
        self.collection = collection
        self.key = key


class DocumentStore(ABC):
    """collection/key로 구분되는 JSON 문서 하나에 대한 get/put/delete/list."""

    @abstractmethod
    def get(self, collection: str, key: str) -> dict[str, Any] | None:
        """문서를 반환한다(``_rev`` 포함). 없으면 None."""

    @abstractmethod
    def put(
        self, collection: str, key: str, value: dict[str, Any], *, expected_rev: int | None = None,
    ) -> dict[str, Any]:
        """문서를 저장하고 ``_rev``가 채워진 최종 값을 반환한다.

        ``expected_rev``가 주어졌는데 현재 저장된 값의 ``_rev``와 다르면(또는 문서가 이미
        있는데 ``expected_rev``가 None이 아니어야 할 상황에서 문서가 없으면) VersionConflict.
        ``expected_rev=None``(기본값)은 지금까지의 "그냥 덮어쓰기" 동작과 동일하다.
        """

    @abstractmethod
    def delete(self, collection: str, key: str) -> bool:
        """문서를 지운다. 원래 없었으면 False."""

    @abstractmethod
    def list_keys(self, collection: str) -> list[str]:
        """collection 안에 있는 문서 key 전체(순서 무관)."""

    def close(self) -> None:
        """프로세스 종료 시 자원 정리(연결 클라이언트 등). 로컬 구현은 할 일이 없다."""
