"""Pydantic AI 事件 → ndjson 字节的纯映射函数。

Phase 1 覆盖：
- PartDeltaEvent + TextPartDelta → chunk（任务 2）
- PartDeltaEvent + ThinkingPartDelta → thinking_chunk（任务 3）
- AgentRunResultEvent → usage + final_content（任务 4）

Phase 2 增量：
- FunctionToolCallEvent + tavily_search/web_search → tool_calls（任务 2）
- FunctionToolResultEvent → sources + tool_done（任务 3，待跟进）

`done` 事件由端点层在 commit DB 后 yield，因为需要 user_row / assistant_row
等业务行，不属 mapper 责任范围。

`tool_searching` 事件由端点层紧接 FunctionToolCallEvent 之后手动 yield（mapper
每次只产一条 ndjson 行，不产 tool_searching）。
"""
from __future__ import annotations

from typing import Any

from pydantic_ai import AgentRunResultEvent
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPart,
)

from app.services.ai.search import build_search_source_cards
from app.services.ai.stream_utils import (
    build_stream_chunk,
    build_stream_sources,
    build_stream_thinking_chunk,
    build_stream_tool_calls,
    build_stream_tool_done,
    build_stream_usage,
)


class MapperState(dict):
    """事件流运行期状态。继承 dict 兼容字段访问。"""


# Phase 2：mapper 识别的 search 类工具名集合。
# `tavily_search` 是 Pydantic AI 自带 `tavily_search_tool` 的工具名；
# `web_search` 是旧端点的工具别名（向后兼容）。
_SEARCH_TOOL_NAMES = frozenset({"tavily_search", "web_search"})


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


def _tool_part_to_dict(part: ToolCallPart) -> dict:
    """把 Pydantic AI ToolCallPart 拍平为 dict（与 stream_utils 期望的 shape 一致）。"""
    return {
        "tool_name": part.tool_name,
        "args": part.args,
        "tool_call_id": getattr(part, "tool_call_id", None),
    }


def _normalize_tool_content(content: Any) -> list[dict]:
    """把 Tavily tool 返回的 content 标准化为 list[dict]。

    Phase 2 spike 揭示 SearXNG adapter 走 Pydantic AI 自带 `tavily_search_tool` 时
    返回 list[TavilySearchResult]（每项含 title/url/content/score/raw_content）。
    但允许以下两种格式以便未来扩展：
    - list[dict]（标准）
    - dict 含 'results' 键（adapter 直返回）
    """
    if isinstance(content, list):
        return [dict(r) for r in content]
    if isinstance(content, dict):
        return list(content.get("results") or [])
    return []


def _handle_tool_result(event: FunctionToolResultEvent, state: MapperState) -> bytes | None:
    """tool_result → sources + tool_done。

    关键设计：只有当 last_tool_part 是 search 类工具时才处理（避免被其他工具污染）。
    一次性 yield sources + tool_done 两行 ndjson。
    """
    last_tool = state.get("last_tool_part") or {}
    if last_tool.get("tool_name") not in _SEARCH_TOOL_NAMES:
        return None

    part = event.part
    content = getattr(part, "content", part)
    results = _normalize_tool_content(content)
    cards = build_search_source_cards({"results": results})
    state["search_source_cards"] = cards
    sources = build_stream_sources(
        cards,
        time_range=state.get("search_time_range"),
        query=state.get("last_search_query"),
    )
    return sources + build_stream_tool_done()


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
    if isinstance(event, FunctionToolCallEvent):
        if event.part.tool_name in _SEARCH_TOOL_NAMES:
            state["last_tool_part"] = _tool_part_to_dict(event.part)
            return build_stream_tool_calls([state["last_tool_part"]])
        return None
    if isinstance(event, FunctionToolResultEvent):
        return _handle_tool_result(event, state)
    if isinstance(event, AgentRunResultEvent):
        usage_dict = _build_usage_dict(event.result.usage)
        state["final_usage"] = usage_dict
        state["final_content"] = "".join(state.get("assistant_parts", [])).strip()
        return build_stream_usage(usage_dict)
    return None