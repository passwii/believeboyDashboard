"""run_backup_task 状态机入口测试（Phase 1：跑 pgBackRest，不传 R2）。

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §4 任务 7。
task 用独立 SessionLocal 会话 commit（跨会话可见需真提交），故用 autouse fixture
清理 backup_records，避免污染共享测试库 BLF_test。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import pytest
from sqlalchemy import select, text

from app.celery_tasks.backup import cleanup_r2_task, run_backup_task, schedule_daily_backup_task
from app.models.backup_record import BackupRecord, BackupStatus


@pytest.fixture(autouse=True)
def _cleanup_backup_records(db_session):
    yield
    db_session.execute(text("DELETE FROM backup_records"))
    db_session.commit()


def _mk_record(db, **kw) -> BackupRecord:
    rec = BackupRecord(
        backup_type=kw.get("backup_type", "full"),
        status=kw.get("status", BackupStatus.PENDING.value),
        phase=kw.get("phase", "pending"),
        triggered_by=kw.get("triggered_by", "manual"),
        retry_count=kw.get("retry_count", 0),
        started_at=kw.get("started_at", datetime.now(timezone.utc)),
    )
    db.add(rec)
    db.commit()
    return rec


def test_short_circuit_when_already_completed(db_session):
    rec = _mk_record(db_session, status=BackupStatus.COMPLETED.value, phase="completed")
    with patch("app.services.backup_service._run_pgbackrest_backup") as mock_run:
        result = run_backup_task.apply(args=(rec.id,), throw=True).result
    mock_run.assert_not_called()
    assert result["status"] == "already_completed"


def test_success_advances_to_completed(db_session):
    rec = _mk_record(db_session)
    with patch("app.services.backup_service._run_pgbackrest_backup", return_value=(0, "{}", "")), \
         patch("app.services.backup_service._get_pgbackrest_info", return_value=(True, "{}", [])):
        result = run_backup_task.apply(args=(rec.id,), throw=True).result
    db_session.refresh(rec)
    assert rec.status == BackupStatus.COMPLETED.value
    assert rec.phase == "completed"
    assert result["status"] == "completed"


def test_failure_marks_failed_and_increments_retry(db_session):
    rec = _mk_record(db_session)
    with patch("app.services.backup_service._run_pgbackrest_backup", return_value=(1, "", "boom")):
        run_backup_task.apply(args=(rec.id,), throw=True).result
    db_session.refresh(rec)
    assert rec.status == BackupStatus.FAILED.value
    assert rec.retry_count == 1
    assert "boom" in (rec.error_message or "")


def test_success_with_r2_advances_through_upload_phases(db_session):
    """r2_enabled 且拿到 set_name 时: 走 compressing → r2_uploading → completed，落 r2_uploaded_at。"""
    rec = _mk_record(db_session)
    fake_settings = Mock(r2_enabled=True)
    info = (True, "{}", [{"label": "20260722-030000F", "size": 100, "duration": 60}])
    with patch("app.services.backup_service._run_pgbackrest_backup", return_value=(0, "{}", "")), \
         patch("app.services.backup_service._get_pgbackrest_info", return_value=info), \
         patch("app.core.config.get_settings", return_value=fake_settings), \
         patch("app.services.backup_service._archive_to_tar_gz", return_value=Path("/tmp/fake.tar.gz")) as mock_archive, \
         patch("app.services.backup_service._upload_to_r2") as mock_upload:
        result = run_backup_task.apply(args=(rec.id,), throw=True).result
    db_session.refresh(rec)
    assert rec.status == BackupStatus.COMPLETED.value
    assert rec.phase == "completed"
    assert rec.backup_set_name == "20260722-030000F"
    assert rec.r2_uploaded_at is not None
    mock_archive.assert_called_once_with("20260722-030000F", rec.id)
    mock_upload.assert_called_once()
    assert result["status"] == "completed"


def test_schedule_daily_backup_task_creates_auto_record(db_session):
    """schedule_daily_backup_task: INSERT triggered_by='auto' / created_by=null 记录 + run_backup_task.delay。"""
    with patch("app.services.backup_service.run_backup_task") as mock_task:
        result = schedule_daily_backup_task.apply(throw=True).result
    mock_task.delay.assert_called_once_with(result["record_id"])
    db_session.expire_all()
    rec = db_session.get(BackupRecord, result["record_id"])
    assert rec is not None
    assert rec.triggered_by == "auto"
    assert rec.backup_type == "full"
    assert rec.created_by is None


def test_cleanup_r2_task_keeps_n_deletes_rest(db_session):
    """塞 12 条已上传 R2 的记录，retention=7 → 留 7 删 5，被删的写 r2_deleted_at。"""
    base = datetime.now(timezone.utc)
    for i in range(12):
        db_session.add(
            BackupRecord(
                backup_type="full",
                status="completed",
                phase="completed",
                triggered_by="auto",
                started_at=base,
                r2_key=f"db-backups/pgbackrest/blf_2026-07-{i + 1:02d}_full_{i}.tar.gz",
                r2_uploaded_at=base - timedelta(hours=i),
            )
        )
    db_session.commit()

    fake_settings = Mock(backup_r2_retention_count=7)
    with patch("app.core.config.get_settings", return_value=fake_settings), \
         patch("app.services.r2_service.try_delete_file_from_r2", return_value=Mock(success=True)) as mock_del:
        result = cleanup_r2_task.apply(throw=True).result

    assert result["total"] == 12
    assert result["kept"] == 7
    assert result["deleted"] == 5
    assert mock_del.call_count == 5
    db_session.expire_all()
    deleted_rows = db_session.execute(
        select(BackupRecord).where(BackupRecord.r2_deleted_at.is_not(None))
    ).scalars().all()
    assert len(deleted_rows) == 5
