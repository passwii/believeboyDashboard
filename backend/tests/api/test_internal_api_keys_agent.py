"""internal api-keys 端点的 agent_id 支持（spec E1/E5）。

admin_headers fixture 来自 backend/tests/conftest.py（含管理员上下文）。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.models.agent_api_key import AgentApiKey


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _cleanup(key_id: int) -> None:
    db = SessionLocal()
    try:
        obj = db.get(AgentApiKey, key_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


class TestAgentKeyCreate:
    def test_create_with_agent_id(self, client, admin_headers):
        created = client.post(
            "/api/v1/internal/api-keys",
            json={"label": "货件助理 (测试)", "agent_id": "shipment-assistant-test"},
            headers=admin_headers,
        )
        assert created.status_code == 201, created.text
        body = created.json()
        key_id = body["id"]
        try:
            assert body["plaintext_key"].startswith("bbx_")
            assert body["agent_id"] == "shipment-assistant-test"
            listed = client.get("/api/v1/internal/api-keys", headers=admin_headers)
            match = next(i for i in listed.json() if i["id"] == key_id)
            assert match["agent_id"] == "shipment-assistant-test"
            assert "plaintext_key" not in match
            # E1-4：审计行（人发起，operator 归因）
            db = SessionLocal()
            try:
                row = db.execute(
                    text(
                        "select operator, action, target_type from operation_audit_logs "
                        "where action='api_key.create' order by id desc limit 1"
                    )
                ).mappings().first()
                assert row is not None
                assert row["target_type"] == "agent_api_key"
                assert row["operator"]
            finally:
                db.close()
        finally:
            _cleanup(key_id)

    def test_create_without_agent_id_still_works(self, client, admin_headers):
        created = client.post(
            "/api/v1/internal/api-keys",
            json={"label": "legacy-style"},
            headers=admin_headers,
        )
        assert created.status_code == 201, created.text
        key_id = created.json()["id"]
        try:
            assert created.json()["agent_id"] is None
        finally:
            _cleanup(key_id)


class TestAgentKeyRevokeIntegration:
    def test_revoked_agent_key_blocks_agent_channel(self, client, admin_headers, make_api_key):
        key = make_api_key(agent_id="e5-agent")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "e5-agent",
        }
        assert client.get("/api/v1/agent/health", headers=headers).status_code == 200
        revoked = client.post(
            f"/api/v1/internal/api-keys/{key['id']}/revoke", headers=admin_headers
        )
        assert revoked.status_code == 200
        assert revoked.json() == {"id": key["id"], "is_revoked": True}
        blocked = client.get("/api/v1/agent/health", headers=headers)
        assert blocked.status_code == 401
        assert blocked.json()["error"]["reason"] == "token_revoked"
