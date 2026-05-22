"""Backup Service - handles pgBackRest operations."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime

from sqlalchemy.orm import Session

from app.models.backup_record import BackupRecord, BackupStatus, BackupType


def _run_pgbackrest(args: list[str], timeout: int = 3600) -> tuple[int, str, str]:
    """Run pgbackrest command and return (returncode, stdout, stderr)."""
    cmd = ["pgbackrest"] + args
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return 1, "", f"Command timed out after {timeout} seconds"
    except FileNotFoundError:
        return 1, "", "pgbackrest command not found"
    except Exception as e:
        return 1, "", str(e)


def _get_pgbackrest_info() -> tuple[bool, str, list[dict]]:
    """Get backup info from pgbackrest. Returns (success, raw_output, backups_list)."""
    returncode, stdout, stderr = _run_pgbackrest(["info", "--stanza=blf", "--output=json"])
    if returncode != 0:
        return False, stderr or stdout, []

    try:
        data = json.loads(stdout)
        backups = []
        for stanza in data:
            for backup in stanza.get("backup", []):
                backups.append(backup)
        return True, stdout, backups
    except json.JSONDecodeError:
        return True, stdout, []


def trigger_backup(db: Session, backup_type: str, user_id: int | None = None) -> tuple[BackupRecord, str]:
    """
    Trigger a pgBackRest backup.

    Returns (BackupRecord, message).
    """
    record = BackupRecord(
        backup_type=backup_type,
        status=BackupStatus.PENDING.value,
        started_at=datetime.now(),
        created_by=user_id,
    )
    db.add(record)
    db.flush()

    backup_args = [
        "backup",
        "--stanza=blf",
        f"--type={backup_type}",
        "--log-level-console=info",
        "--log-level-file=info",
        "--log-path=/var/log/pgbackrest",
    ]

    record.status = BackupStatus.RUNNING.value
    db.commit()

    returncode, stdout, stderr = _run_pgbackrest(backup_args, timeout=7200)

    record.completed_at = datetime.now()

    if returncode == 0:
        record.status = BackupStatus.COMPLETED.value

        success, info_raw, backups = _get_pgbackrest_info()
        if success:
            record.backup_info = info_raw

        latest = backups[-1] if backups else None
        if latest:
            record.size_bytes = latest.get("size")
            record.duration_seconds = latest.get("duration")

        db.commit()
        return record, "备份成功完成"
    else:
        record.status = BackupStatus.FAILED.value
        record.error_message = stderr or stdout
        db.commit()
        return record, f"备份失败: {record.error_message}"


def get_backup_records(db: Session, limit: int = 50, offset: int = 0) -> tuple[list[BackupRecord], int]:
    """Get backup records with pagination."""
    query = db.query(BackupRecord).order_by(BackupRecord.created_at.desc())

    total = query.count()
    records = query.offset(offset).limit(limit).all()

    return records, total


def get_backup_status_summary(db: Session) -> dict:
    """Get summary of backup status."""
    query = db.query(BackupRecord)

    total = query.count()
    successful = query.filter(BackupRecord.status == BackupStatus.COMPLETED.value).count()
    failed = query.filter(BackupRecord.status == BackupStatus.FAILED.value).count()
    is_running = (
        db.query(BackupRecord)
        .filter(BackupRecord.status == BackupStatus.RUNNING.value)
        .count()
        > 0
    )

    last_backup = (
        db.query(BackupRecord)
        .filter(BackupRecord.status == BackupStatus.COMPLETED.value)
        .order_by(BackupRecord.completed_at.desc())
        .first()
    )

    return {
        "last_backup": last_backup,
        "total_backups": total,
        "successful_backups": successful,
        "failed_backups": failed,
        "is_backup_running": is_running,
    }


def verify_backups() -> tuple[bool, str]:
    """Verify all backups."""
    returncode, stdout, stderr = _run_pgbackrest(["backup-verify", "--stanza=blf"])
    if returncode == 0:
        return True, "备份验证通过"
    return False, stderr or stdout


def get_raw_backup_info() -> tuple[str, list[dict]]:
    """Get raw pgBackRest info output."""
    success, raw, backups = _get_pgbackrest_info()
    if success:
        return raw, backups
    return raw, []


def is_pgbackrest_available() -> bool:
    """Check if pgbackrest is available on the system."""
    returncode, _, _ = _run_pgbackrest(["version"])
    return returncode == 0


def is_backup_configured() -> tuple[bool, str]:
    """Check if backup is properly configured."""
    if not is_pgbackrest_available():
        return False, "pgbackrest 未安装"

    returncode, _, stderr = _run_pgbackrest(["check", "--stanza=blf"])
    if returncode == 0:
        return True, "备份配置正常"
    return False, stderr or "stanza 未配置或连接失败"