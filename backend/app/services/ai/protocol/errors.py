"""协议层错误码 + ProtocolError。

对应 V2 spec §10(错误分类)。
ErrorCode 贯穿后端 / 前端,前端按码分支,不做字符串匹配。
"""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel


class ErrorCode(str, Enum):
    """AI Chat 流式错误码。前端按码分支重试/显示。"""
    NETWORK = "network"
    TIMEOUT = "timeout"
    LLM_5XX = "llm_5xx"
    LLM_4XX = "llm_4xx"
    RATE_LIMIT = "rate_limit"
    CONTENT_FILTER = "content_filter"
    CANCELLED = "cancelled"
    VALIDATION = "validation"
    INTERNAL = "internal"
    PERSISTENCE = "persistence"
    TOOL_ERROR = "tool_error"


class ProtocolError(BaseModel):
    """流式错误详情。随 ErrorEvent 发送给前端。"""
    code: ErrorCode
    message: str
    retry_after: int | None = None  # 仅 RATE_LIMIT / TIMEOUT 时设置
