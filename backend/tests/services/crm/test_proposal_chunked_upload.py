"""CRM 方案分段上传临时存储单测（无 DB / 无 R2）。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.services.crm import proposal_chunked_upload as up

CHUNK = up.CHUNK_SIZE


def _settings(settings, tmp_path):
    return settings.model_copy(update={"upload_root": tmp_path})


def _init(s, *, size=CHUNK * 2, owner="u1", filename="plan.html"):
    return up.init_upload(
        s,
        owner_id=owner,
        filename=filename,
        size=size,
        content_type="text/html",
        title="方案",
        proposal_type="other",
        customer_id=None,
        change_note=None,
    )


def test_init_computes_chunk_count_and_meta(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK * 2 + 1)
    assert meta["total_chunks"] == 3
    assert meta["chunk_size"] == CHUNK
    assert meta["status"] == "pending"
    assert (tmp_path / up._ROOT_NAME / meta["upload_id"] / "meta.json").exists()


def test_init_rejects_non_html(settings, tmp_path):
    s = _settings(settings, tmp_path)
    with pytest.raises(HTTPException) as exc:
        _init(s, filename="plan.pdf")
    assert exc.value.status_code == 400


def test_init_rejects_oooversize(settings, tmp_path):
    s = _settings(settings, tmp_path)
    with pytest.raises(HTTPException) as exc:
        _init(s, size=s.crm_proposal_max_bytes + 1)
    assert exc.value.status_code == 413


def test_write_chunk_validates_owner_and_size(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK * 2)
    uid = meta["upload_id"]

    with pytest.raises(HTTPException) as exc:
        up.write_chunk(s, uid, 0, b"x" * CHUNK, owner_id="intruder")
    assert exc.value.status_code == 403

    with pytest.raises(HTTPException) as exc:
        up.write_chunk(s, uid, 0, b"x" * (CHUNK + 1), owner_id="u1")
    assert exc.value.status_code == 413

    with pytest.raises(HTTPException) as exc:
        up.write_chunk(s, uid, 9, b"x", owner_id="u1")
    assert exc.value.status_code == 400


def test_assemble_requires_all_chunks_and_matches_size(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK * 2)
    uid = meta["upload_id"]

    up.write_chunk(s, uid, 0, b"a" * CHUNK, owner_id="u1")
    with pytest.raises(HTTPException) as exc:
        up.assemble(s, uid, owner_id="u1")
    assert exc.value.status_code == 400

    up.write_chunk(s, uid, 1, b"b" * CHUNK, owner_id="u1")
    data, meta2 = up.assemble(s, uid, owner_id="u1")
    assert len(data) == CHUNK * 2
    assert data[:CHUNK] == b"a" * CHUNK
    assert data[CHUNK:] == b"b" * CHUNK
    assert meta2["status"] == "assembling"


def test_mark_finalized_marks_status_and_removes_parts(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK)
    uid = meta["upload_id"]
    up.write_chunk(s, uid, 0, b"a" * CHUNK, owner_id="u1")
    up.assemble(s, uid, owner_id="u1")

    up.mark_finalized(s, uid, proposal_id=7, version_no=1)
    meta2 = up._read_meta(s, uid)
    assert meta2["status"] == "finalized"
    assert meta2["proposal_id_final"] == 7
    assert not list((tmp_path / up._ROOT_NAME / uid).glob("*.part"))


def test_cleanup_expired_removes_old_dir(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK)
    uid = meta["upload_id"]
    meta["expires_at"] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    up._write_meta(s, uid, meta)

    assert up.cleanup_expired(s) == 1
    assert not (tmp_path / up._ROOT_NAME / uid).exists()


def test_cleanup_expired_keeps_fresh_dir(settings, tmp_path):
    s = _settings(settings, tmp_path)
    meta = _init(s, size=CHUNK)
    assert up.cleanup_expired(s) == 0
    assert (tmp_path / up._ROOT_NAME / meta["upload_id"]).exists()
