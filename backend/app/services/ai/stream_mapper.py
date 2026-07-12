"""Pydantic AI 事件 → ndjson 字节的纯映射函数。

Phase 1 仅覆盖 PartDeltaEvent（text）分支；
thinking / usage 分支在任务 3/4 追加。
tool_calls / tool_result 分支推迟 Phase 2。
"""
from __future__ import annotations

from typing import Any

from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_utils import build_stream_chunk


class MapperState(dict):
    """事件流运行期状态。继承 dict 兼容字段访问。"""


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    """Pydantic AI 事件 → ndjson 字节。返回 None 表示不产数据。"""
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
    return None