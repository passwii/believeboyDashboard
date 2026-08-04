"""Auth / admin-key / audit tests for the external API (BEL-377).

Covers the acceptance criteria:
  * auth disabled (default) → existing consumers unaffected (200, no key)
  * auth enabled → 401 without a key, 200 with master / DB key
  * expired key → 401 "API key expired"; revoked / invalid → 401
  * ``?skip_auth=true`` transition bypass
  * admin create / list / revoke (plaintext shown once, admin-only)
  * every external request lands in the audit log with the right key id
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models.agent_api_key import AgentApiKey


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def settings():
    return get_settings()


def _audit_count() -> int:
    db = SessionLocal()
    try:
        return db.execute(text("select count(*) from agent_api_audit_log")).scalar()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Transition default — no enforcement
# ---------------------------------------------------------------------------


class TestAuthDisabledDefault:
    def test_no_key_returns_200_when_not_enforced(self, client, settings):
        assert settings.external_api_require_auth is False
        resp = client.get("/api/v1/external/projects")
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# Enforcement
# ---------------------------------------------------------------------------


class TestAuthEnforced:
    def test_missing_key_401(self, client, settings):
        settings.external_api_require_auth = True
        resp = client.get("/api/v1/external/projects")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Missing API key"

    def test_master_key_allowed(self, client, settings):
        settings.external_api_require_auth = True
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": settings.api_key}
        )
        assert resp.status_code == 200, resp.text

    def test_invalid_key_401(self, client, settings):
        settings.external_api_require_auth = True
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": "bbx_deadbeef"}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid API key"

    def test_db_key_via_header(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key()
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": key["plaintext"]}
        )
        assert resp.status_code == 200, resp.text
        # last_used_at stamped on success
        db = SessionLocal()
        try:
            record = db.get(AgentApiKey, key["id"])
            assert record.last_used_at is not None
        finally:
            db.close()

    def test_db_key_via_bearer(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key()
        resp = client.get(
            "/api/v1/external/projects",
            headers={"Authorization": f"Bearer {key['plaintext']}"},
        )
        assert resp.status_code == 200, resp.text

    def test_db_key_via_query_param(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key()
        resp = client.get(f"/api/v1/external/projects?api_key={key['plaintext']}")
        assert resp.status_code == 200, resp.text

    def test_expired_key_401(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key(expires_at=datetime.now(timezone.utc) - timedelta(days=1))
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": key["plaintext"]}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "API key expired"

    def test_revoked_key_401(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key(revoked=True)
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": key["plaintext"]}
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid API key"

    def test_skip_auth_bypass(self, client, settings):
        settings.external_api_require_auth = True
        settings.external_api_allow_skip_auth = True
        resp = client.get("/api/v1/external/projects?skip_auth=true")
        assert resp.status_code == 200, resp.text

    def test_skip_auth_disabled_falls_through_to_401(self, client, settings):
        settings.external_api_require_auth = True
        settings.external_api_allow_skip_auth = False
        resp = client.get("/api/v1/external/projects?skip_auth=true")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Admin key management
# ---------------------------------------------------------------------------


class TestAdminKeyManagement:
    def test_non_admin_forbidden(self, client):
        resp = client.post(
            "/api/v1/internal/api-keys",
            json={"label": "x"},
            headers={"X-Is-Admin": "false"},
        )
        assert resp.status_code == 403

    def test_create_list_revoke(self, client, admin_headers):
        # create — plaintext shown once
        created = client.post(
            "/api/v1/internal/api-keys",
            json={"label": "ci-key"},
            headers=admin_headers,
        )
        assert created.status_code == 201, created.text
        body = created.json()
        key_id = body["id"]
        assert body["plaintext_key"].startswith("bbx_")
        assert body["label"] == "ci-key"

        try:
            # list — no plaintext leaked
            listed = client.get("/api/v1/internal/api-keys", headers=admin_headers)
            assert listed.status_code == 200
            items = listed.json()
            match = next(i for i in items if i["id"] == key_id)
            assert "plaintext_key" not in match
            assert match["key_prefix"].startswith("bbx_")
            assert match["is_revoked"] is False

            # revoke
            revoked = client.post(
                f"/api/v1/internal/api-keys/{key_id}/revoke", headers=admin_headers
            )
            assert revoked.status_code == 200
            assert revoked.json() == {"id": key_id, "is_revoked": True}
        finally:
            db = SessionLocal()
            try:
                obj = db.get(AgentApiKey, key_id)
                if obj is not None:
                    db.delete(obj)
                    db.commit()
            finally:
                db.close()

    def test_revoke_missing_404(self, client, admin_headers):
        resp = client.post(
            "/api/v1/internal/api-keys/99999999/revoke", headers=admin_headers
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------


class TestAuditLog:
    def test_request_logged_with_key_id(self, client, settings, make_api_key):
        settings.external_api_require_auth = True
        key = make_api_key()
        before = _audit_count()
        resp = client.get(
            "/api/v1/external/projects", headers={"X-API-Key": key["plaintext"]}
        )
        assert resp.status_code == 200
        after = _audit_count()
        assert after == before + 1

        db = SessionLocal()
        try:
            row = (
                db.execute(
                    text(
                        "select method, path, status_code, api_key_id "
                        "from agent_api_audit_log order by id desc limit 1"
                    )
                )
                .mappings()
                .first()
            )
            assert row["path"] == "/api/v1/external/projects"
            assert row["status_code"] == 200
            assert row["api_key_id"] == key["id"]
        finally:
            db.close()

    def test_anonymous_logged_with_null_key(self, client, settings):
        assert settings.external_api_require_auth is False
        before = _audit_count()
        client.get("/api/v1/external/projects")
        assert _audit_count() == before + 1

    def test_audit_disabled_writes_nothing(self, client, settings):
        settings.agent_api_audit_enabled = False
        before = _audit_count()
        client.get("/api/v1/external/projects")
        assert _audit_count() == before


class TestAuditRetention:
    def test_cleanup_deletes_only_old_rows(self, settings):
        from datetime import datetime, timedelta, timezone

        from app.celery_tasks.agent_api_audit_cleanup import agent_api_audit_cleanup
        from app.models.agent_api_audit_log import AgentApiAuditLog

        settings.agent_api_audit_retention_days = 90
        now = datetime.now(timezone.utc)
        old = now - timedelta(days=100)

        db = SessionLocal()
        try:
            old_row = AgentApiAuditLog(
                method="GET",
                path="/api/v1/external/projects",
                status_code=200,
                latency_ms=1,
                created_at=old,
            )
            new_row = AgentApiAuditLog(
                method="GET",
                path="/api/v1/external/projects",
                status_code=200,
                latency_ms=1,
                created_at=now,
            )
            db.add_all([old_row, new_row])
            db.commit()
            old_id, new_id = old_row.id, new_row.id
        finally:
            db.close()

        try:
            agent_api_audit_cleanup.run()
            db = SessionLocal()
            try:
                assert db.get(AgentApiAuditLog, old_id) is None
                assert db.get(AgentApiAuditLog, new_id) is not None
            finally:
                db.close()
        finally:
            db = SessionLocal()
            try:
                for row_id in (old_id, new_id):
                    obj = db.get(AgentApiAuditLog, row_id)
                    if obj is not None:
                        db.delete(obj)
                db.commit()
            finally:
                db.close()
