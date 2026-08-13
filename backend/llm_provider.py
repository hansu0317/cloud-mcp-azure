"""LLM 공급자 공통 계약.

FastAPI 채팅 계층은 이 모듈의 canonical 메시지/이벤트만 사용한다. Anthropic과
Ollama 고유 형식은 각 adapter 안에서만 변환해, 공급자를 바꿔도 Dataverse 도구
루프와 SSE 계약이 달라지지 않게 한다.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Mapping, Sequence

LlmProviderKind = Literal["anthropic", "ollama"]
LlmStopReason = Literal[
    "end_turn",
    "tool_use",
    "max_tokens",
    "stop_sequence",
    "content_filter",
    "unknown",
]
LlmHealthStatus = Literal["ok", "unreachable", "misconfigured"]
LlmProviderErrorCode = Literal[
    "misconfigured",
    "timeout",
    "cancelled",
    "http_error",
    "invalid_response",
    "provider_error",
]

# canonical message block 예:
#   {"type": "text", "text": "..."}
#   {"type": "tool_call", "id": "...", "name": "...", "input": {...}}
#   {"type": "tool_result", "toolCallId": "...", "name": "...",
#    "content": "...", "isError": False}
LlmBlock = dict[str, Any]
LlmMessage = dict[str, Any]
LlmStreamEvent = dict[str, Any]


@dataclass(frozen=True, slots=True)
class LlmToolDefinition:
    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class LlmUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cacheReadInputTokens": self.cache_read_input_tokens,
            "cacheCreationInputTokens": self.cache_creation_input_tokens,
        }


@dataclass(frozen=True, slots=True)
class LlmStreamRequest:
    system: str
    messages: Sequence[LlmMessage]
    tools: Sequence[LlmToolDefinition] = field(default_factory=tuple)
    timeout_s: float = 120.0
    max_tokens: int | None = None


@dataclass(frozen=True, slots=True)
class LlmHealth:
    status: LlmHealthStatus
    provider: LlmProviderKind
    model: str
    endpoint: str | None = None
    error: str | None = None
    details: Mapping[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "status": self.status,
            "provider": self.provider,
            "model": self.model,
        }
        if self.endpoint is not None:
            result["endpoint"] = self.endpoint
        if self.error is not None:
            result["error"] = self.error
        if self.details is not None:
            result["details"] = dict(self.details)
        return result


class LlmProviderError(RuntimeError):
    """공급자 오류를 FastAPI 계층에서 동일하게 처리하기 위한 예외."""

    def __init__(
        self,
        provider: LlmProviderKind,
        code: LlmProviderErrorCode,
        message: str,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.code = code
        self.retryable = retryable


class LlmProvider(ABC):
    kind: LlmProviderKind
    model: str
    endpoint: str

    @abstractmethod
    def is_configured(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def stream(self, request: LlmStreamRequest) -> AsyncIterator[LlmStreamEvent]:
        """text/tool_start를 내보낸 뒤 done을 정확히 한 번 내보낸다."""
        raise NotImplementedError

    @abstractmethod
    async def health(self, timeout_s: float = 3.0) -> LlmHealth:
        raise NotImplementedError

    @abstractmethod
    async def aclose(self) -> None:
        raise NotImplementedError


def user_text_message(text: str) -> LlmMessage:
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def tool_results_message(results: Sequence[LlmBlock]) -> LlmMessage:
    return {"role": "user", "content": list(results)}


def as_object(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}
