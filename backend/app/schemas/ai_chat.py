from datetime import datetime

from pydantic import BaseModel, Field


class ConversationItem(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime


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
    created_at: datetime


class LLMConfigInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    timeout_seconds: int = Field(default=90, ge=10, le=300)
    system_prompt: str = Field(default="")


class MessageCreate(BaseModel):
    content: str = Field(default="", max_length=8000)
    model: str | None = Field(default=None, max_length=200)
    system_prompt: str = Field(default="")
    regenerate: bool = Field(default=False)
    enable_web_search: bool = Field(default=False)
    attached_file_content: str | None = Field(default=None, max_length=55000)
    attached_file_name: str | None = Field(default=None, max_length=500)


class MessageCreateResponse(BaseModel):
    user_message: MessageItem
    assistant_message: MessageItem


class AIChatConfigResponse(BaseModel):
    provider_configured: bool
    web_search_configured: bool
    models: list[str]
    default_model: str
    timeout_seconds: int
    max_conversation_turns: int = Field(default=10, ge=1, le=50)


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
