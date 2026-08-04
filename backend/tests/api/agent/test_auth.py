"""Agent 命名空间鉴权端到端（spec E2 / E6 的 P0 形态）。

E6 完整版（projects/999999/shipments）随 P2 路由落地；P0 用
agent 前缀下不存在的路径验证 404 响应壳。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def agent_key(make_api_key):
    return make_api_key(agent_id="shipment-assistant-prod")


def _headers(key: dict) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": "shipment-assistant-prod",
    }


class TestHealthHappyPath:
    def test_200_echoes_agent_id(self, client, agent_key):
        resp = client.get("/api/v1/agent/health", headers=_headers(agent_key))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["data"]["agent_id"] == "shipment-assistant-prod"

    def test_last_used_at_stamped(self, client, agent_key):
        from app.models.agent_api_key import AgentApiKey

        client.get("/api/v1/agent/health", headers=_headers(agent_key))
        db = SessionLocal()
        try:
            record = db.get(AgentApiKey, agent_key["id"])
            assert record.last_used_at is not None
        finally:
            db.close()

    def test_reads_do_not_write_operation_audit(self, client, agent_key):
        db = SessionLocal()
        try:
            before = db.execute(
                text("select count(*) from operation_audit_logs")
            ).scalar()
        finally:
            db.close()
        client.get("/api/v1/agent/health", headers=_headers(agent_key))
        db = SessionLocal()
        try:
            after = db.execute(
                text("select count(*) from operation_audit_logs")
            ).scalar()
        finally:
            db.close()
        assert after == before


class TestAuthRejected:
    def test_missing_authorization(self, client):
        resp = client.get(
            "/api/v1/agent/health", headers={"X-Agent-Id": "x"}
        )
        assert resp.status_code == 401
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_AUTH_FAILED"
        assert body["error"]["reason"] == "token_invalid"

    def test_x_api_key_header_rejected(self, client, agent_key):
        resp = client.get(
            "/api/v1/agent/health",
            headers={"X-API-Key": agent_key["plaintext"], "X-Agent-Id": "shipment-assistant-prod"},
        )
        assert resp.status_code == 401

    def test_query_param_rejected(self, client, agent_key):
        resp = client.get(
            f"/api/v1/agent/health?api_key={agent_key['plaintext']}",
            headers={"X-Agent-Id": "shipment-assistant-prod"},
        )
        assert resp.status_code == 401

    def test_master_key_rejected(self, client):
        resp = client.get(
            "/api/v1/agent/health",
            headers={
                "Authorization": f"Bearer {get_settings().api_key}",
                "X-Agent-Id": "shipment-assistant-prod",
            },
        )
        assert resp.status_code == 401

    def test_unknown_token(self, client):
        resp = client.get(
            "/api/v1/agent/health",
            headers={"Authorization": "Bearer bbx_deadbeef", "X-Agent-Id": "x"},
        )
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "token_invalid"

    def test_agent_id_mismatch(self, client, agent_key):
        resp = client.get(
            "/api/v1/agent/health",
            headers={
                "Authorization": f"Bearer {agent_key['plaintext']}",
                "X-Agent-Id": "someone-else",
            },
        )
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "agent_id_mismatch"

    def test_missing_x_agent_id(self, client, agent_key):
        resp = client.get(
            "/api/v1/agent/health",
            headers={"Authorization": f"Bearer {agent_key['plaintext']}"},
        )
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "agent_id_mismatch"

    def test_legacy_key_rejected_on_agent_channel(self, client, make_api_key):
        legacy = make_api_key()  # agent_id=None
        resp = client.get(
            "/api/v1/agent/health",
            headers={
                "Authorization": f"Bearer {legacy['plaintext']}",
                "X-Agent-Id": "shipment-assistant-prod",
            },
        )
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "agent_id_mismatch"

    def test_revoked_key(self, client, make_api_key):
        key = make_api_key(agent_id="shipment-assistant-prod", revoked=True)
        resp = client.get("/api/v1/agent/health", headers=_headers(key))
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "token_revoked"

    def test_expired_key(self, client, make_api_key):
        key = make_api_key(
            agent_id="shipment-assistant-prod",
            expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        resp = client.get("/api/v1/agent/health", headers=_headers(key))
        assert resp.status_code == 401
        assert resp.json()["error"]["reason"] == "token_expired"


class TestAgentNamespaceErrorShell:
    def test_404_wrapped_in_shell(self, client, agent_key):
        resp = client.get("/api/v1/agent/nonexistent", headers=_headers(agent_key))
        assert resp.status_code == 404
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_404_unauthenticated_still_shell(self, client):
        resp = client.get("/api/v1/agent/nonexistent")
        assert resp.status_code == 401
        assert resp.json()["error"]["code"] == "AGENT_AUTH_FAILED"
