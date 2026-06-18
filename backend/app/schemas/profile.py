"""Pydantic schemas for self-service user profile endpoints.

These cover the routes under ``/api/v1/system-management/profile`` —
read/update the authenticated user's own basic info and manage their
profile picture. Admin-only management of other users lives in
``app.schemas.system_management`` and ``app.api.v1.endpoints.users``.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.schemas.system_management import UserRoleType


class ProfileResponse(BaseModel):
    """The shape returned by ``GET /system-management/profile``."""

    id: str
    email: str
    name: str
    full_name: Optional[str] = None
    operator_name_zh: Optional[str] = None
    is_admin: bool
    is_active: bool
    role_type: UserRoleType = UserRoleType.operator
    avatar_url: Optional[str] = None
    password_changed_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProfileUpdate(BaseModel):
    """Payload for ``PATCH /system-management/profile``.

    Every field is optional; only the keys that are present will be
    updated. Empty strings are normalised to ``None`` server-side so a
    blank input clears a field rather than persisting whitespace.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=255)
    full_name: Optional[str] = Field(default=None, max_length=255)
    operator_name_zh: Optional[str] = Field(default=None, max_length=255)


class AvatarUploadResponse(BaseModel):
    """Return value for ``POST /system-management/profile/avatar``."""

    avatar_url: str
    size: int
    content_type: str


class AvatarDeleteResponse(BaseModel):
    """Return value for ``DELETE /system-management/profile/avatar``."""

    ok: bool