"""_upload_to_r2 / get_r2_download_url 测试 — R2 上传幂等 + presigned 下载链接。

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §5.1。
R2 客户端函数全部 mock，不碰网络 / 真实 bucket。
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from app.core.config import Settings
from app.models.backup_record import BackupRecord
from app.services.backup_service import _upload_to_r2, get_r2_download_url


def _record(**kw) -> BackupRecord:
    return BackupRecord(
        id=kw.get("id", 1),
        backup_type=kw.get("backup_type", "full"),
        status=kw.get("status", "completed"),
        started_at=kw.get("started_at", datetime(2026, 7, 22, 3, 0, 0, tzinfo=timezone.utc)),
        r2_key=kw.get("r2_key"),
    )


def _settings() -> Settings:
    return Settings(_env_file=None, database_url="postgresql+psycopg://u:p@localhost:5432/x")


def test_upload_to_r2_writes_back_fields(tmp_path):
    tar = tmp_path / "1.tar.gz"
    tar.write_bytes(b"fake-tar-bytes")
    record = _record()
    uploaded = {
        "key": "db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        "url": "https://bucket.believeboy.com/db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        "bucket": "believeboy-dash",
        "size": 14,
    }
    with patch("app.services.backup_service.check_file_exists", return_value=False), \
         patch("app.services.backup_service.upload_file_to_r2", return_value=uploaded) as mock_up:
        result = _upload_to_r2(_settings(), record, tar)
    mock_up.assert_called_once()
    assert result["key"] == uploaded["key"]
    assert record.r2_key == uploaded["key"]
    assert record.r2_url == uploaded["url"]
    assert record.r2_bucket == "believeboy-dash"
    assert record.compressed_size_bytes == 14


def test_upload_to_r2_skips_when_object_already_exists(tmp_path):
    tar = tmp_path / "1.tar.gz"
    tar.write_bytes(b"fake")
    record = _record(r2_key="db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz")
    record.r2_url = "https://x/existing"
    record.r2_bucket = "believeboy-dash"
    record.compressed_size_bytes = 14
    with patch("app.services.backup_service.check_file_exists", return_value=True) as mock_exists, \
         patch("app.services.backup_service.upload_file_to_r2") as mock_up:
        result = _upload_to_r2(_settings(), record, tar)
    mock_exists.assert_called_once()
    mock_up.assert_not_called()
    assert result["key"] == record.r2_key


def test_get_r2_download_url_returns_presigned():
    record = _record(r2_key="db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz")
    with patch("app.services.backup_service.generate_presigned_url", return_value="https://signed/url") as mock_ps:
        url = get_r2_download_url(_settings(), record)
    mock_ps.assert_called_once()
    assert url == "https://signed/url"


def test_get_r2_download_url_raises_without_r2_key():
    record = _record(r2_key=None)
    with pytest.raises(ValueError):
        get_r2_download_url(_settings(), record)
