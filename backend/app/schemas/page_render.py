from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class UploadedPageResponse(BaseModel):
    """Owner-facing record (used by upload response + history list)."""

    id: str
    title: str
    source_format: str
    public_url: str
    original_filename: str
    file_size: int
    created_at: datetime


class PageRenderHistoryResponse(BaseModel):
    items: list[UploadedPageResponse]
    total: int


class PageRenderPublicResponse(BaseModel):
    """Metadata returned by the public read endpoint (no content, no owner info)."""

    id: str
    title: str
    source_format: str
    public_url: str