"""Backup Management API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.backup import (
    BackupInfoResponse,
    BackupRecordItem,
    BackupRecordListResponse,
    BackupStatusSummary,
    BackupTriggerRequest,
    BackupTriggerResponse,
    BackupVerifyResponse,
)
from app.models.backup_record import BackupRecord
from app.services.backup_service import (
    enqueue_backup,
    get_backup_records,
    get_backup_status_summary,
    get_raw_backup_info,
    is_backup_configured,
    is_pgbackrest_available,
    verify_backups,
)

router = APIRouter(prefix="/backups", tags=["备份管理"], dependencies=[Depends(protected)])


def require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    """Require admin access for backup operations."""
    if not is_admin:
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return True


@router.get("/status", response_model=BackupStatusSummary)
def get_backup_status(
    db: Session = Depends(get_db_session),
    _: bool = Depends(require_admin),
) -> BackupStatusSummary:
    """Get backup status summary."""
    summary = get_backup_status_summary(db)
    return BackupStatusSummary(
        last_backup=BackupRecordItem.model_validate(summary["last_backup"]) if summary["last_backup"] else None,
        total_backups=summary["total_backups"],
        successful_backups=summary["successful_backups"],
        failed_backups=summary["failed_backups"],
        is_backup_running=summary["is_backup_running"],
    )


@router.get("/records", response_model=BackupRecordListResponse)
def list_backup_records(
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db_session),
    _: bool = Depends(require_admin),
) -> BackupRecordListResponse:
    """Get list of backup records."""
    records, total = get_backup_records(db, limit=limit, offset=offset)
    return BackupRecordListResponse(
        items=[BackupRecordItem.model_validate(r) for r in records],
        total=total,
    )


@router.post("/trigger", response_model=BackupTriggerResponse)
def trigger_backup_endpoint(
    data: BackupTriggerRequest,
    db: Session = Depends(get_db_session),
    _: bool = Depends(require_admin),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> BackupTriggerResponse:
    """Trigger a manual backup."""
    if not is_pgbackrest_available():
        raise HTTPException(status_code=503, detail="pgbackrest 未安装")

    configured, msg = is_backup_configured()
    if not configured:
        raise HTTPException(status_code=503, detail=f"备份未配置: {msg}")

    user_id = None
    if x_user_id:
        try:
            user_id = int(x_user_id.strip())
        except (ValueError, TypeError):
            pass

    record, message = enqueue_backup(db, data.backup_type, user_id)

    return BackupTriggerResponse(
        id=record.id,
        status=record.status,
        message=message,
    )


@router.get("/info", response_model=BackupInfoResponse)
def get_backup_info(
    _: bool = Depends(require_admin),
) -> BackupInfoResponse:
    """Get raw pgBackRest info."""
    raw, backups = get_raw_backup_info()
    return BackupInfoResponse(raw_info=raw, backups=backups)


@router.post("/verify", response_model=BackupVerifyResponse)
def verify_backup_endpoint(
    _: bool = Depends(require_admin),
) -> BackupVerifyResponse:
    """Verify all backups."""
    success, message = verify_backups()
    return BackupVerifyResponse(
        success=success,
        message=message,
    )


@router.get("/health")
def check_backup_health() -> dict:
    """Check if backup system is healthy (public endpoint, no auth required)."""
    available = is_pgbackrest_available()
    if not available:
        return {"status": "unavailable", "message": "pgbackrest 未安装"}

    configured, msg = is_backup_configured()
    if not configured:
        return {"status": "unconfigured", "message": msg}

    return {"status": "ready", "message": msg}


@router.get("/{record_id}", response_model=BackupRecordItem)
def get_backup_record(
    record_id: int,
    db: Session = Depends(get_db_session),
    _: bool = Depends(require_admin),
) -> BackupRecordItem:
    """单条备份记录详情（含 phase / R2 字段），供前端轮询。"""
    record = db.get(BackupRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="备份记录不存在")
    return BackupRecordItem.model_validate(record)