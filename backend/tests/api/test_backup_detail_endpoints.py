"""备份详情 / 下载 / 恢复命令 / 删除端点测试（Phase 2）。

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §5.3。
用 Mock db + 瞬态 BackupRecord，不碰真实 DB / R2。
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.backups import get_backup_download_url, get_backup_record
from app.models.backup_record import BackupRecord


def _record(**kw) -> BackupRecord:
    now = datetime(2026, 7, 22, 3, 0, 0, tzinfo=timezone.utc)
    return BackupRecord(
        id=kw.get("id", 1),
        backup_type=kw.get("backup_type", "full"),
        status=kw.get("status", "completed"),
        phase=kw.get("phase", "completed"),
        triggered_by=kw.get("triggered_by", "manual"),
        retry_count=kw.get("retry_count", 0),
        started_at=kw.get("started_at", now),
        created_at=kw.get("created_at", now),
        backup_set_name=kw.get("backup_set_name"),
        r2_key=kw.get("r2_key"),
    )


def test_get_backup_record_returns_item():
    db = Mock()
    db.get.return_value = _record(id=7, status="completed")
    resp = get_backup_record(record_id=7, db=db, _=True)
    assert resp.id == 7
    assert resp.status == "completed"
    assert resp.phase == "completed"


def test_get_backup_record_404_when_missing():
    db = Mock()
    db.get.return_value = None
    with pytest.raises(HTTPException) as exc:
        get_backup_record(record_id=999, db=db, _=True)
    assert exc.value.status_code == 404


def test_download_url_returns_presigned():
    db = Mock()
    db.get.return_value = _record(id=1, r2_key="db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz")
    with patch("app.api.v1.endpoints.backups.get_r2_download_url", return_value="https://signed/url"), \
         patch("app.api.v1.endpoints.backups.get_settings"):
        resp = get_backup_download_url(record_id=1, db=db, _=True)
    assert resp.url == "https://signed/url"


def test_download_url_400_when_not_uploaded():
    db = Mock()
    db.get.return_value = _record(id=1, r2_key=None)
    with patch("app.api.v1.endpoints.backups.get_r2_download_url", side_effect=ValueError("该备份尚未上传 R2")), \
         patch("app.api.v1.endpoints.backups.get_settings"):
        with pytest.raises(HTTPException) as exc:
            get_backup_download_url(record_id=1, db=db, _=True)
    assert exc.value.status_code == 400
