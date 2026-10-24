"""Profile endpoint tests.

Covers the self-service routes under ``/api/v1/system-management/profile``:
GET/PATCH for basic info, POST/DELETE for avatar upload via R2.

These tests run against a real Postgres + R2 config (see backend/.env).
Run with: ``cd backend && .venv/bin/pytest tests/api/test_profile_endpoints.py -v``.
"""
from __future__ import annotations

import io
from unittest.mock import PropertyMock, patch

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import text

from app.main import app
from app.core.config import get_settings
from app.db.session import SessionLocal


# ---------- fixtures ----------

# `db_session`, `test_operator`, and `operator_headers` come from the root
# conftest (backend/tests/conftest.py), which binds the suite to the dedicated
# test database and the seeded test accounts — so this test never touches a
# real user row on the dev/prod DB.


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def force_r2_enabled():
    """Force ``settings.r2_enabled=True`` for every test in this module.

    The avatar upload path short-circuits with 503 when R2 is unconfigured.
    These tests stub the R2 *I/O* only, so they must not depend on real R2
    credentials being present in the environment — patching the computed
    ``r2_enabled`` property keeps the suite hermetic.
    """
    with patch.object(
        type(get_settings()),
        "r2_enabled",
        new_callable=PropertyMock,
        return_value=True,
    ):
        yield


@pytest.fixture
def existing_user(test_operator: dict) -> dict:
    """Use the seeded test operator account from the test DB (no real users)."""
    return {"row": test_operator, "created": False}


@pytest.fixture
def auth_headers(operator_headers: dict) -> dict:
    """Auth headers for the seeded test operator account."""
    return operator_headers


def _make_png_bytes(size: int = 1024) -> bytes:
    img = Image.new("RGB", (10, 10), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = buf.getvalue()
    if size > len(data):
        data = data + b"\x00" * (size - len(data))
    return data


def _stub_r2_upload():
    """Patch ``upload_bytes_to_r2`` at its source module.

    ``save_user_avatar_file`` imports the helper lazily inside the function
    body, so the symbol is not present on the ``upload_service`` module
    namespace. Patching the original ``r2_service`` module means the lazy
    import picks up our stub on the first call.
    """
    return patch(
        "app.services.r2_service.upload_bytes_to_r2",
        return_value={
            "key": "avatars/__test__/stub.png",
            "url": "https://cdn.example.com/avatars/__test__/stub.png",
            "bucket": "test",
            "size": 100,
        },
    )


# ---------- GET /profile ----------


def test_get_profile_self_returns_user_fields(client, auth_headers, existing_user):
    response = client.get("/api/v1/system-management/profile", headers=auth_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    expected = existing_user["row"]
    assert body["id"] == str(expected["id"])
    assert body["email"] == expected["email"]
    assert body["name"] == expected["name"]
    # Schema fields all present
    for key in [
        "full_name",
        "is_admin",
        "is_active",
        "role_type",
        "avatar_url",
        "password_changed_at",
    ]:
        assert key in body


def test_get_profile_without_user_id_returns_401(client):
    response = client.get("/api/v1/system-management/profile")
    assert response.status_code == 401


def test_get_profile_missing_user_returns_404(client):
    response = client.get(
        "/api/v1/system-management/profile",
        headers={
            "X-API-Key": get_settings().api_key,
            "X-User-Id": "00000000-0000-0000-0000-000000000000",
            "X-User-Email": "ghost@example.com",
            "X-User-Name": "ghost",
            "X-Operator": "ghost",
            "X-Is-Admin": "false",
            "X-Role-Type": "operator",
        },
    )
    assert response.status_code == 404


# ---------- PATCH /profile ----------


def test_patch_profile_updates_name(client, auth_headers, existing_user, db_session):
    original = existing_user["row"]
    user_id = str(original["id"])
    new_name = f"updated-{original['name'][:8]}"
    try:
        response = client.patch(
            "/api/v1/system-management/profile",
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"name": new_name},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["name"] == new_name
        # DB reflects the change (read with a fresh query)
        verify_session = SessionLocal()
        try:
            db_row = verify_session.execute(
                text("select name from public.user_accounts where id::text = :id"),
                {"id": user_id},
            ).first()
        finally:
            verify_session.close()
        assert db_row is not None and db_row[0] == new_name
    finally:
        cleanup = SessionLocal()
        try:
            cleanup.execute(
                text("update public.user_accounts set name = :name where id::text = :id"),
                {"name": original["name"], "id": user_id},
            )
            cleanup.commit()
        finally:
            cleanup.close()


def test_patch_profile_empty_name_rejected(client, auth_headers):
    response = client.patch(
        "/api/v1/system-management/profile",
        headers={**auth_headers, "Content-Type": "application/json"},
        json={"name": "   "},
    )
    assert response.status_code == 400


def test_patch_profile_empty_body_returns_current_row(client, auth_headers):
    response = client.patch(
        "/api/v1/system-management/profile",
        headers={**auth_headers, "Content-Type": "application/json"},
        json={},
    )
    assert response.status_code == 200
    assert response.json()["id"]


# ---------- POST /profile/avatar ----------


def test_upload_avatar_writes_r2_and_updates_db(
    client, auth_headers, existing_user
):
    user_id = str(existing_user["row"]["id"])
    try:
        with _stub_r2_upload(), patch(
            "app.services.r2_service.extract_key_from_url",
            return_value=None,
        ):
            response = client.post(
                "/api/v1/system-management/profile/avatar",
                headers=auth_headers,
                files={"file": ("avatar.png", _make_png_bytes(), "image/png")},
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["avatar_url"].startswith("https://")
        assert body["content_type"] == "image/png"

        verify_session = SessionLocal()
        try:
            row = verify_session.execute(
                text("select avatar_url from public.user_accounts where id::text = :id"),
                {"id": user_id},
            ).first()
        finally:
            verify_session.close()
        assert row is not None and row[0] == body["avatar_url"]
    finally:
        cleanup = SessionLocal()
        try:
            cleanup.execute(
                text("update public.user_accounts set avatar_url = null where id::text = :id"),
                {"id": user_id},
            )
            cleanup.commit()
        finally:
            cleanup.close()


def test_upload_avatar_rejects_non_image(client, auth_headers):
    response = client.post(
        "/api/v1/system-management/profile/avatar",
        headers=auth_headers,
        files={"file": ("malware.exe", b"MZ" + b"\x00" * 100, "application/octet-stream")},
    )
    # Either 400 (extension) or 400 (MIME) — both are acceptable rejections.
    assert response.status_code == 400


def test_upload_avatar_size_limit_returns_413(client, auth_headers):
    settings = get_settings()
    # Send a payload just over the cap. We bypass PIL to keep bytes predictable.
    payload = b"\x00" * (settings.avatar_max_bytes + 4096)
    response = client.post(
        "/api/v1/system-management/profile/avatar",
        headers=auth_headers,
        files={"file": ("big.png", payload, "image/png")},
    )
    assert response.status_code in (400, 413)


# ---------- DELETE /profile/avatar ----------


def test_delete_avatar_clears_db(client, auth_headers, existing_user):
    user_id = str(existing_user["row"]["id"])
    original_avatar_url = existing_user["row"]["avatar_url"]
    # Pre-set an avatar_url so DELETE has something to clear.
    setup = SessionLocal()
    try:
        setup.execute(
            text(
                "update public.user_accounts set avatar_url = 'https://cdn.example.com/avatars/x.png' where id::text = :id"
            ),
            {"id": user_id},
        )
        setup.commit()
    finally:
        setup.close()

    try:
        with patch(
            "app.services.r2_service.extract_key_from_url",
            return_value=None,
        ):
            response = client.delete(
                "/api/v1/system-management/profile/avatar",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True}

        verify_session = SessionLocal()
        try:
            row = verify_session.execute(
                text("select avatar_url from public.user_accounts where id::text = :id"),
                {"id": user_id},
            ).first()
        finally:
            verify_session.close()
        assert row is not None and row[0] is None
    finally:
        cleanup = SessionLocal()
        try:
            cleanup.execute(
                text("update public.user_accounts set avatar_url = :url where id::text = :id"),
                {"url": original_avatar_url, "id": user_id},
            )
            cleanup.commit()
        finally:
            cleanup.close()