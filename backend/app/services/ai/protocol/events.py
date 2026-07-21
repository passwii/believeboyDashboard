"""Anthropic Messages SSE 风格事件定义。

经 anthropic-sdk-python/src/anthropic/types/raw_message_stream_event.py 验证:
discriminated union 写法正确(官方用 PropertyInfo,我们用 Field,语义等价)。

对应 V2 spec §5(协议事件定义)。
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter

from app.services.ai.protocol.errors import ProtocolError


# ── content blocks ──

class TextBlock(BaseModel):
    type: Literal["text"] = "text"


class ThinkingBlock(BaseModel):
    type: Literal["thinking"] = "thinking"


class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict = Field(default_factory=dict)


class ToolResultBlock(BaseModel):
    """工具返回结果(本仓库扩展,Anthropic 官方不显式发)。"""
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


ContentBlock = Annotated[
    Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock],
    Field(discriminator="type"),
]


# ── deltas ──

class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    text: str


class InputJSONDelta(BaseModel):
    type: Literal["input_json_delta"] = "input_json_delta"
    partial_json: str


Delta = Annotated[
    Union[TextDelta, ThinkingDelta, InputJSONDelta],
    Field(discriminator="type"),
]


# ── events ──

class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class MessageStart(BaseModel):
    type: Literal["message_start"] = "message_start"
    message_id: str
    model: str
    role: Literal["assistant"] = "assistant"
    created_at: int  # unix ms


class ContentBlockStart(BaseModel):
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: ContentBlock


class ContentBlockDelta(BaseModel):
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: Delta


class ContentBlockStop(BaseModel):
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int


class MessageDelta(BaseModel):
    type: Literal["message_delta"] = "message_delta"
    usage: Usage
    stop_reason: Literal["end_turn", "tool_use", "cancelled", "refusal"] | None = None


class MessageStop(BaseModel):
    type: Literal["message_stop"] = "message_stop"


class Ping(BaseModel):
    type: Literal["ping"] = "ping"


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    error: ProtocolError


class StreamResult(BaseModel):
    """后端内部事件:agent 跑完后的业务载荷(供 endpoint 持久化,不转发客户端)。

    本仓库扩展(非 Anthropic 标准)。runner 在 message_stop 前发出,endpoint 消费它做
    持久化(content / search sources / usage)+ 自动标题,然后合成客户端 done 事件。
    对应 2026-07-21 集成计划 Phase 1(Option B:runner=执行器,endpoint=业务 owner)。
    """
    type: Literal["stream_result"] = "stream_result"
    full_text: str
    search_source_cards: list[dict[str, Any]] | None = None
    search_time_range: str | None = None
    usage: Usage = Field(default_factory=Usage)


ProtocolEvent = Annotated[
    Union[
        MessageStart,
        ContentBlockStart,
        ContentBlockDelta,
        ContentBlockStop,
        MessageDelta,
        MessageStop,
        Ping,
        ErrorEvent,
        StreamResult,
    ],
    Field(discriminator="type"),
]


# TypeAdapter:从 JSON 解析 ProtocolEvent(Union 类型别名不能直接 model_validate_json)
_event_adapter = TypeAdapter(ProtocolEvent)


def validate_event(data: str | bytes) -> ProtocolEvent:
    """从 JSON 字符串/字节解析 ProtocolEvent。"""
    return _event_adapter.validate_json(data)
