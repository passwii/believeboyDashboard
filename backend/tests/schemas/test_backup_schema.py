from datetime import datetime, timezone

from app.schemas.backup import BackupRecordItem


def test_backup_record_item_exposes_phase_and_r2_fields():
    item = BackupRecordItem(
        id=1,
        backup_type="full",
        status="completed",
        started_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
        phase="r2_uploading",
        triggered_by="auto",
        retry_count=1,
        backup_set_name="20260722-030000F",
        r2_key="db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        r2_url="https://x/db-backups/pgbackrest/blf_2026-07-22_full_1.tar.gz",
        r2_bucket="believeboy",
        r2_uploaded_at=datetime.now(timezone.utc),
        compressed_size_bytes=12345,
    )
    assert item.phase == "r2_uploading"
    assert item.triggered_by == "auto"
    assert item.r2_key.endswith(".tar.gz")
    assert item.compressed_size_bytes == 12345
