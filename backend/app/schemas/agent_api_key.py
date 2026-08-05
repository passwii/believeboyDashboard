"""Schemas for Agent API key admin endpoints（BEL-377，改名见设计稿 §11）。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=128, description="人类可读标识")
    scope: str = Field(default="read", max_length=64)
    project_scope: str = Field(
        default="*",
        max_length=255,
        description="项目范围：'*' 全部，或 ',' 分隔的 project_id 白名单（空串按 '*' 处理）",
    )
    expires_at: datetime | None = Field(
        default=None, description="ISO 过期时间；null = 永不过期"
    )
    agent_id: str | None = Field(
        default=None,
        max_length=128,
        description="绑定的 Agent 稳定标识；Agent 凭据必填，存量 external key 留空",
    )


class ApiKeyCreateResponse(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    project_scope: str
    agent_id: str | None
    expires_at: datetime | None
    created_at: datetime
    # Shown exactly once — the stored row only holds the SHA-256 hash.
    plaintext_key: str


class ApiKeyItem(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    project_scope: str
    agent_id: str | None
    is_revoked: bool
    expires_at: datetime | None
    created_at: datetime
    last_used_at: datetime | None

    model_config = {"from_attributes": True}


class ApiKeyRevokeResponse(BaseModel):
    id: int
    is_revoked: bool
