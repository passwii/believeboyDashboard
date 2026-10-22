"""CRM 方案分段上传端点集成测试（R2 mock，不碰真桶）。"""

from __future__ import annotations

from unittest.mock import PropertyMock, patch

import pytest

from app.core.config import get_settings
from app.services.crm import proposal_chunked_upload as up

CHUNK = up.CHUNK_SIZE

_HTML_HEAD = b"<html><body><h1>"
_HTML_TAIL = b"</h1></body></html>"


def _html_of_size(size: int) -> bytes:
    body = _HTML_HEAD + b"x" * (size - len(_HTML_HEAD) - len(_HTML_TAIL)) + _HTML_TAIL
    assert len(body) == size
    return body


def _pdf_of_size(size: int) -> bytes:
    """PDF 头 + 二进制填充（分段按字节合并，后端不解析）。"""
    head = b"%PDF-1.7\n"
    tail = b"\n%%EOF\n"
    return head + b"\x00" * (size - len(head) - len(tail)) + tail


_FAKE_BUCKET: dict[str, bytes] = {}


def _fake_upload(settings, data, filename, project_slug, file_type, content_type="application/octet-stream"):
    key = f"{project_slug}/{file_type}/{filename}"
    _FAKE_BUCKET[key] = bytes(data)
    return {"key": key, "url": f"https://fake.r2/{key}", "bucket": "fake", "size": len(data)}


def _fake_iter(settings, key, chunk_size=1024 * 1024):
    data = _FAKE_BUCKET.get(key, b"")
    for i in range(0, len(data), chunk_size):
        yield data[i : i + chunk_size]


def _fake_delete(settings, key, log_failure=True):
    from app.services.r2_service import R2DeleteResult

    _FAKE_BUCKET.pop(key, None)
    return R2DeleteResult(success=True, key=key or "")


@pytest.fixture(autouse=True)
def mock_r2():
    _FAKE_BUCKET.clear()
    with patch(
        "app.services.crm.proposal_service.upload_bytes_to_r2",
        side_effect=_fake_upload,
    ), patch(
        "app.services.crm.proposal_service.iter_file_from_r2",
        side_effect=_fake_iter,
    ), patch(
        "app.services.crm.proposal_service.try_delete_file_from_r2",
        side_effect=_fake_delete,
    ), patch.object(
        type(get_settings()),
        "r2_enabled",
        new_callable=PropertyMock,
        return_value=True,
    ):
        yield


@pytest.fixture(autouse=True)
def _tmp_upload_root(tmp_path, monkeypatch, settings):
    monkeypatch.setattr(settings, "upload_root", tmp_path)
    yield


def _init(client, headers, *, size, filename="big.html", content_type="text/html"):
    r = client.post(
        "/api/v1/crm/proposals/uploads/init",
        headers=headers,
        json={
            "filename": filename,
            "size": size,
            "content_type": content_type,
            "title": "大方案",
            "proposal_type": "other",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()


def _send_chunks(client, headers, init, body: bytes):
    chunk_size = init["chunk_size"]
    for i in range(init["total_chunks"]):
        chunk = body[i * chunk_size : (i + 1) * chunk_size]
        r = client.post(
            f"/api/v1/crm/proposals/uploads/{init['upload_id']}/chunks/{i}",
            headers={**headers, "Content-Type": "application/octet-stream"},
            content=chunk,
        )
        assert r.status_code == 200, r.text
        assert r.json()["size"] == len(chunk)


def test_init_rejects_unsupported_extension(client, admin_headers):
    r = client.post(
        "/api/v1/crm/proposals/uploads/init",
        headers=admin_headers,
        json={"filename": "x.md", "size": 100, "content_type": "text/markdown"},
    )
    assert r.status_code == 400
    assert "PDF" in r.json()["detail"]


def test_init_rejects_oversize(client, admin_headers, settings):
    r = client.post(
        "/api/v1/crm/proposals/uploads/init",
        headers=admin_headers,
        json={"filename": "x.html", "size": settings.crm_proposal_max_bytes + 1},
    )
    assert r.status_code == 413


def test_chunked_create_flow(client, admin_headers):
    size = 5 * 1024 * 1024
    body = _html_of_size(size)
    init = _init(client, admin_headers, size=size)
    assert init["total_chunks"] == 2
    _send_chunks(client, admin_headers, init, body)

    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    payload = r.json()
    assert payload["proposal"]["title"] == "大方案"
    assert payload["version"]["version_no"] == 1
    assert payload["version"]["file_size"] == size

    keys = [k for k in _FAKE_BUCKET if k.startswith("crm-proposals/")]
    assert len(keys) == 2
    assert any(k.endswith("/raw.html") for k in keys)
    assert any(k.endswith("/adapted.html") for k in keys)


def test_chunked_pdf_create_flow_stores_single_object(client, admin_headers):
    """PDF 分段合并后直存：一份 raw.pdf，下载按 application/pdf 返回。"""
    size = CHUNK + 1024
    body = _pdf_of_size(size)
    init = _init(
        client,
        admin_headers,
        size=size,
        filename="big.pdf",
        content_type="application/pdf",
    )
    assert init["total_chunks"] == 2
    _send_chunks(client, admin_headers, init, body)

    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    payload = r.json()
    pid = payload["proposal"]["id"]
    assert payload["version"]["content_type"] == "application/pdf"
    assert payload["version"]["original_filename"] == "big.pdf"
    assert payload["version"]["file_size"] == size
    assert payload["warnings"] == []

    keys = [k for k in _FAKE_BUCKET if k.startswith("crm-proposals/")]
    assert len(keys) == 1
    assert keys[0].endswith("/raw.pdf")

    download = client.get(
        f"/api/v1/crm/proposals/{pid}/versions/1/download",
        headers=admin_headers,
    )
    assert download.status_code == 200
    assert download.headers["content-type"] == "application/pdf"
    assert download.content == body


def test_finalize_requires_all_chunks(client, admin_headers):
    init = _init(client, admin_headers, size=5 * 1024 * 1024)
    # 只传第一段
    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/chunks/0",
        headers={**admin_headers, "Content-Type": "application/octet-stream"},
        content=b"x" * init["chunk_size"],
    )
    assert r.status_code == 200
    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert r.status_code == 400
    assert "分段不完整" in r.text


def test_chunk_rejects_wrong_owner(client, admin_headers, operator_headers):
    init = _init(client, admin_headers, size=CHUNK)
    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/chunks/0",
        headers={**operator_headers, "Content-Type": "application/octet-stream"},
        content=b"x" * CHUNK,
    )
    assert r.status_code == 403


def test_finalize_is_idempotent(client, admin_headers):
    size = 4 * 1024 * 1024 + 1
    body = _html_of_size(size)
    init = _init(client, admin_headers, size=size)
    _send_chunks(client, admin_headers, init, body)

    first = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    second = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["proposal"]["id"] == second.json()["proposal"]["id"]


def test_chunked_add_version_flow(client, admin_headers):
    # 先建一个 1 版方案（走旧的一次性上传）
    small = _html_of_size(1024)
    created = client.post(
        "/api/v1/crm/proposals",
        headers=admin_headers,
        files={"file": ("plan.html", small, "text/html")},
        data={"title": "可追加方案"},
    )
    assert created.status_code == 201, created.text
    proposal_id = created.json()["proposal"]["id"]

    size = 5 * 1024 * 1024
    body = _html_of_size(size)
    init_resp = client.post(
        f"/api/v1/crm/proposals/{proposal_id}/versions/uploads/init",
        headers=admin_headers,
        json={"filename": "v2.html", "size": size, "content_type": "text/html"},
    )
    assert init_resp.status_code == 200, init_resp.text
    init = init_resp.json()
    _send_chunks(client, admin_headers, init, body)

    r = client.post(
        f"/api/v1/crm/proposals/uploads/{init['upload_id']}/finalize",
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    assert r.json()["version"]["version_no"] == 2
