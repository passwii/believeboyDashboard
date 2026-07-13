"""Stream Mapper 单测。

Phase 1 任务 2/3/4 共用本文件，按 mapper 能力分块追加：
- text delta → chunk（任务 2）
- thinking delta → thinking_chunk（任务 3）
- AgentRunResultEvent → usage + final_content（任务 4）

Mapper 是纯函数（Pydantic AI 事件 → ndjson 字节），不依赖网络/DB。
"""
from __future__ import annotations

import json

from pydantic_ai import AgentRunResultEvent
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


class _FakeUsage:
    """模仿 Pydantic AI RunUsage 的接口（属性而非方法）。"""

    prompt_tokens = 1
    completion_tokens = 2
    total_tokens = 3


class _FakeResult:
    def __init__(self, usage=_FakeUsage(), output="hi"):
        self.usage = usage
        self.output = output


def test_agent_run_result_yields_usage_bytes_and_updates_state():
    """AgentRunResult 应产出 `usage` 事件 + 更新 final_usage + final_content。"""
    state: MapperState = {"assistant_parts": ["hi"]}
    event = AgentRunResultEvent(result=_FakeResult())
    out = map_agent_event(event, state)
    payload = _parse_chunk(out)
    assert payload["type"] == "usage"
    assert payload["usage"] == {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
    assert state["final_usage"] == {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
    assert state["final_content"] == "hi"


def test_agent_run_result_handles_missing_usage():
    """usage=None 时 state.final_usage 落 None，事件仍产出（usage:null）。"""
    state: MapperState = {}
    event = AgentRunResultEvent(result=_FakeResult(usage=None, output=""))
    out = map_agent_event(event, state)
    payload = _parse_chunk(out)
    assert payload["type"] == "usage"
    assert payload["usage"] is None
    assert state["final_usage"] is None


def test_agent_run_result_assembles_final_content_from_parts():
    """final_content 由 assistant_parts 拼接而成（中文多 parts 场景）。"""
    state: MapperState = {"assistant_parts": ["你", "好"]}
    event = AgentRunResultEvent(result=_FakeResult(output="ignored"))
    map_agent_event(event, state)
    assert state["final_content"] == "你好"


def test_agent_run_result_with_no_text_parts_yields_empty_final_content():
    """没有 assistant_parts 时 final_content 为空串（端点层据此更新 DB）。"""
    state: MapperState = {}
    event = AgentRunResultEvent(result=_FakeResult(output="ignored"))
    map_agent_event(event, state)
    assert state["final_content"] == ""