"""환경 프로필에 맞는 Python LLM provider를 생성·공유한다."""
from __future__ import annotations

import os

from .anthropic_provider import AnthropicProvider
from .llm_provider import LlmProvider, LlmProviderError, LlmProviderKind
from .ollama_provider import OllamaProvider

_singleton: LlmProvider | None = None


def configured_provider_kind() -> LlmProviderKind:
    value = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()
    if value not in {"anthropic", "ollama"}:
        raise LlmProviderError(
            "anthropic",
            "misconfigured",
            f'지원하지 않는 LLM_PROVIDER "{value}"입니다. anthropic 또는 ollama를 사용하세요.',
        )
    return value  # type: ignore[return-value]


def create_llm_provider(kind: LlmProviderKind | None = None) -> LlmProvider:
    selected = kind or configured_provider_kind()
    if selected == "anthropic":
        return AnthropicProvider()
    return OllamaProvider()


def get_llm_provider() -> LlmProvider:
    """현재 프로필 provider 하나를 프로세스 전체에서 공유한다."""
    global _singleton
    if _singleton is None:
        _singleton = create_llm_provider()
    return _singleton


async def close_llm_provider() -> None:
    """FastAPI lifespan 종료 시 내부 HTTP client를 닫는다."""
    global _singleton
    if _singleton is not None:
        await _singleton.aclose()
        _singleton = None
