"""AI Chat 协议层 — Anthropic Messages SSE 风格事件定义。

纯定义模块:不依赖 Redis / FastAPI / Pydantic AI。
经 Anthropic 官方 SDK 验证写法正确(raw_message_stream_event.py)。
"""
from app.services.ai.protocol.errors import ErrorCode, ProtocolError
from app.services.ai.protocol.events import (
    ContentBlock,
    ContentBlockDelta,
    ContentBlockStart,
    ContentBlockStop,
    Delta,
    ErrorEvent,
    InputJSONDelta,
    MessageDelta,
    MessageStart,
    MessageStop,
    Ping,
    ProtocolEvent,
    TextBlock,
    TextDelta,
    ThinkingBlock,
    ThinkingDelta,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
    validate_event,
)

__all__ = [
    "ErrorCode", "ProtocolError",
    "ContentBlock", "Delta", "ProtocolEvent",
    "TextBlock", "ThinkingBlock", "ToolUseBlock", "ToolResultBlock",
    "TextDelta", "ThinkingDelta", "InputJSONDelta",
    "Usage",
    "MessageStart", "ContentBlockStart", "ContentBlockDelta",
    "ContentBlockStop", "MessageDelta", "MessageStop", "Ping", "ErrorEvent",
    "validate_event",
]
