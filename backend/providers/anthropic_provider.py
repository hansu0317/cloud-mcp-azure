"""Anthropic Messages REST streaming adapter."""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator, Mapping

import httpx

from .llm_provider import (
    LlmHealth,
    LlmProvider,
    LlmProviderError,
    LlmStopReason,
    LlmStreamEvent,
    LlmStreamRequest,
    LlmUsage,
    as_object,
)

DEFAULT_ENDPOINT = "https://api.anthropic.com"


def _clean_endpoint(value: str) -> str:
    endpoint = value.rstrip("/")
    return endpoint[:-3] if endpoint.endswith("/v1") else endpoint


def _to_anthropic_message(message: Mapping[str, Any]) -> dict[str, Any]:
    converted: list[dict[str, Any]] = []
    for raw_block in message.get("content", []):
        block = as_object(raw_block)
        block_type = block.get("type")
        if block_type == "text":
            converted.append({"type": "text", "text": str(block.get("text", ""))})
        elif block_type == "tool_call":
            converted.append({
                "type": "tool_use",
                "id": str(block.get("id", "")),
                "name": str(block.get("name", "")),
                "input": as_object(block.get("input")),
            })
        elif block_type == "tool_result":
            result: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": str(block.get("toolCallId", "")),
                "content": str(block.get("content", "")),
            }
            if block.get("isError"):
                result["is_error"] = True
            converted.append(result)
    return {"role": str(message.get("role", "user")), "content": converted}


def _map_stop_reason(reason: Any) -> LlmStopReason:
    return {
        "end_turn": "end_turn",
        "tool_use": "tool_use",
        "max_tokens": "max_tokens",
        "stop_sequence": "stop_sequence",
        "refusal": "content_filter",
    }.get(reason, "unknown")  # type: ignore[return-value]


class AnthropicProvider(LlmProvider):
    kind = "anthropic"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        endpoint: str | None = None,
        max_tokens: int | None = None,
        anthropic_version: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key if api_key is not None else os.environ.get("ANTHROPIC_API_KEY", "")
        self.model = model or os.environ.get("LLM_MODEL") or os.environ.get("ANTHROPIC_MODEL") or "claude-haiku-4-5"
        self.endpoint = _clean_endpoint(
            endpoint
            or os.environ.get("LLM_BASE_URL")
            or os.environ.get("ANTHROPIC_BASE_URL")
            or DEFAULT_ENDPOINT
        )
        self._max_tokens = max_tokens or int(os.environ.get("ANTHROPIC_MAX_TOKENS", "4096"))
        self._anthropic_version = anthropic_version or os.environ.get("ANTHROPIC_VERSION", "2023-06-01")
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=None)

    def is_configured(self) -> bool:
        return bool(self._api_key)

    async def _http_error(self, response: httpx.Response) -> str:
        raw = (await response.aread()).decode("utf-8", errors="replace")
        try:
            body = as_object(json.loads(raw))
            error = as_object(body.get("error"))
            return str(error.get("message") or raw)[:1000]
        except json.JSONDecodeError:
            return raw[:1000]

    async def stream(self, request: LlmStreamRequest) -> AsyncIterator[LlmStreamEvent]:
        if not self.is_configured():
            raise LlmProviderError("anthropic", "misconfigured", "ANTHROPIC_API_KEY가 설정되지 않았습니다.")

        body: dict[str, Any] = {
            "model": self.model,
            "max_tokens": request.max_tokens or self._max_tokens,
            "stream": True,
            "system": [{
                "type": "text",
                "text": request.system,
                "cache_control": {"type": "ephemeral"},
            }],
            "messages": [_to_anthropic_message(message) for message in request.messages],
        }
        if request.tools:
            body["tools"] = [{
                "name": tool.name,
                "description": tool.description,
                "input_schema": dict(tool.input_schema),
            } for tool in request.tools]

        blocks: dict[int, dict[str, Any]] = {}
        tool_json: dict[int, str] = {}
        provider_stop_reason: str | None = None
        usage = LlmUsage()
        saw_message_stop = False

        def consume(data: str) -> list[LlmStreamEvent]:
            nonlocal provider_stop_reason, usage, saw_message_stop
            if not data or data == "[DONE]":
                return []
            try:
                event = as_object(json.loads(data))
            except json.JSONDecodeError as exc:
                raise LlmProviderError(
                    "anthropic", "invalid_response", "Anthropic SSE JSON을 해석할 수 없습니다."
                ) from exc

            event_type = event.get("type")
            if event_type == "error":
                error = as_object(event.get("error"))
                raise LlmProviderError(
                    "anthropic", "provider_error", str(error.get("message") or "Anthropic stream 오류")
                )
            if event_type == "message_start":
                start_usage = as_object(as_object(event.get("message")).get("usage"))
                usage = LlmUsage(
                    input_tokens=int(start_usage.get("input_tokens") or 0),
                    cache_read_input_tokens=int(start_usage.get("cache_read_input_tokens") or 0),
                    cache_creation_input_tokens=int(start_usage.get("cache_creation_input_tokens") or 0),
                )
            elif event_type == "content_block_start":
                index = int(event.get("index") or 0)
                block = as_object(event.get("content_block"))
                if block.get("type") == "text":
                    text = str(block.get("text") or "")
                    blocks[index] = {"type": "text", "text": text}
                    return [{"type": "text", "text": text}] if text else []
                if block.get("type") == "tool_use":
                    tool_id = str(block.get("id") or f"tool_{index}")
                    name = str(block.get("name") or "")
                    blocks[index] = {
                        "type": "tool_call",
                        "id": tool_id,
                        "name": name,
                        "input": as_object(block.get("input")),
                    }
                    tool_json[index] = ""
                    return [{"type": "tool_start", "id": tool_id, "name": name}]
            elif event_type == "content_block_delta":
                index = int(event.get("index") or 0)
                delta = as_object(event.get("delta"))
                if delta.get("type") == "text_delta":
                    text = str(delta.get("text") or "")
                    block = blocks.setdefault(index, {"type": "text", "text": ""})
                    block["text"] = str(block.get("text") or "") + text
                    return [{"type": "text", "text": text}] if text else []
                if delta.get("type") == "input_json_delta":
                    tool_json[index] = tool_json.get(index, "") + str(delta.get("partial_json") or "")
            elif event_type == "content_block_stop":
                index = int(event.get("index") or 0)
                block = blocks.get(index)
                raw_json = tool_json.get(index)
                if block and block.get("type") == "tool_call" and raw_json:
                    try:
                        block["input"] = as_object(json.loads(raw_json))
                    except json.JSONDecodeError as exc:
                        raise LlmProviderError(
                            "anthropic",
                            "invalid_response",
                            f"도구 입력 JSON을 해석할 수 없습니다: {block.get('name', '')}",
                        ) from exc
            elif event_type == "message_delta":
                delta = as_object(event.get("delta"))
                if delta.get("stop_reason") is not None:
                    provider_stop_reason = str(delta["stop_reason"])
                delta_usage = as_object(event.get("usage"))
                usage = LlmUsage(
                    input_tokens=usage.input_tokens,
                    output_tokens=int(delta_usage.get("output_tokens") or usage.output_tokens),
                    cache_read_input_tokens=usage.cache_read_input_tokens,
                    cache_creation_input_tokens=usage.cache_creation_input_tokens,
                )
            elif event_type == "message_stop":
                saw_message_stop = True
            return []

        try:
            timeout = httpx.Timeout(request.timeout_s)
            async with self._http.stream(
                "POST",
                f"{self.endpoint}/v1/messages",
                headers={
                    "content-type": "application/json",
                    "x-api-key": self._api_key,
                    "anthropic-version": self._anthropic_version,
                },
                json=body,
                timeout=timeout,
            ) as response:
                if response.status_code >= 400:
                    message = await self._http_error(response)
                    raise LlmProviderError(
                        "anthropic",
                        "http_error",
                        f"Anthropic API HTTP {response.status_code}: {message}",
                        retryable=response.status_code == 429 or response.status_code >= 500,
                    )

                data_lines: list[str] = []
                async for line in response.aiter_lines():
                    if line == "":
                        if data_lines:
                            for stream_event in consume("\n".join(data_lines)):
                                yield stream_event
                            data_lines.clear()
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                if data_lines:
                    for stream_event in consume("\n".join(data_lines)):
                        yield stream_event
        except asyncio.CancelledError as exc:
            raise LlmProviderError("anthropic", "cancelled", "요청이 취소되었습니다.") from exc
        except httpx.TimeoutException as exc:
            raise LlmProviderError(
                "anthropic",
                "timeout",
                f"Anthropic 응답 타임아웃 ({request.timeout_s:g}초)",
                retryable=True,
            ) from exc
        except httpx.RequestError as exc:
            raise LlmProviderError(
                "anthropic", "provider_error", f"Anthropic 호출 실패: {exc}", retryable=True
            ) from exc

        if not saw_message_stop:
            raise LlmProviderError(
                "anthropic", "invalid_response", "Anthropic stream이 message_stop 없이 종료되었습니다."
            )

        content = [blocks[index] for index in sorted(blocks)]
        tool_calls = [
            {"id": block["id"], "name": block["name"], "input": as_object(block.get("input"))}
            for block in content
            if block.get("type") == "tool_call"
        ]
        yield {
            "type": "done",
            "message": {"role": "assistant", "content": content},
            "toolCalls": tool_calls,
            "stopReason": _map_stop_reason(provider_stop_reason),
            "providerStopReason": provider_stop_reason,
            "usage": usage.to_dict(),
        }

    async def health(self, timeout_s: float = 3.0) -> LlmHealth:
        if not self.is_configured():
            return LlmHealth(
                "misconfigured", self.kind, self.model, self.endpoint, "ANTHROPIC_API_KEY 미설정"
            )
        try:
            response = await self._http.get(
                f"{self.endpoint}/v1/models",
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": self._anthropic_version,
                },
                timeout=timeout_s,
            )
            if response.is_success:
                return LlmHealth("ok", self.kind, self.model, self.endpoint)
            return LlmHealth(
                "unreachable", self.kind, self.model, self.endpoint, f"HTTP {response.status_code}"
            )
        except httpx.HTTPError as exc:
            return LlmHealth("unreachable", self.kind, self.model, self.endpoint, str(exc))

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()
