"""Ollama(로컬 LLM) + 실제 Dataverse CRM 데이터 end-to-end 확인용 1회성 스크립트.

앱의 세션/프로젝트/히스토리 레이어를 거치지 않고, chat_api.py와 같은 도구 계약
(dataverse_query tool)만 재사용해서 다음을 검증한다:
  1. 실제 Dataverse(quali.crm5.dynamics.com)에 지금 자격증명으로 접속되는지
  2. 로컬 Ollama 모델이 tool-calling으로 dataverse_query를 스스로 호출하는지
  3. 그 결과로 자연어 최종 답변을 만들어내는지

실행 (crm-ai-chat 루트에서):
    .venv\\Scripts\\python scripts\\test_ollama_dataverse.py "거래처 3개만 보여줘"

사전 준비:
  - Ollama가 로컬(http://localhost:11434)에서 실행 중이고 tool-calling 지원 모델이
    받아져 있어야 함 (예: qwen3:8b, qwen3:30b-a3b) — sqlcoder류는 tool-calling 미지원.
  - .env에 DATAVERSE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/URL이 이미 채워져 있어야 함
    (이 프로젝트는 이미 채워져 있음).

이 스크립트는 앱의 .env를 바꾸지 않는다 — LLM_PROVIDER는 여기서만 강제로 ollama를 쓴다.
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# .env를 backend 모듈 import 전에 로드해야 DATAVERSE_* 값이 os.environ에 반영됨
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
sys.path.insert(0, str(ROOT))

from backend.dataverse import dataverse_env_missing, dataverse_get  # noqa: E402
from backend.providers.llm_provider import (  # noqa: E402
    LlmStreamRequest,
    LlmToolDefinition,
    as_object,
    tool_results_message,
    user_text_message,
)
from backend.providers.ollama_provider import OllamaProvider  # noqa: E402

TEST_MODEL = os.environ.get("TEST_OLLAMA_MODEL", "qwen3:8b")
TEST_ENTITY_SET = os.environ.get("TEST_ENTITY_SET", "new_q1s")  # 거래처 (schema.json 참고)
# 로컬이면 기본값 그대로, Colab+ngrok 테스트 중이면 이 값을 그 공개 URL로 지정:
#   TEST_OLLAMA_BASE_URL=https://xxxx.ngrok-free.app python scripts/test_ollama_dataverse.py
TEST_OLLAMA_BASE_URL = os.environ.get("TEST_OLLAMA_BASE_URL", "http://localhost:11434")

DATAVERSE_QUERY_TOOL = LlmToolDefinition(
    name="dataverse_query",
    description="Dataverse Web API(OData)를 GET으로 조회한다(읽기 전용).",
    input_schema={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "엔티티집합명으로 시작하는 OData 상대 경로"}
        },
        "required": ["path"],
        "additionalProperties": False,
    },
)


async def step1_check_dataverse_connectivity() -> None:
    print("=" * 60)
    print("[1/3] Dataverse 연결 확인")
    print("=" * 60)
    missing = dataverse_env_missing()
    if missing:
        raise SystemExit(f"환경변수 누락: {missing} (.env 확인)")

    text = await dataverse_get(f"{TEST_ENTITY_SET}?$top=1")
    print(f"  OK — {TEST_ENTITY_SET} 조회 성공, 응답 {len(text)} bytes")


async def step2_check_ollama_health(provider: OllamaProvider) -> None:
    print("=" * 60)
    print("[2/3] Ollama 서버/모델 확인")
    print("=" * 60)
    health = await provider.health()
    print(f"  status={health.status} model={health.model} endpoint={health.endpoint}")
    if health.status != "ok":
        raise SystemExit(f"Ollama 준비 안 됨: {health.error}")


async def step3_end_to_end(provider: OllamaProvider, question: str) -> None:
    print("=" * 60)
    print(f"[3/3] End-to-end 테스트: \"{question}\"")
    print("=" * 60)

    system = (
        "당신은 Quali CRM 데이터 조회 어시스턴트입니다. "
        "질문에 답하려면 반드시 dataverse_query 도구로 실제 데이터를 조회한 뒤 "
        "그 결과만 근거로 한국어로 답변하세요. "
        f'조회 가능한 엔티티집합명 예시: "{TEST_ENTITY_SET}" (거래처). '
        "path는 엔티티집합명으로 시작하는 OData 상대 경로여야 합니다 "
        f'(예: "{TEST_ENTITY_SET}?$top=3").'
    )
    messages = [user_text_message(question)]

    for loop_index in range(4):
        request = LlmStreamRequest(
            system=system, messages=messages, tools=(DATAVERSE_QUERY_TOOL,), timeout_s=120
        )
        done_event = None
        async for event in provider.stream(request):
            if event.get("type") == "tool_start":
                print(f"  -> 도구 호출 시작: {event.get('name')}")
            elif event.get("type") == "text" and event.get("text"):
                print(f"  [모델 텍스트] {event['text']}", end="", flush=True)
            elif event.get("type") == "done":
                done_event = event
        print()

        if done_event is None:
            raise SystemExit("스트림이 done 없이 종료됨")

        assistant_message = as_object(done_event.get("message"))
        messages.append(assistant_message)
        tool_calls = done_event.get("toolCalls") or []

        if not tool_calls:
            print("\n  === 최종 답변 (도구 호출 없음) ===")
            print(" ", "".join(
                b.get("text", "") for b in assistant_message.get("content", [])
                if as_object(b).get("type") == "text"
            ))
            return

        results = []
        for raw_call in tool_calls:
            call = as_object(raw_call)
            path = call.get("input", {}).get("path", "")
            print(f"  -> 실행: dataverse_query(path={path!r})")
            try:
                content = await dataverse_get(path)
                is_error = False
            except Exception as exc:  # noqa: BLE001
                content = f"오류: {exc}"
                is_error = True
            print(f"     결과 미리보기: {content[:200]}")
            results.append({
                "type": "tool_result",
                "toolCallId": call.get("id", ""),
                "name": "dataverse_query",
                "content": content,
                "isError": is_error,
            })
        messages.append(tool_results_message(results))

    raise SystemExit("도구 호출 반복 상한 초과 (모델이 계속 도구만 호출)")


async def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else "거래처 3개만 이름 보여줘"

    await step1_check_dataverse_connectivity()

    provider = OllamaProvider(model=TEST_MODEL, endpoint=TEST_OLLAMA_BASE_URL)
    try:
        await step2_check_ollama_health(provider)
        await step3_end_to_end(provider, question)
    finally:
        await provider.aclose()

    print("\n모든 단계 통과 — Ollama + 실제 CRM(Dataverse) 데이터 연동 확인됨.")


if __name__ == "__main__":
    asyncio.run(main())
