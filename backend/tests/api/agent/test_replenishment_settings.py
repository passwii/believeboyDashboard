"""Agent 补货分析 R5 设置列表 / R6 设置写（confirm 流）测试（BLF-502）。"""

from __future__ import annotations

import uuid

import pytest
from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.models import InventoryReplenishmentSetting, OperationAuditLog
from conftest import seed_replenishment_setting
from fastapi.testclient import TestClient
from sqlalchemy import func, select


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """clear 内存写桶：跨测试隔离（slowapi 状态按进程共享）。"""
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/replenishment-analysis{suffix}"


def _put(client, env, body, *, token=None, idem=None):
    headers = dict(env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.put(_url(env, "/settings/X-001"), json=body, headers=headers)


_SETTING_BODY = {
    "asin": "ASIN-X-001",
    "production_lead_days": 40,
    "shipping_days": 45,
    "safety_factor": 0.25,
}


class TestR5SettingsList:
    def test_list_with_sku_filter(self, client, shipment_env):
        seed_replenishment_setting(
            shipment_env["project_id"], "X-001", asin="ASIN-X-001"
        )
        seed_replenishment_setting(
            shipment_env["project_id"], "X-002", asin="ASIN-X-002"
        )
        resp = client.get(
            _url(shipment_env, "/settings"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert [i["sku"] for i in items] == ["X-001", "X-002"]
        assert items[0]["production_lead_days"] == 30

        resp2 = client.get(
            _url(shipment_env, "/settings"),
            params={"sku": "X-00"},
            headers=shipment_env["headers"],
        )
        assert [i["sku"] for i in resp2.json()["data"]["items"]] == ["X-001", "X-002"]

        resp3 = client.get(
            _url(shipment_env, "/settings"),
            params={"sku": "X-002"},
            headers=shipment_env["headers"],
        )
        assert [i["sku"] for i in resp3.json()["data"]["items"]] == ["X-002"]

    def test_list_empty(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env, "/settings"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["items"] == []


class TestR6SettingsWrite:
    def test_confirm_preview_then_replay(
        self, client, shipment_env, confirm_memory_store
    ):
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        # 第一次调用：预览，不落库
        resp = _put(client, shipment_env, _SETTING_BODY, idem=idem)
        assert resp.status_code == 200, resp.text
        shell = resp.json()
        assert shell["ok"] is False
        assert shell["requires_confirmation"] is True
        token = shell["confirm_token"]
        assert shell["preview"]["action"] == "replenishment_settings.upsert"
        assert shell["preview"]["summary"]["sku"] == "X-001"

        db = SessionLocal()
        try:
            count = db.execute(
                select(func.count())
                .select_from(InventoryReplenishmentSetting)
                .where(
                    InventoryReplenishmentSetting.project_id
                    == shipment_env["project_id"]
                )
            ).scalar()
            assert count == 0, "预览不落库"
        finally:
            db.close()

        # 第二次调用：重放 → 落库 + 审计（operator=NULL + agent_id）
        resp2 = _put(client, shipment_env, _SETTING_BODY, token=token, idem=idem)
        assert resp2.status_code == 200, resp2.text
        data = resp2.json()["data"]
        assert data["sku"] == "X-001"
        assert data["production_lead_days"] == 40
        assert data["safety_factor"] == 0.25

        db = SessionLocal()
        try:
            row = db.execute(
                select(InventoryReplenishmentSetting).where(
                    InventoryReplenishmentSetting.project_id
                    == shipment_env["project_id"],
                    InventoryReplenishmentSetting.sku == "X-001",
                )
            ).scalar_one()
            assert row.production_lead_days == 40
            assert row.shipping_days == 45
            assert float(row.safety_factor) == 0.25

            audit = db.execute(
                select(OperationAuditLog).where(
                    OperationAuditLog.agent_id == shipment_env["agent_id"],
                    OperationAuditLog.action
                    == "inventory_replenishment_settings.upsert",
                )
            ).scalar_one()
            assert audit.operator is None
            assert audit.agent_id == shipment_env["agent_id"]
        finally:
            db.close()

    def test_invalid_token_rejected(self, client, shipment_env, confirm_memory_store):
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        _put(client, shipment_env, _SETTING_BODY, idem=idem)
        resp = _put(
            client,
            shipment_env,
            _SETTING_BODY,
            token="cf_bogus",
            idem=idem,
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_body_mismatch_rejected(self, client, shipment_env, confirm_memory_store):
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        shell = _put(client, shipment_env, _SETTING_BODY, idem=idem).json()
        token = shell["confirm_token"]
        mutated = dict(_SETTING_BODY)
        mutated["production_lead_days"] = 99  # body hash 不匹配
        resp = _put(client, shipment_env, mutated, token=token, idem=idem)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_validation_error_before_preview(
        self, client, shipment_env, confirm_memory_store
    ):
        resp = _put(
            client,
            shipment_env,
            {
                "asin": "X",
                "production_lead_days": -5,
                "shipping_days": 1,
                "safety_factor": 0.1,
            },
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_replay_invalidates_replenishment_cache(
        self, client, shipment_env, confirm_memory_store, monkeypatch
    ):
        """BLF-633: R6 重放落库后必须失效补货分析缓存；预览阶段不失效。"""
        from app.services.infra import cache_decorator as cd

        calls: list[int] = []
        monkeypatch.setitem(
            cd._INVALIDATE_FNS,
            "inventory_replenishment",
            lambda project_id=None, **kw: calls.append(project_id),
        )

        idem = f"idem-{uuid.uuid4().hex[:12]}"
        # 预览：不落库，也不失效缓存
        shell = _put(client, shipment_env, _SETTING_BODY, idem=idem).json()
        token = shell["confirm_token"]
        assert calls == [], "预览阶段不应失效缓存"

        # 重放：落库 + 按 project_id 失效
        resp = _put(client, shipment_env, _SETTING_BODY, token=token, idem=idem)
        assert resp.status_code == 200, resp.text
        assert calls == [shipment_env["project_id"]]

    def test_project_404_preview(self, client, shipment_env, confirm_memory_store):
        headers = dict(shipment_env["headers"])
        headers["Idempotency-Key"] = f"idem-{uuid.uuid4().hex[:12]}"
        resp = client.put(
            "/api/v1/agent/projects/999999/replenishment-analysis/settings/X-001",
            json=_SETTING_BODY,
            headers=headers,
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_business_scope_out_of_scope_write(
        self, client, shipment_env, make_api_key, confirm_memory_store
    ):
        key = make_api_key(
            agent_id=shipment_env["agent_id"],
            business_scope="shipments",
        )
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": shipment_env["agent_id"],
            "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}",
        }
        resp = client.put(
            _url(shipment_env, "/settings/X-001"),
            json=_SETTING_BODY,
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
