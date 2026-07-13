"""Pydantic AI 事件 → ndjson 字节的纯映射函数。

Phase 1 覆盖：
- PartDeltaEvent + TextPartDelta → chunk（任务 2）
- PartDeltaEvent + ThinkingPartDelta → thinking_chunk（任务 3）
- AgentRunResultEvent → usage + final_content（任务 4）

tool_calls / tool_result 分支推迟 Phase 2。

`done` 事件由端点层在 commit DB 后 yield，因为需要 user_row / assistant_row
等业务行，不属 mapper 责任范围。
"""
from __future__ import annotations

from typing import Any

from pydantic_ai import AgentRunResultEvent
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta, ThinkingPartDelta

from app.services.ai.stream_utils import (
    build_stream_chunk,
    build_stream_thinking_chunk,
    build_stream_usage,
)


class MapperState(dict):
    """事件流运行期状态。继承 dict 兼容字段访问。"""


def _build_usage_dict(usage: Any) -> dict | None:
    """把 Pydantic AI RunUsage 对象拍平为 dict；usage=None 时返回 None。

    `event.result.usage` 是**属性**（Pydantic AI 已知陷阱），不是方法。
    """
    if usage is None:
        return None
    return {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0),
        "completion_tokens": getattr(usage, "completion_tokens", 0),
        "total_tokens": getattr(usage, "total_tokens", 0),
    }


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    """Pydantic AI 事件 → ndjson 字节。返回 None 表示不产数据。"""
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
            return build_stream_thinking_chunk(delta.content_delta)
        return None
    if isinstance(event, AgentRunResultEvent):
        usage_dict = _build_usage_dict(event.result.usage)
        state["final_usage"] = usage_dict
        state["final_content"] = "".join(state.get("assistant_parts", [])).strip()
        return build_stream_usage(usage_dict)
    return None