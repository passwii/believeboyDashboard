"""Agent 新品测算试算路由测试（BLF-451 spec §10：C1 四模式 + 不落库 + 400 壳）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models import PricingCalculationRun
from app.models.new_product_calculation import NewProductCalculation

from conftest import new_product_body


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
    return (
        f"/api/v1/agent/projects/{env['project_id']}/new-product-calculations{suffix}"
    )


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
        "usd_to_rmb_rate": 7.2,
    }
    body.update(overrides)
    return body


def _reverse_body(**overrides) -> dict:
    body = {
        "mode": "profit_reverse",
        "country": "US",
        "product_name": "test product",
        "sku": "X-001",
        "package_length_cm": 10.0,
        "package_width_cm": 8.0,
        "package_height_cm": 5.0,
        "weight_kg": 0.5,
        "fob_product_cost_rmb": 20.0,
        "first_leg_cost_rmb": 5.0,
        "target_profit_rate": 0.25,
        "usd_to_rmb_rate": 7.2,
    }
    body.update(overrides)
    return body


def _cost_reverse_body(**overrides) -> dict:
    body = {
        "mode": "cost_reverse",
        "country": "US",
        "product_name": "test product",
        "sku": "X-001",
        "package_length_cm": 10.0,
        "package_width_cm": 8.0,
        "package_height_cm": 5.0,
        "weight_kg": 0.5,
        "first_leg_cost_rmb": 5.0,
        "sale_price_usd": 19.99,
        "target_profit_rate": 0.25,
        "usd_to_rmb_rate": 7.2,
    }
    body.update(overrides)
    return body


def _fbm_body(**overrides) -> dict:
    body = {
        "mode": "fbm_calc",
        "country": "US",
        "product_name": "test product",
        "sku": "X-001",
        "package_length_cm": 10.0,
        "package_width_cm": 8.0,
        "package_height_cm": 5.0,
        "weight_kg": 0.5,
        "fob_product_cost_rmb": 20.0,
        "sale_price_usd": 19.99,
        "full_container_quantity": 5000.0,
        "full_container_price_rmb": 80000.0,
        "delivery_fee_usd": 2.0,
        "usd_to_rmb_rate": 7.2,
    }
    body.update(overrides)
    return body


def _count_runs(db) -> int:
    return db.query(PricingCalculationRun).count()


def _count_snapshots(db, project_id: int) -> int:
    return (
        db.query(NewProductCalculation)
        .filter(NewProductCalculation.project_id == project_id)
        .count()
    )


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
        assert snapshot["calculation_type"] == "profit_calc"
        assert snapshot["profit_rate"] == calc["profit"]["profit_rate"]
        assert snapshot["ddp_cost_rmb"] == calc["profit"]["ddp_cost_rmb"]
        assert data["usd_to_rmb_rate"] == 7.2
        assert data["usd_to_rmb_rate_source"] == "manual"

    def test_compute_does_not_persist_anything(self, client, shipment_env):
        db = SessionLocal()
        try:
            runs_before = _count_runs(db)
            snapshots_before = _count_snapshots(db, shipment_env["project_id"])
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
            assert _count_runs(db) == runs_before, "C1 不落 pricing_calculation_run"
            assert (
                _count_snapshots(db, shipment_env["project_id"]) == snapshots_before
            ), "C1 不落 new_product_calculations"
        finally:
            db.close()

    def test_engine_value_error_maps_to_400(self, client, shipment_env, monkeypatch):
        import app.api.v1.endpoints.agent.new_product_calculations as route_module

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


class TestComputeProfitReverse:
    def test_reverse_returns_suggested_price(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_reverse_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["mode"] == "profit_reverse"
        calc = data["calculation"]
        assert calc["calculation_type"] == "profit_reverse"
        assert calc["sale_price_usd"] > 0, "倒算输出建议售价"
        assert calc["profit"]["profit_rate"] >= 0.25

        snapshot = data["snapshot"]
        assert snapshot["calculation_type"] == "profit_reverse"
        assert snapshot["sale_price_usd"] == calc["sale_price_usd"]
        assert snapshot["target_profit_rate"] == 0.25
        assert snapshot["source"] is None

    def test_reverse_with_sale_price_rejected(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_reverse_body(sale_price_usd=19.99),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestComputeCostReverse:
    def test_cost_reverse_returns_max_fob_cost(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_cost_reverse_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["mode"] == "cost_reverse"
        calc = data["calculation"]
        assert calc["calculation_type"] == "cost_reverse"
        assert calc["fob_product_cost_rmb"] > 0, "成本倒推输出最大可接受 FOB 成本"

        snapshot = data["snapshot"]
        assert snapshot["calculation_type"] == "cost_reverse"
        assert snapshot["fob_product_cost_rmb"] == calc["fob_product_cost_rmb"]
        assert snapshot["sale_price_usd"] == 19.99

    def test_cost_reverse_with_fob_cost_rejected(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_cost_reverse_body(fob_product_cost_rmb=20.0),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestComputeFbmCalc:
    def test_fbm_calc_returns_fbm_snapshot(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_fbm_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["mode"] == "fbm_calc"
        calc = data["calculation"]
        assert calc["calculation_type"] == "fbm_calc"
        assert calc["full_container_quantity"] == 5000.0
        assert calc["full_container_price_rmb"] == 80000.0
        assert calc["delivery_fee_usd"] == 2.0
        assert calc["fees"]["fba_fulfillment_fee_usd"] == 0, "FBM 无 FBA 履约费"

        snapshot = data["snapshot"]
        assert snapshot["calculation_type"] == "fbm_calc"
        assert snapshot["delivery_fee_usd"] == 2.0

    def test_fbm_requires_container_fields(self, client, shipment_env):
        resp = client.post(
            _url(shipment_env, "/compute"),
            json=_fbm_body(full_container_quantity=None),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestSnapshotW1Compatible:
    def test_snapshot_can_be_upserted_via_w1(
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

        # W1 预览（用快照字段 + source）
        upsert_body = {**snapshot, "source": "agent_listing_pull"}
        assert set(new_product_body().keys()) - set(upsert_body.keys()) <= {"source"}, (
            "快照字段应覆盖 W1 请求体（source 除外）"
        )

        headers = dict(shipment_env["headers"])
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        headers["Idempotency-Key"] = idem
        preview = client.post(_url(shipment_env), json=upsert_body, headers=headers)
        assert preview.status_code == 200, preview.text
        assert preview.json()["requires_confirmation"] is True

        replay_headers = {**headers, "X-Confirm-Token": preview.json()["confirm_token"]}
        replay = client.post(
            _url(shipment_env), json=upsert_body, headers=replay_headers
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["sale_price_usd"] == snapshot["sale_price_usd"]
        assert data["source"] == "agent_listing_pull"
