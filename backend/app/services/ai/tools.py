from __future__ import annotations

import json
import threading
from typing import Any, Optional

import httpx

from app.core.config import Settings
from app.schemas.ai_chat import LLMConfigInput

from app.services.ai.chat import trim_trailing_slash


def _cancelled(cancel_event: Optional[threading.Event]) -> bool:
    return cancel_event is not None and cancel_event.is_set()


WEB_SEARCH_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "当需要获取最新信息、实时数据、新闻或不确定的事实时，使用此工具搜索互联网。适用于：查询最新新闻、了解实时数据、验证最新信息、获取当前日期的事件等场景。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，用中文描述你想查询的信息。应该是简洁的核心查询词，而非完整的问题。",
                },
                "time_range": {
                    "type": "string",
                    "description": "搜索结果的时间范围",
                    "enum": ["day", "week", "month", "year"],
                    "default": "month",
                },
            },
            "required": ["query"],
        },
    },
}


def merge_stream_tool_calls(
    existing_calls: list[dict[str, Any]], delta_calls: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    merged = [dict(item) for item in existing_calls]

    for delta in delta_calls:
        if not isinstance(delta, dict):
            continue

        index_value = delta.get("index")
        if not isinstance(index_value, int) or index_value < 0:
            index_value = len(merged)

        while len(merged) <= index_value:
            merged.append({"id": "", "type": "function", "function": {}})

        current = merged[index_value]
        if not isinstance(current, dict):
            current = {"id": "", "type": "function", "function": {}}
            merged[index_value] = current

        tool_id = delta.get("id")
        if isinstance(tool_id, str) and tool_id:
            current["id"] = tool_id

        tool_type = delta.get("type")
        if isinstance(tool_type, str) and tool_type:
            current["type"] = tool_type

        function_delta = delta.get("function")
        current_function = current.get("function")
        if not isinstance(current_function, dict):
            current_function = {}
            current["function"] = current_function

        if isinstance(function_delta, dict):
            function_name = function_delta.get("name")
            if isinstance(function_name, str) and function_name:
                current_function["name"] = (
                    f"{current_function.get('name', '')}{function_name}"
                )

            function_arguments = function_delta.get("arguments")
            if isinstance(function_arguments, str) and function_arguments:
                current_function["arguments"] = (
                    f"{current_function.get('arguments', '')}{function_arguments}"
                )

    return merged


def parse_tool_calls(data: dict[str, Any]) -> list[dict[str, Any]]:
    from app.services.ai.llm import get_first_choice

    message = get_first_choice(data).get("message", {})
    tool_calls = message.get("tool_calls", [])
    if not tool_calls:
        return []
    return tool_calls if isinstance(tool_calls, list) else []


def extract_tool_call_id(tool_call: dict[str, Any]) -> str:
    return tool_call.get("id", "")


def extract_tool_function_name(tool_call: dict[str, Any]) -> str:
    function = tool_call.get("function", {})
    return function.get("name", "") if isinstance(function, dict) else ""


def extract_tool_function_arguments(tool_call: dict[str, Any]) -> dict[str, Any]:
    function = tool_call.get("function", {})
    if not isinstance(function, dict):
        return {}
    args_str = function.get("arguments", "{}")
    try:
        return json.loads(args_str) if isinstance(args_str, str) else args_str
    except json.JSONDecodeError:
        return {}


def execute_tool_call(
    tool_name: str, arguments: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    from app.services.ai.search import execute_web_search

    if tool_name == "web_search":
        query = arguments.get("query", "")
        time_range = arguments.get("time_range", "month")
        return execute_web_search(query, time_range, settings)
    else:
        return {"error": f"Unknown tool: {tool_name}"}


def stream_with_tool_calling(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    settings: Settings,
    temperature: float = 0.7,
    max_tool_calls: int = 3,
    cancel_event: Optional[threading.Event] = None,
):
    from app.services.ai.llm import get_first_choice
    from app.services.ai.search import (
        build_search_source_cards,
        execute_web_search,
        format_web_search_context,
    )

    tools = [WEB_SEARCH_TOOL_SCHEMA]
    all_messages = list(messages)
    search_source_cards: list[dict[str, Any]] = []
    tool_call_count = 0

    while tool_call_count < max_tool_calls:
        if _cancelled(cancel_event):
            return

        payload = {
            "model": llm_config.model,
            "messages": all_messages,
            "temperature": temperature,
            "stream": True,
            "tools": tools,
        }
        if llm_config.reasoning_effort:
            payload["reasoning"] = {"effort": llm_config.reasoning_effort}

        endpoint = f"{llm_config.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {llm_config.api_key}",
            "Content-Type": "application/json",
        }

        content_buffer = ""
        current_tool_calls: list[dict[str, Any]] = []

        try:
            with httpx.Client(timeout=llm_config.timeout_seconds) as client:
                with client.stream(
                    "POST", endpoint, json=payload, headers=headers
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if _cancelled(cancel_event):
                            return
                        if not line:
                            continue
                        text = (
                            line
                            if isinstance(line, str)
                            else line.decode("utf-8", errors="ignore")
                        )
                        if not text.startswith("data:"):
                            continue
                        payload_text = text[5:].strip()
                        if not payload_text or payload_text == "[DONE]":
                            if payload_text == "[DONE]":
                                break
                            continue
                        try:
                            data = json.loads(payload_text)
                        except json.JSONDecodeError:
                            continue

                        choice = get_first_choice(data)
                        delta = choice.get("delta", {})
                        if not isinstance(delta, dict):
                            delta = {}

                        chunk = delta.get("content", "")
                        if chunk:
                            content_buffer += chunk
                            yield {"type": "chunk", "delta": chunk}

                        usage = data.get("usage")
                        if usage:
                            yield {"type": "usage", "usage": usage}

                        tool_calls = delta.get("tool_calls", [])
                        if tool_calls:
                            current_tool_calls = merge_stream_tool_calls(
                                current_tool_calls, tool_calls
                            )

                        finish_reason = choice.get("finish_reason", "")

                        if finish_reason == "tool_calls" or (
                            finish_reason and not content_buffer
                        ):
                            break
        except httpx.HTTPStatusError as exc:
            yield {
                "type": "error",
                "message": f"LLM request failed ({exc.response.status_code})",
            }
            return
        except httpx.HTTPError as exc:
            yield {"type": "error", "message": f"LLM request failed: {exc}"}
            return

        if not current_tool_calls:
            break

        tool_call_count += 1
        yield {"type": "tool_calls", "tool_calls": current_tool_calls}

        for tool_call in current_tool_calls:
            tool_name = extract_tool_function_name(tool_call)
            tool_args = extract_tool_function_arguments(tool_call)
            tool_id = extract_tool_call_id(tool_call)

            if tool_name == "web_search":
                yield {
                    "type": "tool_searching",
                    "tool_name": "web_search",
                    "query": tool_args.get("query", ""),
                }

                search_result = execute_web_search(
                    tool_args.get("query", ""),
                    tool_args.get("time_range", "month"),
                    settings,
                )

                yield {
                    "type": "tool_done",
                    "tool_name": "web_search",
                    "success": "error" not in search_result,
                }

                if "error" not in search_result:
                    search_source_cards = build_search_source_cards(
                        search_result, settings.ai_chat_web_search_max_results
                    )
                    if search_source_cards:
                        yield {"type": "sources", "sources": search_source_cards}
                    search_context = format_web_search_context(
                        search_result, tool_args.get("query", "")
                    )
                    tool_result_message = {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": search_context,
                    }
                else:
                    tool_result_message = {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": f"搜索失败: {search_result.get('error')}",
                    }
            else:
                tool_result_message = {
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": f"未知工具: {tool_name}",
                }

            all_messages.append({"role": "assistant", "tool_calls": [tool_call]})
            all_messages.append(tool_result_message)
