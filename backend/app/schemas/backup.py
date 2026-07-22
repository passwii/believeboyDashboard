"""Backup management schemas for API request/response."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class BackupTriggerRequest(BaseModel):
    """Request to trigger a manual backup."""
    backup_type: Literal["full", "differential"] = "full"


class BackupTriggerResponse(BaseModel):
    """Response after triggering a backup."""
    id: int
    status: str
    message: str


class BackupRecordItem(BaseModel):
    """Single backup record item."""
    id: int
    backup_type: str
    status: str
    started_at: datetime
    completed_at: datetime | None = None
    size_bytes: int | None = None
    duration_seconds: int | None = None
    error_message: str | None = None
    backup_info: str | None = None
    created_by: int | None = None
    phase: str = "pending"
    triggered_by: str = "manual"
    retry_count: int = 0
    backup_set_name: str | None = None
    r2_key: str | None = None
    r2_url: str | None = None
    r2_bucket: str | None = None
    r2_uploaded_at: datetime | None = None
    r2_deleted_at: datetime | None = None
    compressed_size_bytes: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class BackupRecordListResponse(BaseModel):
    """List of backup records."""
    items: list[BackupRecordItem]
    total: int


class BackupStatusSummary(BaseModel):
    """Summary of backup status."""
    last_backup: BackupRecordItem | None = None
    total_backups: int
    successful_backups: int
    failed_backups: int
    is_backup_running: bool
    r2_storage_bytes: int | None = None


class BackupInfoResponse(BaseModel):
    """Raw pgBackRest info output."""
    raw_info: str
    backups: list[dict] = Field(default_factory=list)


class BackupVerifyResponse(BaseModel):
    """Response from backup verification."""
    success: bool
    message: str
    verified_at: datetime


class BackupDownloadUrlResponse(BaseModel):
    """R2 presigned 下载链接。"""
    url: str


class BackupRestoreCommandResponse(BaseModel):
    """pgbackrest restore 命令预览（不执行）。"""
    command: str
    set_name: str