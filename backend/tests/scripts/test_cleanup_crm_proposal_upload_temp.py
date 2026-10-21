"""分段上传临时目录清理脚本测试。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.crm import proposal_chunked_upload as up


def _settings(settings, tmp_path):
    return settings.model_copy(update={"upload_root": tmp_path})


def test_cleanup_expired_removes_only_expired(settings, tmp_path):
    s = _settings(settings, tmp_path)

    old = up.init_upload(
        s,
        owner_id="u1",
        filename="old.html",
        size=10,
        content_type="text/html",
        title=None,
        proposal_type="other",
        customer_id=None,
        change_note=None,
    )
    fresh = up.init_upload(
        s,
        owner_id="u1",
        filename="fresh.html",
        size=10,
        content_type="text/html",
        title=None,
        proposal_type="other",
        customer_id=None,
        change_note=None,
    )

    old_meta = up._read_meta(s, old["upload_id"])
    old_meta["expires_at"] = (
        datetime.now(timezone.utc) - timedelta(seconds=1)
    ).isoformat()
    up._write_meta(s, old["upload_id"], old_meta)

    assert up.cleanup_expired(s) == 1
    root = tmp_path / up._ROOT_NAME
    assert not (root / old["upload_id"]).exists()
    assert (root / fresh["upload_id"]).exists()
