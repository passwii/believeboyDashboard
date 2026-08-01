"""Schemas for external API key admin endpoints (BEL-377)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=128, description="人类可读标识")
    scope: str = Field(default="read", max_length=64)
    expires_at: datetime | None = Field(
        default=None, description="ISO 过期时间；null = 永不过期"
    )


class ApiKeyCreateResponse(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    expires_at: datetime | None
    created_at: datetime
    # Shown exactly once — the stored row only holds the SHA-256 hash.
    plaintext_key: str


class ApiKeyItem(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    is_revoked: bool
    expires_at: datetime | None
    created_at: datetime
    last_used_at: datetime | None

    model_config = {"from_attributes": True}


class ApiKeyRevokeResponse(BaseModel):
    id: int
    is_revoked: bool
