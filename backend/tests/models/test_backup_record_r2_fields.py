from app.models.backup_record import BackupRecord


def test_backup_record_has_r2_and_audit_columns():
    cols = {c.name for c in BackupRecord.__table__.columns}
    for name in (
        "r2_key",
        "r2_url",
        "r2_bucket",
        "r2_uploaded_at",
        "r2_deleted_at",
        "compressed_size_bytes",
        "backup_set_path",
    ):
        assert name in cols, f"missing column {name}"
    idx_names = {i.name for i in BackupRecord.__table__.indexes}
    assert "idx_br_r2_key" in idx_names
