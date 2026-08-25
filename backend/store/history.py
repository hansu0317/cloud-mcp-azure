"""공급자 중립 LLM 대화 히스토리 변환·정리.

프로젝트 파일에는 Anthropic/Ollama 고유 메시지 대신 아래 canonical 블록만
저장한다.

* ``text``: 사용자/어시스턴트 텍스트
* ``tool_call``: 어시스턴트의 도구 호출
* ``tool_result``: 서버가 실행한 도구 결과

기존 프로젝트에 남아 있는 Anthropic Messages 형식과 OpenAI/Ollama 형식은
읽을 때 메모리에서 변환한다. 다음 채팅이 성공적으로 저장될 때 프로젝트 파일도
canonical 형식으로 자연스럽게 교체된다.
"""
from __future__ import annotations

import json
from typing import Any


Message = dict[str, Any]

DESCRIBE_PLACEHOLDER = (
    "(스키마 조회 결과 생략 — 필요하면 dataverse_describe_table을 다시 호출하세요)"
)


def _object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _string(value: Any) -> str:
    """JavaScript ``String(value ?? '')``에 가까운 안전한 문자열 변환."""
    return "" if value is None else str(value)


def _text_content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            block = _object(item)
            if block.get("type") == "text":
                parts.append(_string(block.get("text")))
        return "".join(parts)
    return ""


def _is_canonical_message(value: Any) -> bool:
    message = _object(value)
    if message.get("role") not in ("user", "assistant"):
        return False
    content = message.get("content")
    if not isinstance(content, list):
        return False

    for raw in content:
        block = _object(raw)
        block_type = block.get("type")
        if block_type == "text":
            if not isinstance(block.get("text"), str):
                return False
        elif block_type == "tool_call":
            if not isinstance(block.get("id"), str) or not isinstance(block.get("name"), str):
                return False
        elif block_type == "tool_result":
            if not isinstance(block.get("toolCallId"), str) or not isinstance(block.get("name"), str):
                return False
        else:
            return False
    return True


def normalize_history(raw_history: Any) -> list[Message]:
    """기존 Anthropic/OpenAI(Ollama) 기록을 canonical 메시지로 읽는다."""
    if not isinstance(raw_history, list):
        return []
    if all(_is_canonical_message(message) for message in raw_history):
        return raw_history

    result: list[Message] = []
    tool_names: dict[str, str] = {}
    pending_tool_results: list[dict[str, Any]] = []

    def flush_tool_results() -> None:
        nonlocal pending_tool_results
        if pending_tool_results:
            result.append({"role": "user", "content": pending_tool_results})
            pending_tool_results = []

    for raw in raw_history:
        message = _object(raw)
        role = _string(message.get("role"))

        if role == "assistant":
            flush_tool_results()
            blocks: list[dict[str, Any]] = []
            content = message.get("content")
            if isinstance(content, list):
                for item in content:
                    block = _object(item)
                    if block.get("type") == "text":
                        text = _string(block.get("text"))
                        if text:
                            blocks.append({"type": "text", "text": text})
                    elif block.get("type") == "tool_use":
                        tool_id = _string(block.get("id"))
                        name = _string(block.get("name"))
                        if tool_id and name:
                            tool_names[tool_id] = name
                            blocks.append({
                                "type": "tool_call",
                                "id": tool_id,
                                "name": name,
                                "input": _object(block.get("input")),
                            })
            else:
                text = _text_content(content)
                if text:
                    blocks.append({"type": "text", "text": text})

            raw_calls = message.get("tool_calls")
            if isinstance(raw_calls, list):
                for raw_call in raw_calls:
                    call = _object(raw_call)
                    function = _object(call.get("function"))
                    tool_id = _string(call.get("id"))
                    name = _string(function.get("name"))
                    arguments = function.get("arguments")
                    tool_input: dict[str, Any] = {}
                    try:
                        parsed = json.loads(arguments) if isinstance(arguments, str) else arguments
                        tool_input = _object(parsed)
                    except (json.JSONDecodeError, TypeError):
                        pass
                    if tool_id and name:
                        tool_names[tool_id] = name
                        blocks.append({
                            "type": "tool_call",
                            "id": tool_id,
                            "name": name,
                            "input": tool_input,
                        })

            if blocks:
                result.append({"role": "assistant", "content": blocks})
            continue

        if role == "tool":
            tool_call_id = _string(message.get("tool_call_id"))
            if tool_call_id:
                pending_tool_results.append({
                    "type": "tool_result",
                    "toolCallId": tool_call_id,
                    "name": tool_names.get(tool_call_id, ""),
                    "content": _text_content(message.get("content")),
                })
            continue

        if role == "user":
            flush_tool_results()
            content = message.get("content")
            if isinstance(content, list):
                tool_results: list[dict[str, Any]] = []
                texts: list[str] = []
                for item in content:
                    block = _object(item)
                    if block.get("type") == "tool_result":
                        tool_call_id = _string(
                            block.get("tool_use_id") or block.get("toolCallId")
                        )
                        if tool_call_id:
                            raw_error = block.get("is_error")
                            if raw_error is None:
                                raw_error = block.get("isError")
                            tool_results.append({
                                "type": "tool_result",
                                "toolCallId": tool_call_id,
                                "name": _string(
                                    block.get("name") or tool_names.get(tool_call_id, "")
                                ),
                                "content": _text_content(block.get("content")),
                                "isError": bool(raw_error),
                            })
                    elif block.get("type") == "text":
                        texts.append(_string(block.get("text")))
                if tool_results:
                    result.append({"role": "user", "content": tool_results})
                if any(texts):
                    result.append({
                        "role": "user",
                        "content": [{"type": "text", "text": "".join(texts)}],
                    })
            else:
                text = _text_content(content)
                if text:
                    result.append({
                        "role": "user",
                        "content": [{"type": "text", "text": text}],
                    })

    flush_tool_results()
    return result


def _is_user_text_message(message: Any) -> bool:
    value = _object(message)
    content = value.get("content")
    return (
        value.get("role") == "user"
        and isinstance(content, list)
        and any(_object(block).get("type") == "text" for block in content)
    )


def trim_history(messages: list[Message], max_messages: int = 20) -> list[Message]:
    """도구 호출/결과 쌍을 자르지 않고 실제 사용자 질문 경계에서만 줄인다."""
    if len(messages) <= max_messages:
        return messages

    start = max(0, len(messages) - max_messages)
    for index in range(start, len(messages)):
        if _is_user_text_message(messages[index]):
            return messages[index:]

    # 한 도구 루프가 max_messages보다 길면 마지막 실제 질문까지 더 거슬러 올라간다.
    for index in range(start - 1, -1, -1):
        if _is_user_text_message(messages[index]):
            return messages[index:]

    # 질문 경계가 전혀 없는 비정상 기록은 임의로 잘라 더 손상시키지 않는다.
    return messages


def compact_describe_results(messages: list[Message]) -> int:
    """describe 원문을 재호출 가능한 placeholder로 바꿔 다음 턴 입력을 줄인다."""
    describe_ids: set[str] = set()
    for raw_message in messages:
        message = _object(raw_message)
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for raw_block in content:
            block = _object(raw_block)
            if block.get("type") == "tool_call" and block.get("name") == "dataverse_describe_table":
                tool_id = block.get("id")
                if isinstance(tool_id, str):
                    describe_ids.add(tool_id)

    count = 0
    for raw_message in messages:
        message = _object(raw_message)
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for raw_block in content:
            block = _object(raw_block)
            if (
                block.get("type") == "tool_result"
                and block.get("toolCallId") in describe_ids
                and block.get("content") != DESCRIBE_PLACEHOLDER
            ):
                block["content"] = DESCRIBE_PLACEHOLDER
                count += 1
    return count
