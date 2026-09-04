"""SSE 编码器单测。"""
from app.services.ai.protocol.encoder import encode_sse
from app.services.ai.protocol.events import (
    ContentBlockDelta,
    ContentBlockStart,
    MessageStart,
    MessageStop,
    Ping,
    TextBlock,
    TextDelta,
    Usage,
    MessageDelta,
)
from app.services.ai.protocol.errors import ErrorCode, ProtocolError
from app.services.ai.protocol.events import ErrorEvent


def test_encode_message_start():
    ev = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert text.startswith("data: ")
    assert '"type":"message_start"' in text
    assert text.endswith("\n\n")  # SSE 空行分隔


def test_encode_with_entry_id():
    """携带 entry_id 时输出 id: 行。"""
    ev = Ping()
    result = encode_sse(ev, entry_id="1719897600000-0")
    text = result.decode("utf-8")
    assert text.startswith("id: 1719897600000-0\ndata: ")
    assert text.endswith("\n\n")


def test_encode_content_block_delta():
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="hello"))
    result = encode_sse(ev, entry_id="123-0")
    text = result.decode("utf-8")
    assert '"type":"content_block_delta"' in text
    assert '"text":"hello"' in text
    assert "id: 123-0" in text


def test_encode_message_stop():
    ev = MessageStop()
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"type":"message_stop"' in text


def test_encode_error_event():
    err = ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
    ev = ErrorEvent(error=err)
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"type":"error"' in text
    assert '"code":"cancelled"' in text
    assert '"message":"用户取消"' in text


def test_encode_message_delta_with_usage():
    ev = MessageDelta(usage=Usage(input_tokens=10, output_tokens=5, total_tokens=15), stop_reason="end_turn")
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"stop_reason":"end_turn"' in text
    assert '"total_tokens":15' in text


def test_encode_no_entry_id():
    """无 entry_id 时不输出 id: 行。"""
    ev = MessageStop()
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert not text.startswith("id:")
    assert text.startswith("data: ")


def test_encode_unicode():
    """中文内容正确编码(非转义)。"""
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="你好世界"))
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert "你好世界" in text
    assert "\\u" not in text  # 非 ASCII 转义
