"""_archive_to_tar_gz 测试 — 把 pgbackrest backup set 目录打成 tar.gz。

参考: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §5.1。
本地无 /var/lib/pgbackrest，用 monkeypatch 把 PG_BACKUP_BASE 指到 tmp_path。
"""
from __future__ import annotations

import tarfile

import pytest

from app.services.backup_service import _archive_to_tar_gz


def test_archive_to_tar_gz_creates_tarball_with_set_dir(tmp_path, monkeypatch):
    set_dir = tmp_path / "20260722-030000F"
    set_dir.mkdir()
    (set_dir / "backup.manifest").write_text("manifest-data")
    monkeypatch.setattr("app.services.backup_service.PG_BACKUP_BASE", tmp_path)

    tar_path = _archive_to_tar_gz("20260722-030000F", 999)
    try:
        assert tar_path.exists()
        with tarfile.open(tar_path) as tar:
            names = tar.getnames()
        assert "20260722-030000F/backup.manifest" in names
    finally:
        tar_path.unlink(missing_ok=True)


def test_archive_to_tar_gz_missing_set_raises(tmp_path, monkeypatch):
    monkeypatch.setattr("app.services.backup_service.PG_BACKUP_BASE", tmp_path)
    with pytest.raises(FileNotFoundError):
        _archive_to_tar_gz("nonexistent-set", 1)
