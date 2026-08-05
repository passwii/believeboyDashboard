"""Agent 店铺测算试算路由测试（BLF-442 spec §7：C1）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models import PricingCalculationRun

from conftest import shop_calc_body


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis。"""
    from app.api.agent.confirm import InMemoryConfirmStore, set_confirm_store

    set_confirm_store(InMemoryConfirmStore())
    try:
        yield
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """clear 内存写桶：W1 落库用例需要（slowapi 状态按进程共享）。"""
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/shop-calculations{suffix}"


def _profit_body(**overrides) -> dict:
    body = {
        "mode": "profit_calc",
        "country": "US",
        "product_name": "test product",
        "sku": "X-001",
        "package_length_cm": 10.0,
        "package_width_cm": 8.0,
        "package_height_cm": 5.0,
        "weight_kg": 0.5,
        "fob_product_cost_rmb": 20.0,
        "first_leg_cost_rmb": 5.0,
        "sale_price_usd": 19.99,
        "advertising_rate": 0.12,
        "return_loss_rate": 0.04,
        "storage_months": 1.0,
        "usd_to_rmb_rate": 7.2,
    }
    body.update(overrides)
    return body


def _eu_body(**overrides) -> dict:
    body = {
        "mode": "eu_accounting",
        "country": "DE",
        "product_name": "test eu product",
        "sku": "X-001",
        "package_length_cm": 10.0,
        "package_width_cm": 8.0,
        "package_height_cm": 5.0,
        "weight_kg": 0.5,
        "fob_product_cost_rmb": 20.0,
        "first_leg_cost_rmb": 5.0,
        "sale_price_usd": 29.99,
        "delivery_fee_usd": 4.0,
        "inbound_config_fee_usd": 1.0,
        "storage_fee_usd": 0.5,
        "usd_to_rmb_rate": 7.8,
    }
    body.update(overrides)
    return body


def _count_runs(db) -> int:
    return db.query(PricingCalculationRun).count()


class TestComputeProfitCalc:
    def test_profit_calc_returns_calculation_and_snapshot(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["mode"] == "profit_calc"
        calc = data["calculation"]
        assert calc["calculation_type"] == "profit_calc"
        assert calc["id"] == 0, "试算不落库，id 为占位 0"
        assert calc["size_tier"]
        assert calc["profit"]["profit_rate"] is not None
        assert "dimensions" in calc and "weights" in calc and "fees" in calc

        snapshot = data["snapshot"]
        assert snapshot["source"] is None, (
            "快照 source 留占位，agent 填写后直接 POST W1"
        )
        assert snapshot["observed_at"] is None
        assert snapshot["sku"] == "X-001"
        assert snapshot["country"] == "US"
        assert snapshot["accounting_type"] == "profit_calc"
        assert snapshot["profit_rate"] == calc["profit"]["profit_rate"]
        assert snapshot["ddp_cost_rmb"] == calc["profit"]["ddp_cost_rmb"]
        assert data["usd_to_rmb_rate"] == 7.2
        assert data["usd_to_rmb_rate_source"] == "manual"

    def test_compute_does_not_persist_run(self, client, shipment_env):
        db = SessionLocal()
        try:
            before = _count_runs(db)
        finally:
            db.close()
        for _ in range(2):
            resp = client.post(
                _url(shipment_env, "/compute"),
                json=_profit_body(),
                headers=shipment_env["headers"],
            )
            assert resp.status_code == 200
        db = SessionLocal()
        try:
            assert _count_runs(db) == before, (
                "C1 纯计算，不得落 pricing_calculation_run"
            )
        finally:
            db.close()

    def test_engine_value_error_maps_to_400(self, client, shipment_env, monkeypatch):
        import app.api.v1.endpoints.agent.shop_calculations as route_module

        def _boom(payload, db):
            raise ValueError("缺少 USD 汇率，请先维护汇率信息")

        monkeypatch.setattr(route_module, "_compute_pricing", _boom)
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "VALIDATION_FAILED"
        assert err["details"][0]["engine"] == "缺少 USD 汇率，请先维护汇率信息"


class TestComputeEuAccounting:
    def test_eu_accounting_returns_eu_snapshot(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_eu_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["mode"] == "eu_accounting"
        calc = data["calculation"]
        assert calc["calculation_type"] == "eu_accounting"
        assert calc["profit"]["vat_usd"] > 0, "DE 19% VAT 应计入"

        snapshot = data["snapshot"]
        assert snapshot["accounting_type"] == "eu_accounting"
        assert snapshot["country"] == "DE"
        assert snapshot["delivery_fee_usd"] == 4.0
        assert snapshot["inbound_config_fee_manual_usd"] == 1.0
        assert snapshot["storage_fee_manual_usd"] == 0.5
        assert snapshot["vat_usd"] > 0
        assert snapshot["profit_after_vat_usd"] is not None

    def test_eu_country_mismatch_rejected(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_eu_body(country="US"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_profit_mode_country_mismatch_rejected(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_profit_body(country="DE"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestSnapshotAppendCompatible:
    def test_snapshot_can_be_appended_via_w1(
        self, client, shipment_env, confirm_memory_store
    ):
        """D3：/compute 快照 + source 即可走 W1 confirm 落库（零字段映射）。"""
        compute = client.post(
            _url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        )
        assert compute.status_code == 200, compute.text
        snapshot = compute.json()["data"]["snapshot"]

        # W1 预览（用快照字段 + source；idempotency 由 confirm 流程管理）
        append_body = {**snapshot, "source": "agent_listing_pull"}
        assert set(shop_calc_body().keys()) - set(append_body.keys()) <= {"source"}, (
            "快照字段应覆盖 W1 请求体（source 除外）"
        )

        headers = dict(shipment_env["headers"])
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        headers["Idempotency-Key"] = idem
        preview = client.post(_url(shipment_env), json=append_body, headers=headers)
        assert preview.status_code == 200, preview.text
        assert preview.json()["requires_confirmation"] is True

        replay_headers = {**headers, "X-Confirm-Token": preview.json()["confirm_token"]}
        replay = client.post(
            _url(shipment_env), json=append_body, headers=replay_headers
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["sale_price_usd"] == snapshot["sale_price_usd"]
        assert data["source"] == "agent_listing_pull"
