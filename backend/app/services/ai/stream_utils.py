"""
AI Chat Stream Utilities — SSE 流式事件编码逻辑。

从 endpoints/ai_chat.py 迁移（阶段 8.3）。
"""
from __future__ import annotations

import json
from typing import Any

from app.services.ai import AIMessage, parse_search_sources
from app.schemas.ai_chat import MessageItem


def serialize_message(row: AIMessage) -> dict[str, object]:
    return {
        "id": row.id,
        "conversation_id": row.conversation_id,
        "role": row.role,
        "content": row.content,
        "search_sources": parse_search_sources(row.search_sources),
        # [BEL-81.B] 历史消息回放时，前端按此字段渲染时间范围 chip
        "search_time_range": row.search_time_range,
        "is_complete": row.is_complete,
        "prompt_tokens": row.prompt_tokens,
        "completion_tokens": row.completion_tokens,
        "total_tokens": row.total_tokens,
        "duration_ms": row.duration_ms,
        "created_at": row.created_at.isoformat(),
    }


def encode_stream_event(payload: dict[str, object]) -> bytes:
    """将字典编码为 SSE 事件字节。"""
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


def build_stream_error(message: str) -> bytes:
    """构建错误事件。"""
    return encode_stream_event({"type": "error", "message": message})


def build_stream_start() -> bytes:
    return encode_stream_event({"type": "start"})


def build_stream_chunk(delta: str) -> bytes:
    return encode_stream_event({"type": "chunk", "delta": delta})


def build_stream_thinking_chunk(delta: str) -> bytes:
    return encode_stream_event({"type": "thinking_chunk", "delta": delta})


def build_stream_tool_calls(tool_calls: list[dict]) -> bytes:
    return encode_stream_event({"type": "tool_calls", "tool_calls": tool_calls})


def build_stream_tool_searching() -> bytes:
    return encode_stream_event({"type": "tool_searching"})


def build_stream_tool_done() -> bytes:
    return encode_stream_event({"type": "tool_done"})


def build_stream_sources(
    sources: list[dict],
    time_range: str | None = None,
    query: str | None = None,
) -> bytes:
    """构建 sources 事件。

    [BEL-81.B] sources 事件额外携带 `time_range`（day|week|month|year）
    与 `query`（tool 调用时的实际查询词），供前端在搜索结果卡片上方
    渲染时间范围 chip。`time_range` 缺省时字段不写入事件体，保持对旧
    客户端的兼容。
    """
    payload: dict[str, Any] = {"type": "sources", "sources": sources}
    if time_range:
        payload["time_range"] = time_range
    if query:
        payload["query"] = query
    return encode_stream_event(payload)


def build_stream_usage(usage: dict) -> bytes:
    return encode_stream_event({"type": "usage", "usage": usage})


def build_stream_done(
    user_message: dict,
    assistant_message: dict,
    conversation_title: str | None,
    token_usage: dict | None,
    conversation_token_usage: dict,
    duration_ms: int,
    title_regenerated: bool,
) -> bytes:
    payload: dict[str, Any] = {
        "type": "done",
        "user_message": user_message,
        "assistant_message": assistant_message,
        "conversation_title": conversation_title,
        "token_usage": token_usage,
        "conversation_token_usage": conversation_token_usage,
        "duration_ms": duration_ms,
        "title_regenerated": title_regenerated,
    }
    return encode_stream_event(payload)