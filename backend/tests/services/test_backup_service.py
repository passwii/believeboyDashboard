"""Backup service tests — Celery 异步化 + BACKUP_VIA_CELERY 开关 (Phase 1).

Uses the real ``db_session`` fixture (test Postgres DB). Backup records are
created inline and rolled back per test.

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature.md §3.1 P0-1 异步化、§3.4 P0-4 DB 字段。
"""
from __future__ import annotations

from unittest.mock import patch

from app.core.config import Settings
from app.models.backup_record import BackupRecord, BackupStatus
from app.services.backup_service import enqueue_backup


def _settings(**overrides) -> Settings:
    """Build a Settings object with defaults + overrides (绕开 @lru_cache).

    复用 scheduled_report celery 测试的 helper 风格 (test_scheduled_report_celery.py)。
    """
    base = {
        "_env_file": None,
        "database_url": "postgresql+psycopg://u:p@localhost:5432/x",
    }
    base.update(overrides)
    return Settings(**base)


def test_enqueue_backup_via_celery_true_inserts_pending_record_and_delays_task(db_session):
    """BACKUP_VIA_CELERY=true 时:
    - INSERT backup_records (status=pending, phase=pending, triggered_by=manual)
    - run_backup_task.delay(record_id) 被调用一次
    - 5ms 返回 (不阻塞)
    """
    settings = _settings(backup_via_celery=True)

    with patch("app.services.backup_service.run_backup_task") as mock_task:
        record, msg = enqueue_backup(
            db_session, backup_type="full", user_id=1, settings=settings
        )

    db_session.flush()

    assert record.id is not None
    assert record.status == BackupStatus.PENDING.value
    assert record.phase == "pending"
    assert record.triggered_by == "manual"
    assert record.backup_type == "full"
    assert record.created_by == 1
    mock_task.delay.assert_called_once_with(record.id)
