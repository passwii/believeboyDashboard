"""Stream Mapper 单测。

Phase 1 任务 2/3/4 共用本文件，按 mapper 能力分块追加：
- text delta → chunk（任务 2）
- thinking delta → thinking_chunk（任务 3）
- AgentRunResultEvent → usage + final_content（任务 4）

Mapper 是纯函数（Pydantic AI 事件 → ndjson 字节），不依赖网络/DB。
"""
from __future__ import annotations

import json

from pydantic_ai.messages import PartDeltaEvent, TextPartDelta, ThinkingPartDelta

from app.services.ai.stream_mapper import MapperState, map_agent_event


def _parse_chunk(out: bytes) -> dict:
    """把 mapper 产出的单行 ndjson 解析回 dict。"""
    assert out is not None
    return json.loads(out.decode("utf-8").rstrip("\n"))


def test_text_delta_yields_chunk_bytes():
    """text delta 应产出 ndjson `chunk` 事件，delta 字段与输入一致。"""
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="hi"))
    out = map_agent_event(event, state)
    assert _parse_chunk(out) == {"type": "chunk", "delta": "hi"}
    assert state["assistant_parts"] == ["hi"]


def test_text_delta_skips_empty_delta():
    """空 content_delta 不应产出 chunk 字节，也不污染 assistant_parts。"""
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=""))
    assert map_agent_event(event, state) is None
    assert state.get("assistant_parts", []) == []


def test_thinking_delta_yields_thinking_chunk_bytes():
    """thinking delta 应产出 `thinking_chunk` 事件，不写入 assistant_parts。"""
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="hmm"))
    out = map_agent_event(event, state)
    assert _parse_chunk(out) == {"type": "thinking_chunk", "delta": "hmm"}
    assert "assistant_parts" not in state


def test_thinking_delta_skips_empty_delta():
    """空 thinking delta 不应产出字节，也不污染 state。"""
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta=""))
    assert map_agent_event(event, state) is None
    assert state == {}