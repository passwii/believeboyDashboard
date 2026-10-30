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

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.models.agent_api_key import AgentApiKey

pytestmark = pytest.mark.audit_table_isolation


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


# ─────────────────── PATCH 编辑权限 / 业务范围（BLF-480）────────────────────


class TestUpdateEndpoint:
    def test_update_scopes_and_label(self, client, admin_headers, make_api_key):
        key = make_api_key(agent_id="u-agent")
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=admin_headers,
                json={
                    "label": "改名后",
                    "project_scope": "12, 34",
                    "business_scope": "shipments,shop_calculations",
                },
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == key["id"]
            assert body["label"] == "改名后"
            assert body["project_scope"] == "12, 34"
            assert body["business_scope"] == "shipments,shop_calculations"
            # 审计行
            audit = _audit_action(key["id"], "api_key.update")
            assert audit is not None
            assert audit["target_type"] == "agent_api_key"
        finally:
            _hard_cleanup(key["id"])

    def test_update_empty_scope_normalized_to_star(
        self, client, admin_headers, make_api_key
    ):
        key = make_api_key(agent_id="n-agent")
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=admin_headers,
                json={"project_scope": "", "business_scope": ""},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["project_scope"] == "*"
            assert resp.json()["business_scope"] == "*"
        finally:
            _hard_cleanup(key["id"])

    def test_update_partial_preserves_untouched(
        self, client, admin_headers, make_api_key
    ):
        key = make_api_key(
            agent_id="p-agent", project_scope="5", business_scope="inventory"
        )
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=admin_headers,
                json={"label": "仅改名称"},
            )
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["label"] == "仅改名称"
            assert body["project_scope"] == "5"  # 未传 → 保持
            assert body["business_scope"] == "inventory"  # 未传 → 保持
        finally:
            _hard_cleanup(key["id"])

    def test_update_unknown_returns_404(self, client, admin_headers):
        resp = client.patch(
            "/api/v1/internal/api-keys/999999999",
            headers=admin_headers,
            json={"label": "x"},
        )
        assert resp.status_code == 404

    def test_update_deleted_returns_404(self, client, admin_headers, make_api_key):
        """BLF-480：已删除 Key 不可编辑（终态不复活，与激活红线一致）。"""
        key = make_api_key(agent_id="ud-agent")
        try:
            deleted = client.delete(
                f"/api/v1/internal/api-keys/{key['id']}", headers=admin_headers
            )
            assert deleted.status_code == 204
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=admin_headers,
                json={"business_scope": "shipments"},
            )
            assert resp.status_code == 404
        finally:
            _hard_cleanup(key["id"])

    def test_update_non_admin_forbidden(self, client, operator_headers, make_api_key):
        key = make_api_key(agent_id="ua-agent")
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=operator_headers,
                json={"business_scope": "shipments"},
            )
            assert resp.status_code == 403
        finally:
            _hard_cleanup(key["id"])

    def test_edit_scope_takes_effect_for_agent_auth(
        self, client, admin_headers, make_api_key
    ):
        """端到端：编辑 business_scope 后鉴权实时生效（无需重建凭据）。

        初始全域（*）→ PATCH 收紧为 shipments → shop-calculations 域路由
        返回 403（AGENT_BUSINESS_OUT_OF_SCOPE），shipments 域路由仍 200。
        """
        agent_id = "edit-scope-agent"
        key = make_api_key(agent_id=agent_id, business_scope="*")
        from fastapi import APIRouter, Depends, FastAPI
        from app.api.agent.auth import require_agent_credential
        from app.api.agent.errors import register_agent_error_handlers
        from app.api.agent.rate_limit import require_agent_read_rate_limit
        from app.api.agent.response import agent_ok
        from app.api.agent.scope import require_business_scope

        try:
            # 先收紧业务范围
            resp = client.patch(
                f"/api/v1/internal/api-keys/{key['id']}",
                headers=admin_headers,
                json={"business_scope": "shipments"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["business_scope"] == "shipments"

            # 用独立迷你 app 复刻 agent 命名空间接线（对齐 test_business_scope.py）
            mini = FastAPI()
            register_agent_error_handlers(mini)
            router = APIRouter(
                prefix="/api/v1/agent",
                dependencies=[
                    Depends(require_agent_credential),
                    Depends(require_agent_read_rate_limit),
                ],
            )
            shipments = APIRouter(
                prefix="/projects/{project_id}/shipments",
                dependencies=[Depends(require_business_scope("shipments"))],
            )

            @shipments.get("/scope-read")
            def _ship_read(project_id: int) -> dict:
                return agent_ok({"domain": "shipments"})

            calcs = APIRouter(
                prefix="/projects/{project_id}/shop-calculations",
                dependencies=[Depends(require_business_scope("shop_calculations"))],
            )

            @calcs.get("/scope-read")
            def _calc_read(project_id: int) -> dict:
                return agent_ok({"domain": "shop_calculations"})

            router.include_router(shipments)
            router.include_router(calcs)
            mini.include_router(router)
            mini_client = TestClient(mini)

            headers = {
                "Authorization": f"Bearer {key['plaintext']}",
                "X-Agent-Id": agent_id,
            }
            project_id = 900013
            ok = mini_client.get(
                f"/api/v1/agent/projects/{project_id}/shipments/scope-read",
                headers=headers,
            )
            assert ok.status_code == 200, ok.text
            blocked = mini_client.get(
                f"/api/v1/agent/projects/{project_id}/shop-calculations/scope-read",
                headers=headers,
            )
            assert blocked.status_code == 403, blocked.text
            assert blocked.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
        finally:
            _hard_cleanup(key["id"])


# ─────────────────── 管理 Key 全局单例（BLF-847 红线 B）───────────────────


class TestProvisioningSingleton:
    """管理 Key 全局单例：全系统同一时刻至多一张「有效」且持有签发域
    （agent_provisioning）的 key（BLF-847 红线 B）。

    覆盖管理员 create / PATCH 两个写入口的互斥，以及停用/删除/过期后的让位。
    自助签发路径已被红线 A 物理封死（由 test_provisioning.py 覆盖），此处不重复。
    """

    @staticmethod
    def _create_admin_key(
        client,
        headers,
        *,
        business_scope: str = "agent_provisioning",
        agent_id: str | None = None,
        project_scope: str = "*",
        expires_at=None,
    ):
        body = {
            "label": "Admin Key",
            "agent_id": agent_id or f"admin-prov-{uuid.uuid4().hex[:8]}",
            "project_scope": project_scope,
            "business_scope": business_scope,
        }
        if expires_at is not None:
            body["expires_at"] = expires_at
        return client.post("/api/v1/internal/api-keys", json=body, headers=headers)

    def test_create_rejected_when_active_holder_exists(
        self, client, admin_headers, make_api_key
    ):
        holder = make_api_key(
            agent_id="holder-active", business_scope="agent_provisioning"
        )
        try:
            resp = self._create_admin_key(
                client, admin_headers, agent_id="second-attempt"
            )
            assert resp.status_code == 409, resp.text
            assert "agent_provisioning" in resp.json()["detail"]
        finally:
            _hard_cleanup(holder["id"])

    def test_create_allowed_after_deactivate(self, client, admin_headers, make_api_key):
        holder = make_api_key(
            agent_id="holder-deact", business_scope="agent_provisioning"
        )
        new_id = None
        try:
            deact = client.post(
                f"/api/v1/internal/api-keys/{holder['id']}/deactivate",
                headers=admin_headers,
            )
            assert deact.status_code == 200, deact.text
            resp = self._create_admin_key(client, admin_headers, agent_id="after-deact")
            assert resp.status_code == 201, resp.text
            new_id = resp.json()["id"]
        finally:
            _hard_cleanup(holder["id"])
            if new_id is not None:
                _hard_cleanup(new_id)

    def test_create_allowed_after_delete(self, client, admin_headers, make_api_key):
        holder = make_api_key(
            agent_id="holder-del", business_scope="agent_provisioning"
        )
        new_id = None
        try:
            deleted = client.delete(
                f"/api/v1/internal/api-keys/{holder['id']}", headers=admin_headers
            )
            assert deleted.status_code == 204, deleted.text
            resp = self._create_admin_key(client, admin_headers, agent_id="after-del")
            assert resp.status_code == 201, resp.text
            new_id = resp.json()["id"]
        finally:
            _hard_cleanup(holder["id"])
            if new_id is not None:
                _hard_cleanup(new_id)

    def test_expired_holder_does_not_block(self, client, admin_headers, make_api_key):
        holder = make_api_key(
            agent_id="holder-expired",
            business_scope="agent_provisioning",
            expires_at=datetime.now(timezone.utc) - timedelta(days=1),
        )
        new_id = None
        try:
            resp = self._create_admin_key(
                client, admin_headers, agent_id="after-expired"
            )
            assert resp.status_code == 201, resp.text
            new_id = resp.json()["id"]
        finally:
            _hard_cleanup(holder["id"])
            if new_id is not None:
                _hard_cleanup(new_id)

    def test_patch_rejected_when_would_create_second_holder(
        self, client, admin_headers, make_api_key
    ):
        """PATCH 给存量 key 补授签发域造出第二张管理 Key → 409，且原 key 不变。"""
        holder = make_api_key(
            agent_id="holder-patch", business_scope="agent_provisioning"
        )
        other = make_api_key(agent_id="other-key", business_scope="inventory")
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{other['id']}",
                headers=admin_headers,
                json={"business_scope": "inventory,agent_provisioning"},
            )
            assert resp.status_code == 409, resp.text
            assert "agent_provisioning" in resp.json()["detail"]
            # 失败回滚：other 的 business_scope 未被改动
            db = SessionLocal()
            try:
                row = db.get(AgentApiKey, other["id"])
                assert row.business_scope == "inventory"
            finally:
                db.close()
        finally:
            _hard_cleanup(holder["id"])
            _hard_cleanup(other["id"])

    def test_patch_own_scope_is_noop_allowed(self, client, admin_headers, make_api_key):
        """PATCH 现役管理 Key 自身保持签发域（exclude_id 排除自身）应放行。"""
        holder = make_api_key(
            agent_id="holder-self", business_scope="agent_provisioning"
        )
        try:
            resp = client.patch(
                f"/api/v1/internal/api-keys/{holder['id']}",
                headers=admin_headers,
                json={"label": "管理 Key 改名"},
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["business_scope"] == "agent_provisioning"
        finally:
            _hard_cleanup(holder["id"])
