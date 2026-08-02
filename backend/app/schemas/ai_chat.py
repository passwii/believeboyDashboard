from datetime import datetime

from pydantic import BaseModel, Field


class ConversationItem(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    total_tokens: int = 0


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class ConversationTitleRegenerateResponse(BaseModel):
    conversation: ConversationItem
    regenerated: bool


class MessageItem(BaseModel):
    id: int
    conversation_id: int
    role: str
    content: str
    search_sources: list[dict[str, str | float | None]] = Field(default_factory=list)
    # [BEL-81.B] 历史消息回放时，前端按此字段渲染「今日 / 近 7 天 / 近 30 天 /
    # 近 1 年」chip。允许 None（无搜索 / 老数据）。
    search_time_range: str | None = None
    is_complete: bool = True
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    duration_ms: int | None = None
    created_at: datetime


class LLMConfigInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    timeout_seconds: int = Field(default=90, ge=10, le=300)
    system_prompt: str = Field(default="")
    reasoning_effort: str | None = Field(default=None, max_length=20)


class MessageCreate(BaseModel):
    content: str = Field(default="", max_length=8000)
    model: str | None = Field(default=None, max_length=200)
    system_prompt: str = Field(default="")
    reasoning_effort: str | None = Field(default=None, max_length=20)
    regenerate: bool = Field(default=False)
    target_message_id: int | None = Field(default=None)
    enable_web_search: bool = Field(default=False)
    attached_file_content: str | None = Field(default=None, max_length=55000)
    attached_file_name: str | None = Field(default=None, max_length=500)


class AIChatMessageUpdate(BaseModel):
    """PATCH /ai/conversations/{cid}/messages/{mid} 请求体。

    当前仅支持编辑 user 消息的 content。assistant 消息不接受编辑
    （会破坏 regenerate 链），由 endpoint 层校验。
    """

    content: str = Field(min_length=1, max_length=8000)


class AIChatConfigResponse(BaseModel):
    provider_configured: bool
    web_search_configured: bool
    models: list[str]
    default_model: str
    premium_models: list[str] = Field(default_factory=list)
    basic_models: list[str] = Field(default_factory=list)
    reasoning_models: list[str] = Field(default_factory=list)
    default_reasoning_effort: str = Field(default="medium")
    timeout_seconds: int
    max_conversation_turns: int = Field(default=10, ge=1, le=50)
    web_search_max_results: int = Field(default=5, ge=1, le=50)


class TokenUsage(BaseModel):
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)


class StreamDoneResponse(BaseModel):
    user_message: MessageItem
    assistant_message: MessageItem
    conversation_title: str | None = None
    token_usage: TokenUsage | None = None
    duration_ms: int | None = None
    title_regenerated: bool = False
