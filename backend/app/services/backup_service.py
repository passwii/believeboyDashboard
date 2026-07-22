"""Backup Service - handles pgBackRest operations."""

from __future__ import annotations

import json
import subprocess
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.celery_tasks.backup import run_backup_task
from app.models.backup_record import BackupRecord, BackupStatus, BackupType

# pgbackrest 本地备份仓库根目录（backup set 目录在 {base}/{set_name}/）。
PG_BACKUP_BASE = Path("/var/lib/pgbackrest/backup/blf")


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


def _run_pgbackrest_backup(backup_type: str) -> tuple[int, str, str]:
    """Worker 内执行一次 pgbackrest backup，返回 (returncode, stdout, stderr)。"""
    backup_args = [
        "backup",
        "--stanza=blf",
        f"--type={backup_type}",
        "--log-level-console=info",
        "--log-level-file=info",
        "--log-path=/var/log/pgbackrest",
    ]
    return _run_pgbackrest(backup_args, timeout=7200)


def _archive_to_tar_gz(set_name: str, record_id: int) -> Path:
    """把单次 backup set 目录打成 {tmp}/{record_id}.tar.gz，返回路径。"""
    src = PG_BACKUP_BASE / set_name
    if not src.is_dir():
        raise FileNotFoundError(f"backup set not found: {src}")
    tar_path = Path(tempfile.gettempdir()) / f"{record_id}.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(src, arcname=set_name)
    return tar_path


def enqueue_backup(
    db: Session,
    backup_type: str,
    user_id: int | None = None,
    settings: Settings | None = None,
) -> tuple[BackupRecord, str]:
    """API 端入口: INSERT backup_records + 入队 Celery task (§3.1 P0-1).

    - ``backup_via_celery=True``  (默认, 新形态): 5ms 返回, worker 跑 pgbackrest
    - ``backup_via_celery=False`` (回滚形态): 走旧同步路径 ``_run_pgbackrest_backup_sync``

    Phase 1 §3.4: 新增 ``phase`` / ``triggered_by`` 字段在此写入。
    """
    if settings is None:
        settings = get_settings()

    record = BackupRecord(
        backup_type=backup_type,
        status=BackupStatus.PENDING.value,
        phase="pending",
        triggered_by="manual",
        started_at=datetime.now(),
        created_by=user_id,
    )
    db.add(record)
    db.flush()

    if settings.backup_via_celery:
        run_backup_task.delay(record.id)
        return record, "备份任务已入队"
    else:
        # 回滚形态: 走旧同步路径 (Phase 1 循环 2 拆分出 _run_pgbackrest_backup_sync)
        return trigger_backup(db, backup_type, user_id=user_id)


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