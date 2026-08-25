"""Ollama native ``/api/chat`` NDJSON streaming adapter."""
from __future__ import annotations

import asyncio
import json
import os
import re
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


def _clean_endpoint(value: str) -> str:
    endpoint = value.rstrip("/")
    return endpoint[:-3] if endpoint.endswith("/v1") else endpoint


def _to_ollama_messages(message: Mapping[str, Any]) -> list[dict[str, Any]]:
    role = message.get("role")
    blocks = [as_object(block) for block in message.get("content", [])]
    if role == "assistant":
        text = "".join(str(block.get("text") or "") for block in blocks if block.get("type") == "text")
        calls = [block for block in blocks if block.get("type") == "tool_call"]
        result: dict[str, Any] = {"role": "assistant", "content": text}
        if calls:
            result["tool_calls"] = [{
                "id": str(call.get("id") or ""),
                "type": "function",
                "function": {
                    "index": index,
                    "name": str(call.get("name") or ""),
                    "arguments": as_object(call.get("input")),
                },
            } for index, call in enumerate(calls)]
        return [result]

    output: list[dict[str, Any]] = []
    pending_text = ""
    for block in blocks:
        if block.get("type") == "text":
            pending_text += str(block.get("text") or "")
        elif block.get("type") == "tool_result":
            if pending_text:
                output.append({"role": "user", "content": pending_text})
                pending_text = ""
            output.append({
                "role": "tool",
                "content": str(block.get("content") or ""),
                "tool_name": str(block.get("name") or ""),
            })
    if pending_text or not output:
        output.append({"role": "user", "content": pending_text})
    return output


def _map_stop_reason(reason: Any, has_tools: bool) -> LlmStopReason:
    if has_tools:
        return "tool_use"
    return {"stop": "end_turn", "length": "max_tokens"}.get(reason, "unknown")  # type: ignore[return-value]


def _visible_text(text: str) -> str:
    """thinking 모델의 내부 추론을 사용자에게 보내지 않는다."""
    last_end = text.lower().rfind("</think>")
    if last_end >= 0:
        return text[last_end + len("</think>"):].strip()
    without_complete_blocks = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    unclosed = without_complete_blocks.lower().find("<think>")
    if unclosed >= 0:
        without_complete_blocks = without_complete_blocks[:unclosed]
    return without_complete_blocks.strip()


class OllamaProvider(LlmProvider):
    kind = "ollama"

    def __init__(
        self,
        *,
        model: str | None = None,
        endpoint: str | None = None,
        max_tokens: int | None = None,
        keep_alive: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model = model or os.environ.get("LLM_MODEL") or os.environ.get("LOCAL_LLM_MODEL") or "qwen3:30b-a3b"
        self.endpoint = _clean_endpoint(
            endpoint
            or os.environ.get("LLM_BASE_URL")
            or os.environ.get("LOCAL_LLM_BASE_URL")
            or "http://localhost:11434"
        )
        self._max_tokens = max_tokens or int(os.environ.get("LOCAL_LLM_MAX_TOKENS", "4096"))
        self._keep_alive = keep_alive or os.environ.get("LOCAL_LLM_KEEP_ALIVE", "5m")
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=None)

    def is_configured(self) -> bool:
        # Ollama는 API 키가 없으며, 실제 가용성은 health에서 확인한다.
        return True

    async def stream(self, request: LlmStreamRequest) -> AsyncIterator[LlmStreamEvent]:
        messages: list[dict[str, Any]] = [{"role": "system", "content": request.system}]
        for message in request.messages:
            messages.extend(_to_ollama_messages(message))

        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "think": False,
            "options": {"num_predict": request.max_tokens or self._max_tokens},
            "keep_alive": self._keep_alive,
        }
        if request.tools:
            body["tools"] = [{
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": dict(tool.input_schema),
                },
            } for tool in request.tools]

        raw_text = ""
        provider_stop_reason: str | None = None
        usage = LlmUsage()
        saw_done = False
        tool_calls: dict[int, dict[str, Any]] = {}
        announced: set[int] = set()

        def consume(line: str) -> list[LlmStreamEvent]:
            nonlocal raw_text, provider_stop_reason, usage, saw_done
            if not line.strip():
                return []
            try:
                chunk = as_object(json.loads(line))
            except json.JSONDecodeError as exc:
                raise LlmProviderError(
                    "ollama", "invalid_response", "Ollama NDJSON을 해석할 수 없습니다."
                ) from exc
            if chunk.get("error"):
                raise LlmProviderError("ollama", "provider_error", str(chunk["error"]))

            message = as_object(chunk.get("message"))
            raw_text += str(message.get("content") or "")
            events: list[LlmStreamEvent] = []
            raw_calls = message.get("tool_calls")
            for position, raw_call in enumerate(raw_calls if isinstance(raw_calls, list) else []):
                call = as_object(raw_call)
                function = as_object(call.get("function"))
                index = int(function.get("index", call.get("index", position)))
                existing = tool_calls.get(index, {})
                call_id = str(call.get("id") or existing.get("id") or f"call_{index}")
                name = str(function.get("name") or existing.get("name") or "")
                arguments = function.get("arguments")
                parsed_arguments = as_object(existing.get("input"))
                if isinstance(arguments, Mapping):
                    parsed_arguments = dict(arguments)
                elif isinstance(arguments, str) and arguments:
                    try:
                        parsed_arguments = as_object(json.loads(arguments))
                    except json.JSONDecodeError:
                        # 일부 Ollama 모델은 문자열 인자를 여러 chunk로 나눈다.
                        previous = str(existing.get("arguments_json") or "")
                        combined = previous + arguments
                        try:
                            parsed_arguments = as_object(json.loads(combined))
                        except json.JSONDecodeError:
                            parsed_arguments = as_object(existing.get("input"))
                        existing["arguments_json"] = combined
                existing.update({"id": call_id, "name": name, "input": parsed_arguments})
                tool_calls[index] = existing
                if name and index not in announced:
                    announced.add(index)
                    events.append({"type": "tool_start", "id": call_id, "name": name})

            if chunk.get("done") is True:
                saw_done = True
                if chunk.get("done_reason") is not None:
                    provider_stop_reason = str(chunk["done_reason"])
                usage = LlmUsage(
                    input_tokens=int(chunk.get("prompt_eval_count") or 0),
                    output_tokens=int(chunk.get("eval_count") or 0),
                )
            return events

        try:
            timeout = httpx.Timeout(request.timeout_s)
            async with self._http.stream(
                "POST",
                f"{self.endpoint}/api/chat",
                json=body,
                timeout=timeout,
            ) as response:
                if response.status_code >= 400:
                    raw_error = (await response.aread()).decode("utf-8", errors="replace")[:1000]
                    raise LlmProviderError(
                        "ollama",
                        "http_error",
                        f"Ollama HTTP {response.status_code}: {raw_error}",
                        retryable=response.status_code >= 500,
                    )
                async for line in response.aiter_lines():
                    for event in consume(line):
                        yield event
        except asyncio.CancelledError as exc:
            raise LlmProviderError("ollama", "cancelled", "요청이 취소되었습니다.") from exc
        except httpx.TimeoutException as exc:
            raise LlmProviderError(
                "ollama",
                "timeout",
                f"Ollama 응답 타임아웃 ({request.timeout_s:g}초)",
                retryable=True,
            ) from exc
        except httpx.RequestError as exc:
            raise LlmProviderError(
                "ollama",
                "provider_error",
                f"Ollama 호출 실패({self.endpoint}, model={self.model}): {exc}",
                retryable=True,
            ) from exc

        if not saw_done:
            raise LlmProviderError("ollama", "invalid_response", "Ollama stream이 done 없이 종료되었습니다.")

        text = _visible_text(raw_text)
        if text:
            yield {"type": "text", "text": text}
        normalized_calls = []
        for index in sorted(tool_calls):
            call = tool_calls[index]
            call.pop("arguments_json", None)
            normalized_calls.append(call)
        content = ([{"type": "text", "text": text}] if text else []) + [
            {"type": "tool_call", **call} for call in normalized_calls
        ]
        yield {
            "type": "done",
            "message": {"role": "assistant", "content": content},
            "toolCalls": normalized_calls,
            "stopReason": _map_stop_reason(provider_stop_reason, bool(normalized_calls)),
            "providerStopReason": provider_stop_reason,
            "usage": usage.to_dict(),
        }

    async def health(self, timeout_s: float = 3.0) -> LlmHealth:
        try:
            response = await self._http.get(f"{self.endpoint}/api/tags", timeout=timeout_s)
            if response.is_success:
                try:
                    payload = response.json()
                except (json.JSONDecodeError, ValueError) as exc:
                    return LlmHealth(
                        "unreachable",
                        self.kind,
                        self.model,
                        self.endpoint,
                        f"Ollama /api/tags 응답이 JSON이 아닙니다: {exc}",
                    )
                raw_models = payload.get("models") if isinstance(payload, Mapping) else None
                if not isinstance(raw_models, list):
                    return LlmHealth(
                        "unreachable",
                        self.kind,
                        self.model,
                        self.endpoint,
                        "Ollama /api/tags 응답에 models 배열이 없습니다.",
                    )
                installed: set[str] = set()
                for raw_model in raw_models:
                    if not isinstance(raw_model, Mapping):
                        continue
                    for field in ("name", "model"):
                        value = raw_model.get(field)
                        if isinstance(value, str) and value:
                            installed.add(value)
                accepted_names = {self.model}
                if ":" not in self.model:
                    accepted_names.add(f"{self.model}:latest")
                if installed.isdisjoint(accepted_names):
                    return LlmHealth(
                        "misconfigured",
                        self.kind,
                        self.model,
                        self.endpoint,
                        f'설정한 Ollama 모델 "{self.model}"이 설치되어 있지 않습니다.',
                        {"installedModelCount": len(installed)},
                    )
                return LlmHealth(
                    "ok",
                    self.kind,
                    self.model,
                    self.endpoint,
                    details={"installedModelCount": len(installed)},
                )
            return LlmHealth(
                "unreachable", self.kind, self.model, self.endpoint, f"HTTP {response.status_code}"
            )
        except httpx.HTTPError as exc:
            return LlmHealth("unreachable", self.kind, self.model, self.endpoint, str(exc))

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http.aclose()
