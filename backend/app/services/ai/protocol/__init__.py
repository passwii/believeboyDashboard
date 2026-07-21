"""AI Chat 协议层 — Anthropic Messages SSE 风格事件定义。

纯定义模块:不依赖 Redis / FastAPI / Pydantic AI。
经 Anthropic 官方 SDK 验证写法正确(raw_message_stream_event.py)。
"""
from app.services.ai.protocol.errors import ErrorCode, ProtocolError

__all__ = ["ErrorCode", "ProtocolError"]
