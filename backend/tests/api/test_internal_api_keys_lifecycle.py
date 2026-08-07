"""internal api-keys 生命周期端点（BLF-468 §5.2）。

覆盖：
* ``POST /{id}/deactivate`` 停用（新端点）与 ``/revoke`` 兼容别名；
* ``POST /{id}/activate`` 激活；
* ``DELETE /{id}`` 软删除（幂等，204，审计行）；
* ``GET /`` 默认隐藏已删除 / ``?include_deleted=true`` 全量；
* ``ApiKeyItem.deleted_at`` 字段透出；
* 鉴权路径（``/api/v1/agent/health``）在 delete 后返回 401。

admin_headers / make_api_key fixture 来自 backend/tests/{conftest,api/conftest}.py。
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


def _hard_cleanup(key_id: int) -> None:
    """强制物理删除（含 deleted_at tombstone 行）。"""
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM agent_api_keys WHERE id = :id"), {"id": key_id})
        db.commit()
    finally:
        db.close()


def _audit_action(key_id: int, action: str) -> dict | None:
    db = SessionLocal()
    try:
        row = (
            db.execute(
                text(
                    "select operator, action, target_type, target_id "
                    "from operation_audit_logs "
                    "where target_id = CAST(:id AS varchar) and action = :action "
                    "order by id desc limit 1"
                ),
                {"id": str(key_id), "action": action},
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None
    finally:
        db.close()


# ─────────────────────────── 停用 / 激活（同步语义）───────────────────────────


class TestDeactivateEndpoint:
    def test_deactivate_sets_is_revoked(self, client, admin_headers, make_api_key):
        key = make_api_key(agent_id="d-agent")
        try:
            resp = client.post(
                f"/api/v1/internal/api-keys/{key['id']}/deactivate",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body == {"id": key["id"], "is_revoked": True}
            # 审计行
            audit = _audit_action(key["id"], "api_key.deactivate")
            assert audit is not None
            assert audit["target_type"] == "agent_api_key"
        finally:
            _hard_cleanup(key["id"])

    def test_revoke_alias_still_works(self, client, admin_headers, make_api_key):
        """BLF-468：``/revoke`` 保留为 ``/deactivate`` 的兼容别名。"""
        key = make_api_key(agent_id="r-agent")
        try:
            resp = client.post(
                f"/api/v1/internal/api-keys/{key['id']}/revoke",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == {"id": key["id"], "is_revoked": True}
            # 审计仍写 api_key.revoke（兼容别名，审计动作保留原样）
            audit = _audit_action(key["id"], "api_key.revoke")
            assert audit is not None
        finally:
            _hard_cleanup(key["id"])

    def test_deactivate_unknown_returns_404(self, client, admin_headers):
        resp = client.post(
            "/api/v1/internal/api-keys/999999999/deactivate",
            headers=admin_headers,
        )
        assert resp.status_code == 404

    def test_non_admin_forbidden(self, client, operator_headers, make_api_key):
        key = make_api_key(agent_id="o-agent")
        try:
            resp = client.post(
                f"/api/v1/internal/api-keys/{key['id']}/deactivate",
                headers=operator_headers,
            )
            assert resp.status_code == 403
        finally:
            _hard_cleanup(key["id"])


class TestActivateEndpoint:
    def test_activate_clears_revoked(self, client, admin_headers, make_api_key):
        key = make_api_key(agent_id="a-agent", revoked=True)
        try:
            resp = client.post(
                f"/api/v1/internal/api-keys/{key['id']}/activate",
                headers=admin_headers,
            )
            assert resp.status_code == 200, resp.text
            assert resp.json() == {"id": key["id"], "is_revoked": False}
            audit = _audit_action(key["id"], "api_key.activate")
            assert audit is not None
        finally:
            _hard_cleanup(key["id"])

    def test_activate_deleted_returns_404(self, client, admin_headers, make_api_key):
        """BLF-468 安全红线：已删除 Key 不能激活。"""
        key = make_api_key(agent_id="ad-agent")
        try:
            deleted = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert deleted.status_code == 204
            resp = client.post(
                f"/api/v1/internal/api-keys/{key['id']}/activate",
                headers=admin_headers,
            )
            assert resp.status_code == 404
        finally:
            _hard_cleanup(key["id"])


# ───────────────────────────────── 删除（软）───────────────────────────────


class TestDeleteEndpoint:
    def test_delete_returns_204_and_writes_audit(
        self, client, admin_headers, make_api_key
    ):
        key = make_api_key(agent_id="del-agent")
        try:
            resp = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert resp.status_code == 204, resp.text
            # DB 软删除：deleted_at 非空，is_revoked 不变
            db = SessionLocal()
            try:
                row = db.get(AgentApiKey, key["id"])
                assert row is not None
                assert row.deleted_at is not None
            finally:
                db.close()
            # 审计行
            audit = _audit_action(key["id"], "api_key.delete")
            assert audit is not None
        finally:
            _hard_cleanup(key["id"])

    def test_delete_is_idempotent(self, client, admin_headers, make_api_key):
        """BLF-468：删除幂等，第二次仍 204。"""
        key = make_api_key(agent_id="idem-agent")
        try:
            first = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert first.status_code == 204
            second = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert second.status_code == 204
        finally:
            _hard_cleanup(key["id"])

    def test_delete_unknown_returns_404(self, client, admin_headers):
        resp = client.delete(
            "/api/v1/internal/api-keys/999999999", headers=admin_headers
        )
        assert resp.status_code == 404

    def test_deleted_key_blocks_agent_channel(
        self, client, admin_headers, make_api_key
    ):
        """端到端：删除后 /api/v1/agent/health 必须 401（auth hardening 闭环）。"""
        key = make_api_key(agent_id="block-agent")
        try:
            headers = {
                "Authorization": f"Bearer {key['plaintext']}",
                "X-Agent-Id": "block-agent",
            }
            assert (
                client.get("/api/v1/agent/health", headers=headers).status_code == 200
            )
            deleted = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert deleted.status_code == 204
            blocked = client.get("/api/v1/agent/health", headers=headers)
            assert blocked.status_code == 401
            # error.reason 是 token_revoked / not_found / 等；删后应为 not_found
            # （由 resolve_key_for_agent 第一步 deleted_at → not_found 决定）
            assert blocked.json()["error"]["reason"] == "token_invalid"
        finally:
            _hard_cleanup(key["id"])


# ────────────────────────── List include_deleted + Item 字段 ──────────────────────────


class TestListEndpoint:
    def test_list_excludes_deleted_by_default(
        self, client, admin_headers, make_api_key
    ):
        keep = make_api_key(agent_id="keep-agent")
        gone = make_api_key(agent_id="gone-agent")
        try:
            deleted = client.delete(
                f"/api/v1/internal/api-keys/{gone['id']}", headers=admin_headers
            )
            assert deleted.status_code == 204
            listed = client.get("/api/v1/internal/api-keys", headers=admin_headers)
            assert listed.status_code == 200
            ids = {item["id"] for item in listed.json()}
            assert keep["id"] in ids
            assert gone["id"] not in ids
        finally:
            _hard_cleanup(keep["id"])
            _hard_cleanup(gone["id"])

    def test_list_include_deleted_returns_all(
        self, client, admin_headers, make_api_key
    ):
        keep = make_api_key(agent_id="k-agent")
        gone = make_api_key(agent_id="g-agent")
        try:
            client.delete(
                f"/api/v1/internal/api-keys/{gone['id']}", headers=admin_headers
            )
            listed = client.get(
                "/api/v1/internal/api-keys?include_deleted=true",
                headers=admin_headers,
            )
            assert listed.status_code == 200
            payload = listed.json()
            ids = {item["id"] for item in payload}
            assert keep["id"] in ids
            assert gone["id"] in ids
            # ApiKeyItem 透出 deleted_at
            gone_item = next(i for i in payload if i["id"] == gone["id"])
            assert gone_item["deleted_at"] is not None
        finally:
            _hard_cleanup(keep["id"])
            _hard_cleanup(gone["id"])

    def test_list_item_has_deleted_at_field(self, client, admin_headers, make_api_key):
        key = make_api_key(agent_id="f-agent")
        try:
            listed = client.get("/api/v1/internal/api-keys", headers=admin_headers)
            item = next(i for i in listed.json() if i["id"] == key["id"])
            # 字段存在（即使值为 None）
            assert "deleted_at" in item
            assert item["deleted_at"] is None
        finally:
            _hard_cleanup(key["id"])
