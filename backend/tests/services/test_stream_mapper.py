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


# ─── Phase 2 任务 2：FunctionToolCallEvent → tool_calls ─────────────────────


def _tool_call_event(name: str = "tavily_search", args: dict | None = None, call_id: str = "c1") -> "FunctionToolCallEvent":
    from pydantic_ai.messages import FunctionToolCallEvent, ToolCallPart

    return FunctionToolCallEvent(
        part=ToolCallPart(tool_name=name, args=args or {"query": "x"}, tool_call_id=call_id)
    )


def _parse_first_event(out: bytes) -> dict:
    """从 ndjson 字节解出第一条事件 dict（容忍 JSON 空格格式）。"""
    assert out is not None
    assert out.count(b"\n") == 1, f"mapper 应只产一条 ndjson 行，实际: {out!r}"
    line = out.rstrip(b"\n").decode("utf-8")
    return json.loads(line)


def test_function_tool_call_yields_tool_calls_bytes():
    """[Phase 2] `tavily_search` 工具调用 → build_stream_tool_calls 单条 ndjson。"""
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(), state)
    evt = _parse_first_event(out)
    assert evt["type"] == "tool_calls"
    assert len(evt["tool_calls"]) == 1
    assert evt["tool_calls"][0]["tool_name"] == "tavily_search"
    assert evt["tool_calls"][0]["args"] == {"query": "x"}
    assert state["last_tool_part"]["tool_name"] == "tavily_search"
    assert state["last_tool_part"]["args"] == {"query": "x"}


def test_function_tool_call_ignores_non_search_tools():
    """[Phase 2] 非 search 类工具调用被忽略（不污染 state、不产 bytes）。"""
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(name="other_tool"), state)
    assert out is None
    assert "last_tool_part" not in state


def test_function_tool_call_legacy_web_search_alias():
    """[Phase 2] 兼容 'web_search' 别名（旧端点工具名）。"""
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(name="web_search"), state)
    evt = _parse_first_event(out)
    assert evt["type"] == "tool_calls"
    assert evt["tool_calls"][0]["tool_name"] == "web_search"
    assert state["last_tool_part"]["tool_name"] == "web_search"


# ─── Phase 2 任务 3：FunctionToolResultEvent → sources + tool_done ──────────


def _tool_result_event(content, call_id: str = "c1", tool_name: str = "tavily_search") -> "FunctionToolResultEvent":
    from pydantic_ai.messages import FunctionToolResultEvent, ToolReturnPart

    # 注：FunctionToolResultEvent 的 tool_call_id 来自 part，不在 __init__ 参数里
    return FunctionToolResultEvent(
        part=ToolReturnPart(tool_name=tool_name, content=content, tool_call_id=call_id),
    )


def test_tool_result_yields_sources_and_tool_done_bytes():
    """[Phase 2] tavily_search 工具结果 list[dict] → sources + tool_done 两条 ndjson。"""
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": "day",
        "last_search_query": "今天北京天气",
    }
    content = [
        {
            "title": "北京天气预报",
            "url": "https://x.com",
            "content": "晴",
            "score": 0.9,
        }
    ]
    out = map_agent_event(_tool_result_event(content), state)
    assert out is not None
    # mapper 在 sources + tool_done 之间一次性 yield 两行 ndjson
    assert out.count(b"\n") == 2
    lines = [json.loads(line) for line in out.decode("utf-8").strip().split("\n")]
    assert [e["type"] for e in lines] == ["sources", "tool_done"]
    sources_evt = lines[0]
    assert sources_evt["time_range"] == "day"
    assert sources_evt["query"] == "今天北京天气"
    assert sources_evt["sources"][0]["title"] == "北京天气预报"
    assert sources_evt["sources"][0]["url"] == "https://x.com"
    assert state["search_source_cards"][0]["title"] == "北京天气预报"


def test_tool_result_skips_when_last_tool_not_search():
    """[Phase 2] last_tool_part 不是 search 类工具 → 忽略 tool_result，不产 bytes。"""
    state: MapperState = {"last_tool_part": {"tool_name": "other_tool"}}
    out = map_agent_event(_tool_result_event([]), state)
    assert out is None
    assert "search_source_cards" not in state


def test_tool_result_handles_dict_content_with_results_key():
    """[Phase 2] content 是 dict 且含 'results' 键时，按 dict 路径解析。"""
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": None,
        "last_search_query": None,
    }
    content = {"results": [{"title": "T", "url": "u", "content": "c", "score": 0.5}]}
    out = map_agent_event(_tool_result_event(content), state)
    assert out is not None
    lines = [json.loads(line) for line in out.decode("utf-8").strip().split("\n")]
    assert [e["type"] for e in lines] == ["sources", "tool_done"]
    assert lines[0]["sources"][0]["title"] == "T"
    assert state["search_source_cards"][0]["title"] == "T"


def test_tool_result_empty_results_still_yields_tool_done():
    """[Phase 2] 空 results 也产 tool_done（前端需要这个 marker 关闭 loading）。"""
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": None,
        "last_search_query": None,
    }
    out = map_agent_event(_tool_result_event([]), state)
    assert out is not None
    lines = [json.loads(line) for line in out.decode("utf-8").strip().split("\n")]
    assert [e["type"] for e in lines] == ["sources", "tool_done"]
    assert lines[0]["sources"] == []