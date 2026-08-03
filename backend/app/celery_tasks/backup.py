"""Celery tasks for PostgreSQL backup via pgBackRest → Cloudflare R2.

Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/

§3.1 P0-1 异步化承重墙: ``run_backup_task(record_id)`` 在 Celery worker 跑,
避免 API 进程被 2h 备份阻塞, broker 持久化保证 API 重启不丢备份在途。

§3.2 P0-2 状态机 + 幂等护栏:
  - worker 重投不重复跑 pgbackrest (phase 短路)
  - 多 worker 触发同一 record 不并发 (SELECT FOR UPDATE 行锁 + 乐观锁)

Phase 1: 跑 pgBackRest 并落 completed/failed; R2 上传 (compressing/r2_uploading)
在 Phase 2 接入。

注: 对 ``app.services.backup_service`` 的导入放在函数内 (延迟导入), 因为
backup_service 在模块顶部 import 了本模块的 run_backup_task, 顶层互相 import
会循环。延迟导入同时让单测可 patch 源模块函数。
"""
from __future__ import annotations

import logging
from datetime import datetime

from celery import shared_task
from sqlalchemy import select, update

from app.db.session import SessionLocal
from app.models.backup_record import BackupRecord, BackupStatus

logger = logging.getLogger(__name__)

# 软/硬时间限制 (Plan §3.1): 默认 90 / 120 min 占位, Phase 1 跑 pgbackrest info
# 历史 duration 统计后调 (参考 2026-07-10-scheduled-report-to-celery.md §4.8)。
BACKUP_SOFT_TIME_LIMIT = 5400  # 90 min
BACKUP_HARD_TIME_LIMIT = 7200  # 120 min
MAX_RETRIES = 2


def _advance_phase(db, record_id: int, from_phase: str, to_phase: str) -> bool:
    """乐观锁推进 phase; affected=0 表示被别的 task 抢占, 返回 False。"""
    stmt = (
        update(BackupRecord)
        .where(BackupRecord.id == record_id, BackupRecord.phase == from_phase)
        .values(phase=to_phase)
    )
    result = db.execute(stmt)
    db.commit()
    return result.rowcount == 1


@shared_task(
    name="app.celery_tasks.backup.run_backup_task",
    bind=True,
    acks_late=True,
    max_retries=MAX_RETRIES,
    default_retry_delay=60,
    soft_time_limit=BACKUP_SOFT_TIME_LIMIT,
    time_limit=BACKUP_HARD_TIME_LIMIT,
)
def run_backup_task(self, record_id: int) -> dict:
    """跑一次 pgBackRest 备份 (Phase 1: 不传 R2, Phase 2 接 compressing/r2_uploading)。"""
    # 延迟导入打破与 backup_service 的循环依赖 (见模块 docstring)。
    from app.core.config import get_settings
    from app.services.backup_service import (
        _archive_to_tar_gz,
        _get_pgbackrest_info,
        _run_pgbackrest_backup,
        _upload_to_r2,
    )

    with SessionLocal() as db:
        record = db.execute(
            select(BackupRecord).where(BackupRecord.id == record_id).with_for_update()
        ).scalar_one_or_none()

        if record is None:
            logger.warning("run_backup_task record_id=%s not found", record_id)
            return {"record_id": record_id, "status": "not_found"}

        if record.status == BackupStatus.COMPLETED.value:
            return {"record_id": record_id, "status": "already_completed"}

        if record.status == BackupStatus.FAILED.value and record.retry_count >= MAX_RETRIES:
            return {"record_id": record_id, "status": "retry_exhausted"}

        if not _advance_phase(db, record_id, "pending", "pgbackrest_running"):
            return {"record_id": record_id, "status": "preempted"}

        record.status = BackupStatus.RUNNING.value
        db.commit()

        returncode, stdout, stderr = _run_pgbackrest_backup(record.backup_type)

        if returncode == 0:
            # 先解析 pgbackrest info 拿 set_name / size / duration
            success, info_raw, backups = _get_pgbackrest_info()
            if success:
                record.backup_info = info_raw
            latest = backups[-1] if backups else None
            if latest:
                record.size_bytes = latest.get("size")
                record.duration_seconds = latest.get("duration")
                record.backup_set_name = latest.get("label")
            db.commit()

            # Phase 2: R2 上传 (compressing → r2_uploading)，仅当 R2 可用且拿到 set_name
            settings = get_settings()
            if settings.r2_enabled and record.backup_set_name:
                _advance_phase(db, record_id, "pgbackrest_running", "compressing")
                tar_path = _archive_to_tar_gz(record.backup_set_name, record_id)
                try:
                    _advance_phase(db, record_id, "compressing", "r2_uploading")
                    _upload_to_r2(settings, record, tar_path)
                    record.r2_uploaded_at = datetime.now()
                    db.commit()
                finally:
                    tar_path.unlink(missing_ok=True)

            record.completed_at = datetime.now()
            record.status = BackupStatus.COMPLETED.value
            record.phase = "completed"
            db.commit()
            return {"record_id": record_id, "status": "completed"}

        record.status = BackupStatus.FAILED.value
        record.phase = "failed"
        record.retry_count += 1
        record.error_message = stderr or stdout
        db.commit()
        return {"record_id": record_id, "status": "failed", "error": record.error_message}


@shared_task(name="app.celery_tasks.backup.schedule_daily_backup_task")
def schedule_daily_backup_task(backup_type: str = "full", triggered_by: str = "auto") -> dict:
    """Celery Beat 入口 (§3.6): 创建一条自动备份记录并入队 run_backup_task。

    thin wrapper — 真正的备份由 run_backup_task 在 backups 队列执行。
    """
    from app.services.backup_service import enqueue_backup

    with SessionLocal() as db:
        record, _ = enqueue_backup(db, backup_type=backup_type, user_id=None, triggered_by=triggered_by)
        db.commit()
        return {"record_id": record.id, "status": record.status}


@shared_task(name="app.celery_tasks.backup.cleanup_r2_task")
def cleanup_r2_task() -> dict:
    """R2 保留策略 (§3.7): 仅保留最近 N 份已上传 R2 的备份，其余删 R2 对象 + 写 r2_deleted_at。

    N = settings.backup_r2_retention_count（默认 7，与本地 retention-full 对齐）。
    记录行不删，仅写 r2_deleted_at 留审计。
    """
    from app.core.config import get_settings
    from app.services.r2_service import try_delete_file_from_r2

    settings = get_settings()
    retention = settings.backup_r2_retention_count

    with SessionLocal() as db:
        rows = db.execute(
            select(BackupRecord)
            .where(BackupRecord.r2_uploaded_at.is_not(None))
            .where(BackupRecord.r2_deleted_at.is_(None))
            .order_by(BackupRecord.r2_uploaded_at.desc())
        ).scalars().all()

        kept = deleted = 0
        for idx, record in enumerate(rows):
            if idx < retention:
                kept += 1
                continue
            if try_delete_file_from_r2(settings, record.r2_key).success:
                record.r2_deleted_at = datetime.now()
                deleted += 1
        db.commit()
        return {"kept": kept, "deleted": deleted, "total": len(rows)}
