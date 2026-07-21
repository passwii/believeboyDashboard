"""extract_search_meta_from_messages 单测(Phase 1.2 — V2 runner 业务载荷抽取)。"""
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
)

from app.services.ai.search import (
    SEARCH_TOOL_NAMES,
    extract_search_meta_from_messages,
    normalize_tool_content,
)


def test_search_tool_names():
    assert "tavily_search" in SEARCH_TOOL_NAMES
    assert "web_search" in SEARCH_TOOL_NAMES


def test_normalize_tool_content_list():
    assert normalize_tool_content([{"b": 2}]) == [{"b": 2}]


def test_normalize_tool_content_dict_with_results():
    assert normalize_tool_content({"results": [{"a": 1}]}) == [{"a": 1}]


def test_normalize_tool_content_plain_string():
    assert normalize_tool_content("plain string") == []


def test_no_search_returns_none():
    cards, time_range, query = extract_search_meta_from_messages([])
    assert cards is None
    assert time_range is None
    assert query is None


def test_extract_cards_from_tavily_result():
    messages = [
        ModelResponse(parts=[ToolCallPart(
            tool_name="tavily_search",
            args={"query": "上海天气", "time_range": "week"},
            tool_call_id="tc1",
        )]),
        ModelRequest(parts=[ToolReturnPart(
            tool_name="tavily_search",
            content=[{"title": "天气", "url": "https://x.com", "content": "晴", "score": 0.9}],
            tool_call_id="tc1",
        )]),
    ]
    cards, time_range, query = extract_search_meta_from_messages(messages)
    assert query == "上海天气"
    assert time_range == "week"
    assert cards is not None
    assert len(cards) == 1
    assert cards[0]["url"] == "https://x.com"
    assert cards[0]["title"] == "天气"


def test_non_search_tool_ignored():
    messages = [
        ModelResponse(parts=[ToolCallPart(tool_name="calculator", args={"q": "1+1"}, tool_call_id="tc2")]),
        ModelRequest(parts=[ToolReturnPart(tool_name="calculator", content="2", tool_call_id="tc2")]),
    ]
    cards, time_range, query = extract_search_meta_from_messages(messages)
    assert cards is None
    assert query is None
    assert time_range is None


def test_web_search_alias_recognized():
    messages = [
        ModelResponse(parts=[ToolCallPart(tool_name="web_search", args={"query": "新闻"}, tool_call_id="tc3")]),
        ModelRequest(parts=[ToolReturnPart(
            tool_name="web_search",
            content={"results": [{"title": "N", "url": "https://n.com", "content": "c"}]},
            tool_call_id="tc3",
        )]),
    ]
    cards, _time_range, query = extract_search_meta_from_messages(messages)
    assert query == "新闻"
    assert cards is not None and cards[0]["url"] == "https://n.com"
