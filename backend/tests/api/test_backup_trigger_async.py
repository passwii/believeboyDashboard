from unittest.mock import patch

from app.api.v1.endpoints.backups import trigger_backup_endpoint
from app.models.backup_record import BackupRecord, BackupStatus
from app.schemas.backup import BackupTriggerRequest


def test_trigger_endpoint_uses_enqueue_backup_and_returns_pending(db_session):
    """POST /trigger 走 enqueue_backup（异步入队），返回 status=pending，不阻塞。"""
    created = BackupRecord(
        id=42,
        backup_type="full",
        status=BackupStatus.PENDING.value,
        phase="pending",
        triggered_by="manual",
    )
    req = BackupTriggerRequest(backup_type="full")

    with patch("app.api.v1.endpoints.backups.is_pgbackrest_available", return_value=True), \
         patch("app.api.v1.endpoints.backups.is_backup_configured", return_value=(True, "ok")), \
         patch("app.api.v1.endpoints.backups.enqueue_backup", return_value=(created, "备份任务已入队")) as mock_enq, \
         patch("app.services.backup_service.trigger_backup") as mock_sync:
        resp = trigger_backup_endpoint(data=req, db=db_session, _=True, x_user_id="1")

    mock_enq.assert_called_once_with(db_session, "full", 1)
    mock_sync.assert_not_called()
    assert resp.id == 42
    assert resp.status == "pending"
