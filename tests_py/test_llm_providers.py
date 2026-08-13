from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

import httpx

from backend.anthropic_provider import AnthropicProvider
from backend.llm_provider import LlmStreamRequest, LlmToolDefinition, LlmProviderError, user_text_message
from backend.ollama_provider import OllamaProvider
from backend.provider_factory import configured_provider_kind


BASE_REQUEST = LlmStreamRequest(
    system="한국어로 답하세요.",
    messages=[user_text_message("상위 3건")],
    tools=[LlmToolDefinition(
        name="dataverse_query",
        description="Dataverse 읽기 전용 조회",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )],
)


async def collect(provider, request=BASE_REQUEST):
    return [event async for event in provider.stream(request)]


class ProviderConfigurationTests(unittest.TestCase):
    def test_common_configuration_precedes_provider_specific_values(self) -> None:
        values = {
            "LLM_MODEL": "common-model",
            "LLM_BASE_URL": "https://common.example/v1/",
            "ANTHROPIC_MODEL": "anthropic-fallback",
            "ANTHROPIC_BASE_URL": "https://anthropic.example",
            "LOCAL_LLM_MODEL": "ollama-fallback",
            "LOCAL_LLM_BASE_URL": "http://ollama.example:11434",
        }
        with patch.dict(os.environ, values, clear=False):
            anthropic = AnthropicProvider(api_key="test-key")
            ollama = OllamaProvider()
        self.assertEqual(anthropic.model, "common-model")
        self.assertEqual(anthropic.endpoint, "https://common.example")
        self.assertEqual(ollama.model, "common-model")
        self.assertEqual(ollama.endpoint, "https://common.example")

    def test_provider_specific_configuration_is_the_fallback(self) -> None:
        values = {
            "ANTHROPIC_MODEL": "claude-fallback",
            "ANTHROPIC_BASE_URL": "https://anthropic.example/",
            "LOCAL_LLM_MODEL": "qwen-fallback",
            "LOCAL_LLM_BASE_URL": "http://ollama.example:11434/v1/",
        }
        with patch.dict(os.environ, values, clear=False):
            os.environ.pop("LLM_MODEL", None)
            os.environ.pop("LLM_BASE_URL", None)
            anthropic = AnthropicProvider(api_key="test-key")
            ollama = OllamaProvider()
        self.assertEqual(anthropic.model, "claude-fallback")
        self.assertEqual(anthropic.endpoint, "https://anthropic.example")
        self.assertEqual(ollama.model, "qwen-fallback")
        self.assertEqual(ollama.endpoint, "http://ollama.example:11434")

    def test_factory_rejects_unknown_provider(self) -> None:
        with patch.dict(os.environ, {"LLM_PROVIDER": "unknown"}, clear=False):
            with self.assertRaises(LlmProviderError):
                configured_provider_kind()


class ProviderStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_anthropic_converts_canonical_request_and_sse_tool_call(self) -> None:
        captured: dict[str, object] = {}
        sse = "\n".join([
            "event: message_start",
            'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"조회합니다."}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":0}',
            "",
            "event: content_block_start",
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"dataverse_query","input":{}}}',
            "",
            "event: content_block_delta",
            'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"accounts?$top=3\\"}"}}',
            "",
            "event: content_block_stop",
            'data: {"type":"content_block_stop","index":1}',
            "",
            "event: message_delta",
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
            "",
            "event: message_stop",
            'data: {"type":"message_stop"}',
            "",
        ])

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, content=sse, headers={"content-type": "text/event-stream"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = AnthropicProvider(
                api_key="test-key",
                model="claude-test",
                endpoint="https://anthropic.test",
                http_client=client,
            )
            events = await collect(provider)

        self.assertEqual(captured["url"], "https://anthropic.test/v1/messages")
        body = captured["body"]
        assert isinstance(body, dict)
        self.assertEqual(body["messages"], [
            {"role": "user", "content": [{"type": "text", "text": "상위 3건"}]},
        ])
        self.assertEqual(body["tools"], [{
            "name": "dataverse_query",
            "description": "Dataverse 읽기 전용 조회",
            "input_schema": BASE_REQUEST.tools[0].input_schema,
        }])
        self.assertEqual(events[:2], [
            {"type": "text", "text": "조회합니다."},
            {"type": "tool_start", "id": "tool-1", "name": "dataverse_query"},
        ])
        done = events[-1]
        self.assertEqual(done["type"], "done")
        self.assertEqual(done["toolCalls"], [
            {"id": "tool-1", "name": "dataverse_query", "input": {"path": "accounts?$top=3"}},
        ])
        self.assertEqual(done["stopReason"], "tool_use")
        self.assertEqual(done["usage"], {
            "inputTokens": 11,
            "outputTokens": 7,
            "cacheReadInputTokens": 3,
            "cacheCreationInputTokens": 2,
        })

    async def test_ollama_converts_canonical_request_and_ndjson_tool_call(self) -> None:
        captured: dict[str, object] = {}
        ndjson = "\n".join([
            json.dumps({"message": {"role": "assistant", "content": "<think>내부 추론</think>"}, "done": False}),
            json.dumps({
                "message": {
                    "role": "assistant",
                    "content": "조회합니다.",
                    "tool_calls": [{
                        "id": "call-1",
                        "function": {
                            "index": 0,
                            "name": "dataverse_query",
                            "arguments": {"path": "accounts?$top=3"},
                        },
                    }],
                },
                "done": False,
            }),
            json.dumps({
                "message": {"role": "assistant", "content": ""},
                "done": True,
                "done_reason": "stop",
                "prompt_eval_count": 13,
                "eval_count": 5,
            }),
            "",
        ])

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, content=ndjson, headers={"content-type": "application/x-ndjson"})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OllamaProvider(
                model="qwen-test",
                endpoint="http://ollama.test:11434",
                http_client=client,
            )
            events = await collect(provider)

        self.assertEqual(captured["url"], "http://ollama.test:11434/api/chat")
        body = captured["body"]
        assert isinstance(body, dict)
        self.assertEqual(body["messages"], [
            {"role": "system", "content": "한국어로 답하세요."},
            {"role": "user", "content": "상위 3건"},
        ])
        self.assertEqual(events[:2], [
            {"type": "tool_start", "id": "call-1", "name": "dataverse_query"},
            {"type": "text", "text": "조회합니다."},
        ])
        done = events[-1]
        self.assertEqual(done["message"]["content"], [
            {"type": "text", "text": "조회합니다."},
            {"type": "tool_call", "id": "call-1", "name": "dataverse_query", "input": {"path": "accounts?$top=3"}},
        ])
        self.assertEqual(done["stopReason"], "tool_use")
        self.assertEqual(done["usage"], {
            "inputTokens": 13,
            "outputTokens": 5,
            "cacheReadInputTokens": 0,
            "cacheCreationInputTokens": 0,
        })

    async def test_both_health_checks_use_only_the_injected_client(self) -> None:
        urls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": "qwen3:30b-a3b"}]})
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            anthropic = AnthropicProvider(
                api_key="test-key", endpoint="https://anthropic.test", http_client=client
            )
            ollama = OllamaProvider(endpoint="http://ollama.test:11434", http_client=client)
            self.assertEqual((await anthropic.health()).status, "ok")
            self.assertEqual((await ollama.health()).status, "ok")

        self.assertEqual(urls, [
            "https://anthropic.test/v1/models",
            "http://ollama.test:11434/api/tags",
        ])

    async def test_ollama_health_requires_the_configured_model(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"models": [{"name": "other:latest"}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OllamaProvider(
                model="required-model",
                endpoint="http://ollama.test:11434",
                http_client=client,
            )
            health = await provider.health()

        self.assertEqual(health.status, "misconfigured")
        self.assertIn("설치되어 있지 않습니다", health.error or "")


if __name__ == "__main__":
    unittest.main()
