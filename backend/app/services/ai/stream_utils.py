"""AI Chat Stream Utilities — 消息行序列化。

V2 切换后仅保留 `serialize_message`（endpoint CRUD 与 V2 `done` 事件复用）。
旧 ndjson 事件 builder（build_stream_* / encode_stream_event）随 V1 流式路径删除。
"""
from __future__ import annotations

from app.services.ai import AIMessage, parse_search_sources


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
