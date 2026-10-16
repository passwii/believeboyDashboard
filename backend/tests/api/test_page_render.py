"""Tests for the Markdown/HTML page-render endpoints.

Covers spec scenarios:
- upload: .md / .markdown / .html success; .exe rejected; oversize → 413; empty → 400
- title sanitization (length clamp, control-char strip)
- MIME soft check (.md with text/plain still accepted)
- history: scoped to current user
- delete: owner-only (foreign → 404)
- public/{id}: requires API key, 404 when missing, metadata-only payload

We mock R2 I/O to avoid touching the real bucket.
"""
from __future__ import annotations

import io
import os
from typing import Any, Iterator
from unittest.mock import PropertyMock, patch
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app


# ---------- fixtures ----------


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def api_key() -> str:
    return get_settings().api_key


@pytest.fixture
def auth_headers(api_key: str) -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-User-Id": "1001",
        "X-User-Name": quote("测试用户A"),
        "X-Operator": quote("测试用户A"),
    }


@pytest.fixture
def other_auth_headers(api_key: str) -> dict[str, str]:
    return {
        "X-API-Key": api_key,
        "X-User-Id": "2002",
        "X-User-Name": quote("测试用户B"),
        "X-Operator": quote("测试用户B"),
    }


def _fake_upload_to_r2(settings, data, filename, project_slug, file_type, content_type="application/octet-stream"):
    """Return a fake R2 result without hitting the network."""
    key = f"{project_slug}/{file_type}/{filename}"
    base = settings.r2_public_url or "https://fake.r2.example"
    return {
        "key": key,
        "url": f"{base}/{key}",
        "bucket": settings.r2_bucket_name,
        "size": len(data),
    }


def _fake_delete_from_r2(settings, key, log_failure=True):
    from app.services.r2_service import R2DeleteResult
    return R2DeleteResult(success=True, key=key or "")


@pytest.fixture(autouse=True)
def mock_r2():
    """Stub R2 I/O **and** force ``r2_enabled`` on.

    These tests exercise the upload/delete flow with a mocked bucket, so they
    must not depend on real R2 credentials being present in the environment;
    patching the computed ``r2_enabled`` property keeps the suite hermetic.
    """
    with patch(
        "app.services.page_render_service.upload_bytes_to_r2",
        side_effect=_fake_upload_to_r2,
    ), patch(
        "app.services.page_render_service.try_delete_file_from_r2",
        side_effect=_fake_delete_from_r2,
    ), patch.object(
        type(get_settings()),
        "r2_enabled",
        new_callable=PropertyMock,
        return_value=True,
    ):
        yield


@pytest.fixture
def cleanup_pages(db_session: Session):
    """Yield, then wipe any test rows we created (r2_key prefixed test_)."""
    created_keys: list[str] = []
    yield created_keys
    if created_keys:
        db_session.execute(
            text(
                "delete from public.uploaded_pages where r2_key = any(:keys)"
            ),
            {"keys": created_keys},
        )
        db_session.commit()


def _make_upload(content: bytes, filename: str, content_type: str | None = None) -> dict[str, Any]:
    """Build a multipart files dict mimicking a real upload."""
    return {
        "file": (
            filename,
            io.BytesIO(content),
            content_type or "application/octet-stream",
        )
    }


# ---------- upload tests ----------


def test_upload_markdown_success(client, auth_headers, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"# Hello\n\nbody", "hello.md", "text/markdown"),
        data={"title": "Hello 页面"},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["title"] == "Hello 页面"
    assert body["source_format"] == "markdown"
    assert body["original_filename"] == "hello.md"
    assert body["public_url"].startswith("http")
    cleanup_pages.append(body["public_url"].split("/", 3)[-1])


def test_upload_html_success(client, auth_headers, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"<h1>Hi</h1>", "page.html", "text/html"),
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["source_format"] == "html"
    cleanup_pages.append(body["public_url"].split("/", 3)[-1])


def test_upload_markdown_extension(client, auth_headers, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "README.markdown", "text/markdown"),
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["source_format"] == "markdown"
    cleanup_pages.append(res.json()["public_url"].split("/", 3)[-1])


def test_upload_rejects_bad_extension(client, auth_headers, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"binary", "evil.exe", "application/octet-stream"),
        headers=auth_headers,
    )
    assert res.status_code == 400
    assert "不支持的文件类型" in res.json()["detail"]


def test_upload_rejects_empty_file(client, auth_headers, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"", "blank.md", "text/markdown"),
        headers=auth_headers,
    )
    assert res.status_code == 400
    assert "文件为空" in res.json()["detail"]


def test_upload_rejects_oversize(client, auth_headers, cleanup_pages):
    big = b"x" * (3 * 1024 * 1024)  # 3 MB > 2 MB cap
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(big, "big.md", "text/markdown"),
        headers=auth_headers,
    )
    assert res.status_code == 413
    assert "字节上限" in res.json()["detail"]


def test_upload_accepts_md_with_plain_mime(client, auth_headers, cleanup_pages):
    """Browsers often mis-report .md MIME as text/plain; spec says extension is authoritative."""
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"# ok", "note.md", "text/plain"),
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["source_format"] == "markdown"
    cleanup_pages.append(res.json()["public_url"].split("/", 3)[-1])


def test_upload_title_sanitized(client, auth_headers, cleanup_pages):
    """Title is clamped to 200 chars and stripped of control/HTML chars."""
    raw = " 标题<bad>&控制\x07字符 " + ("a" * 250)
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "x.md", "text/markdown"),
        data={"title": raw},
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    title = res.json()["title"]
    assert "<" not in title and ">" not in title and "&" not in title
    assert "\x07" not in title
    assert len(title) <= 200
    assert title.startswith("标题")
    cleanup_pages.append(res.json()["public_url"].split("/", 3)[-1])


def test_upload_title_fallback_to_filename(client, auth_headers, cleanup_pages):
    """No title → filename stem."""
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "my-cool-page.md", "text/markdown"),
        headers=auth_headers,
    )
    assert res.status_code == 201, res.text
    assert res.json()["title"] == "my-cool-page"
    cleanup_pages.append(res.json()["public_url"].split("/", 3)[-1])


def test_upload_requires_api_key(client, cleanup_pages):
    res = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "x.md", "text/markdown"),
    )
    assert res.status_code == 401


# ---------- history tests ----------


def test_history_scoped_to_user(client, auth_headers, other_auth_headers, db_session, cleanup_pages):
    # User A uploads two pages
    a1 = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"a1", "a1.md", "text/markdown"),
        headers=auth_headers,
    ).json()
    a2 = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"a2", "a2.html", "text/html"),
        headers=auth_headers,
    ).json()
    # User B uploads one
    b1 = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"b1", "b1.md", "text/markdown"),
        headers=other_auth_headers,
    ).json()

    cleanup_pages.extend([
        a1["public_url"].split("/", 3)[-1],
        a2["public_url"].split("/", 3)[-1],
        b1["public_url"].split("/", 3)[-1],
    ])

    res_a = client.get("/api/v1/page-render/history", headers=auth_headers)
    res_b = client.get("/api/v1/page-render/history", headers=other_auth_headers)

    assert res_a.status_code == 200
    assert res_b.status_code == 200
    ids_a = {item["id"] for item in res_a.json()["items"]}
    ids_b = {item["id"] for item in res_b.json()["items"]}
    assert a1["id"] in ids_a and a2["id"] in ids_a
    assert b1["id"] not in ids_a
    assert b1["id"] in ids_b
    assert a1["id"] not in ids_b and a2["id"] not in ids_b


def test_history_requires_api_key(client):
    res = client.get("/api/v1/page-render/history")
    assert res.status_code == 401


# ---------- delete tests ----------


def test_delete_owner_success(client, auth_headers, cleanup_pages):
    up = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "x.md", "text/markdown"),
        headers=auth_headers,
    ).json()
    cleanup_pages.append(up["public_url"].split("/", 3)[-1])

    res = client.delete(f"/api/v1/page-render/{up['id']}", headers=auth_headers)
    assert res.status_code == 204
    # Ensure it's gone from history
    history = client.get("/api/v1/page-render/history", headers=auth_headers).json()
    assert up["id"] not in {item["id"] for item in history["items"]}


def test_delete_foreign_returns_404(client, auth_headers, other_auth_headers, cleanup_pages):
    up = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "x.md", "text/markdown"),
        headers=auth_headers,
    ).json()
    cleanup_pages.append(up["public_url"].split("/", 3)[-1])

    # User B tries to delete User A's page → 404 (not 403, to avoid leaking existence)
    res = client.delete(f"/api/v1/page-render/{up['id']}", headers=other_auth_headers)
    assert res.status_code == 404


def test_delete_missing_returns_404(client, auth_headers):
    res = client.delete("/api/v1/page-render/00000000-0000-0000-0000-000000000000", headers=auth_headers)
    assert res.status_code == 404


# ---------- public endpoint tests ----------


def test_public_endpoint_returns_metadata(client, auth_headers, cleanup_pages):
    up = client.post(
        "/api/v1/page-render/upload",
        files=_make_upload(b"body", "x.md", "text/markdown"),
        headers=auth_headers,
    ).json()
    cleanup_pages.append(up["public_url"].split("/", 3)[-1])

    # No user headers needed — only API key
    res = client.get(f"/api/v1/page-render/public/{up['id']}", headers={"X-API-Key": get_settings().api_key})
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body.keys()) == {"id", "title", "source_format", "public_url"}
    assert body["id"] == up["id"]
    assert body["source_format"] == "markdown"
    # No owner_user_id leakage
    assert "owner" not in body


def test_public_endpoint_404(client, api_key):
    res = client.get(
        "/api/v1/page-render/public/00000000-0000-0000-0000-000000000000",
        headers={"X-API-Key": api_key},
    )
    assert res.status_code == 404


def test_public_endpoint_requires_api_key(client):
    res = client.get("/api/v1/page-render/public/anything")
    assert res.status_code == 401