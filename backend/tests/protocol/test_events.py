"""协议层事件 + 错误码单测。"""
import pytest
from pydantic import ValidationError

from app.services.ai.protocol.errors import ErrorCode, ProtocolError


def test_error_code_values():
    """ErrorCode 枚举值与 spec §10.1 一致。"""
    assert ErrorCode.CANCELLED == "cancelled"
    assert ErrorCode.TIMEOUT == "timeout"
    assert ErrorCode.LLM_5XX == "llm_5xx"
    assert ErrorCode.LLM_4XX == "llm_4xx"
    assert ErrorCode.RATE_LIMIT == "rate_limit"
    assert ErrorCode.CONTENT_FILTER == "content_filter"
    assert ErrorCode.VALIDATION == "validation"
    assert ErrorCode.INTERNAL == "internal"
    assert ErrorCode.PERSISTENCE == "persistence"
    assert ErrorCode.TOOL_ERROR == "tool_error"
    assert ErrorCode.NETWORK == "network"


def test_protocol_error_minimal():
    """ProtocolError 最小字段(code + message)。"""
    err = ProtocolError(code=ErrorCode.INTERNAL, message="boom")
    assert err.code == ErrorCode.INTERNAL
    assert err.message == "boom"
    assert err.retry_after is None


def test_protocol_error_with_retry_after():
    """RATE_LIMIT 可携带 retry_after。"""
    err = ProtocolError(code=ErrorCode.RATE_LIMIT, message="限流", retry_after=30)
    assert err.retry_after == 30


def test_protocol_error_rejects_invalid_code():
    """非法 code 值应被拒绝。"""
    with pytest.raises(ValidationError):
        ProtocolError(code="not_a_real_code", message="x")


# ─── 任务 A2:ProtocolEvent union 测试 ──────────────────────────────────

from app.services.ai.protocol.events import (
    ContentBlockStart,
    ContentBlockDelta,
    ContentBlockStop,
    MessageStart,
    MessageDelta,
    MessageStop,
    Ping,
    ErrorEvent,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    TextDelta,
    ThinkingDelta,
    InputJSONDelta,
    Usage,
    StreamResult,
    validate_event,
)


def test_text_block():
    block = TextBlock()
    assert block.type == "text"


def test_thinking_block():
    block = ThinkingBlock()
    assert block.type == "thinking"


def test_tool_use_block():
    block = ToolUseBlock(id="tu_1", name="web_search", input={"query": "weather"})
    assert block.type == "tool_use"
    assert block.id == "tu_1"
    assert block.name == "web_search"
    assert block.input == {"query": "weather"}


def test_tool_result_block():
    block = ToolResultBlock(tool_use_id="tu_1", content="result text")
    assert block.type == "tool_result"
    assert block.is_error is False


def test_usage_defaults():
    u = Usage()
    assert u.input_tokens == 0
    assert u.output_tokens == 0
    assert u.total_tokens == 0


def test_message_start():
    ev = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    assert ev.type == "message_start"
    assert ev.role == "assistant"


def test_content_block_start_with_text():
    ev = ContentBlockStart(index=0, content_block=TextBlock())
    assert ev.type == "content_block_start"
    assert ev.index == 0
    assert ev.content_block.type == "text"


def test_content_block_delta_text():
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="hello"))
    assert ev.type == "content_block_delta"
    assert ev.delta.type == "text_delta"
    assert ev.delta.text == "hello"


def test_content_block_delta_thinking():
    ev = ContentBlockDelta(index=1, delta=ThinkingDelta(text="hmm"))
    assert ev.delta.type == "thinking_delta"


def test_content_block_delta_input_json():
    ev = ContentBlockDelta(index=2, delta=InputJSONDelta(partial_json='{"q":"'))
    assert ev.delta.type == "input_json_delta"
    assert ev.delta.partial_json == '{"q":"'


def test_message_delta_with_stop_reason():
    ev = MessageDelta(usage=Usage(output_tokens=10), stop_reason="end_turn")
    assert ev.stop_reason == "end_turn"


def test_message_stop():
    ev = MessageStop()
    assert ev.type == "message_stop"


def test_error_event():
    ev = ErrorEvent(error=ProtocolError(code=ErrorCode.CANCELLED, message="用户取消"))
    assert ev.type == "error"
    assert ev.error.code == ErrorCode.CANCELLED


def test_validate_event_round_trip_message_start():
    """JSON → ProtocolEvent 解析(discriminated union 验证)。"""
    original = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    data = original.model_dump_json()
    parsed = validate_event(data)
    assert isinstance(parsed, MessageStart)
    assert parsed.message_id == "msg_1"


def test_validate_event_round_trip_content_block_delta():
    """不同事件类型通过 type discriminator 正确解析。"""
    original = ContentBlockDelta(index=0, delta=TextDelta(text="hi"))
    parsed = validate_event(original.model_dump_json())
    assert isinstance(parsed, ContentBlockDelta)
    assert isinstance(parsed.delta, TextDelta)
    assert parsed.delta.text == "hi"


def test_validate_event_round_trip_error():
    """error 事件也能解析。"""
    original = ErrorEvent(error=ProtocolError(code=ErrorCode.LLM_5XX, message="500"))
    parsed = validate_event(original.model_dump_json())
    assert isinstance(parsed, ErrorEvent)
    assert parsed.error.code == ErrorCode.LLM_5XX


def test_validate_event_rejects_unknown_type():
    """非法 type 应被拒绝。"""
    with pytest.raises(Exception):
        validate_event('{"type":"not_a_real_event"}')


# ─── 任务 1.1:StreamResult 内部事件(2026-07-21 集成计划 Phase 1)──────────

def test_stream_result_minimal():
    """StreamResult 最小字段(full_text),其余默认 None。"""
    ev = StreamResult(full_text="hello world")
    assert ev.type == "stream_result"
    assert ev.full_text == "hello world"
    assert ev.search_source_cards is None
    assert ev.search_time_range is None
    assert ev.usage.input_tokens == 0


def test_stream_result_with_search_meta():
    """StreamResult 可携带搜索 source cards + time_range + usage。"""
    cards = [{"title": "T", "url": "https://x.com", "content": "c", "score": 0.9}]
    ev = StreamResult(
        full_text="answer",
        search_source_cards=cards,
        search_time_range="a_week",
        usage=Usage(input_tokens=10, output_tokens=20, total_tokens=30),
    )
    assert ev.search_source_cards == cards
    assert ev.search_time_range == "a_week"
    assert ev.usage.total_tokens == 30


def test_stream_result_round_trip():
    """StreamResult 经 validate_event 往返(discriminated union)。"""
    original = StreamResult(
        full_text="answer",
        search_source_cards=[{"title": "T", "url": "u", "content": "c", "score": 0.5}],
        search_time_range="a_day",
        usage=Usage(output_tokens=7),
    )
    parsed = validate_event(original.model_dump_json())
    assert isinstance(parsed, StreamResult)
    assert parsed.full_text == "answer"
    assert parsed.search_source_cards == original.search_source_cards
    assert parsed.search_time_range == "a_day"
    assert parsed.usage.output_tokens == 7
