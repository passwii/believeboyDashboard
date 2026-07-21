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
