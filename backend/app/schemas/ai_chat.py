from datetime import datetime

from pydantic import BaseModel, Field


class ConversationItem(BaseModel):
    id: int
    title: str
    created_at: datetime
    updated_at: datetime


class ConversationCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class MessageItem(BaseModel):
    id: int
    conversation_id: int
    role: str
    content: str
    created_at: datetime


class LLMConfigInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    timeout_seconds: int = Field(default=90, ge=10, le=300)
    system_prompt: str = Field(default='')


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    llm_config: LLMConfigInput


class MessageCreateResponse(BaseModel):
    user_message: MessageItem
    assistant_message: MessageItem
