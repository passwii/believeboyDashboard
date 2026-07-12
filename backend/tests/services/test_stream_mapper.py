"""Stream Mapper 单测。

Phase 1 任务 2/3/4 共用本文件，按 mapper 能力分块追加：
- text delta → chunk（任务 2）
- thinking delta → thinking_chunk（任务 3）
- AgentRunResultEvent → usage + final_content（任务 4）

Mapper 是纯函数（Pydantic AI 事件 → ndjson 字节），不依赖网络/DB。
"""
from __future__ import annotations

from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_mapper import MapperState, map_agent_event


def test_text_delta_yields_chunk_bytes():
    """text delta 应产出 ndjson `chunk` 事件，delta 字段与输入一致。"""
    import json

    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="hi"))
    out = map_agent_event(event, state)
    assert out is not None
    line = out.decode("utf-8").rstrip("\n")
    payload = json.loads(line)
    assert payload == {"type": "chunk", "delta": "hi"}
    assert state["assistant_parts"] == ["hi"]


def test_text_delta_skips_empty_delta():
    """空 content_delta 不应产出 chunk 字节，也不污染 assistant_parts。"""
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=""))
    assert map_agent_event(event, state) is None
    assert state.get("assistant_parts", []) == []