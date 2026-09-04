"""Agent 店铺测算审计路由测试（BLF-442 spec §7：R4 按 SKU 聚合多行 target_id）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.agent.confirm import InMemoryConfirmStore, set_confirm_store
from app.main import app

from conftest import seed_shop_calculation, shop_calc_body


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """clear 内存写桶：W1 落库用例需要。"""
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/shop-calculations{suffix}"


def _w1_append(client, env, *, sku="X-001", sale_price_usd=19.99) -> None:
    """走完整 W1 两步（预览 → 重放）落一行，产生一条 agent 审计行。"""
    body = shop_calc_body(sku=sku, sale_price_usd=sale_price_usd)
    headers = dict(env["headers"])
    idem = f"idem-{uuid.uuid4().hex[:12]}"
    headers["Idempotency-Key"] = idem
    preview = client.post(_url(env), json=body, headers=headers)
    assert preview.status_code == 200, preview.text
    replay = client.post(
        _url(env),
        json=body,
        headers={**headers, "X-Confirm-Token": preview.json()["confirm_token"]},
    )
    assert replay.status_code == 200, replay.text


class TestR4Audit:
    def test_aggregates_audit_rows_per_sku(
        self, client, shipment_env, confirm_memory_store
    ):
        # 同 SKU 两次 append → 两条审计行；另一 SKU 一次 → 一条
        _w1_append(client, shipment_env, sku="X-001", sale_price_usd=10.0)
        _w1_append(client, shipment_env, sku="X-001", sale_price_usd=12.0)
        _w1_append(client, shipment_env, sku="X-002", sale_price_usd=20.0)

        resp = client.get(
            _url(shipment_env, "/skus/X-001/audit"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["sku"] == "X-001"
        items = data["items"]
        assert len(items) == 2, "R4 按 SKU 聚合两行的审计轨迹"
        assert all(item["action"] == "shop_calculation.append" for item in items)
        assert all(item["agent_id"] == shipment_env["agent_id"] for item in items)
        assert all(item["operator"] is None for item in items)
        # id 倒序：最新一次 append 在前
        assert items[0]["id"] > items[1]["id"]
        # after 带 source / observed_at 快照
        assert items[0]["after"]["source"] == "agent_listing_pull"

    def test_audit_scoped_to_sku(self, client, shipment_env, confirm_memory_store):
        _w1_append(client, shipment_env, sku="X-001", sale_price_usd=10.0)
        _w1_append(client, shipment_env, sku="X-002", sale_price_usd=20.0)

        resp = client.get(
            _url(shipment_env, "/skus/X-002/audit"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200
        items = resp.json()["data"]["items"]
        assert len(items) == 1
        assert items[0]["after"]["sku"] == "X-002"

    def test_audit_limit(self, client, shipment_env, confirm_memory_store):
        for price in (10.0, 11.0, 12.0):
            _w1_append(client, shipment_env, sku="X-001", sale_price_usd=price)
        resp = client.get(
            _url(shipment_env, "/skus/X-001/audit?limit=2"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200
        assert len(resp.json()["data"]["items"]) == 2

    def test_seeded_rows_without_writes_return_empty_audit(self, client, shipment_env):
        """service 直落的行（不走 agent 写）没有审计行 → items 为空而非报错。"""
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        resp = client.get(
            _url(shipment_env, "/skus/X-001/audit"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["items"] == []

    def test_unknown_sku_404(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env, "/skus/X-999/audit"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
