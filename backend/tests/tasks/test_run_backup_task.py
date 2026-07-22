"""run_backup_task 状态机入口测试（Phase 1：跑 pgBackRest，不传 R2）。

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §4 任务 7。
task 用独立 SessionLocal 会话 commit（跨会话可见需真提交），故用 autouse fixture
清理 backup_records，避免污染共享测试库 BLF_test。
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import text

from app.celery_tasks.backup import run_backup_task
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
