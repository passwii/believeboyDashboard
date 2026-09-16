"""BLF-1043 定价派生块 ``anchor`` 的 agent 路由测试。

覆盖运营侧实际消费的端点：
* R1/R2/R3 富契约（含 ``include_anchor=false`` 的 parity 与 ``target_net_margin``）；
* W1 confirm 预览（写前就能看到锚）；
* C1 试算（US / EU + ``target_net_margin`` + 反喂闭环）；
* R5/R6 BI 扁平契约的显式派生列（**这是运营实际在用的端点，优先级最高**）；
* R7 定价快照；
* 新品测算域（C1 反算 + R1 读）复用同一 helper。

数值口径：seeded 行的 ``total_fee_usd=10.2 / advertising_fee_usd=2.4 /
ddp_cost_usd=4.2 / sale_price_usd=19.99`` →
``non_ad_fee = 7.8``、``breakeven = 1 − (7.8 + 4.2) / 19.99 = 0.3997``。
"""

from __future__ import annotations

import uuid

import pytest
from conftest import seed_new_product_calculation, seed_shop_calculation, shop_calc_body
from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.services import pricing_calculation_snapshot_service

BASE_BREAKEVEN = 0.3997
BASE_NON_AD_FEE = 7.8
BASE_MAX_AD_SPEND = 7.99
FLAT_ANCHOR_FIELDS = {
    "breakeven_advertising_rate",
    "non_ad_fee_usd",
    "max_ad_spend_per_unit_usd",
    "target_advertising_rate",
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _shop_url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/shop-calculations{suffix}"


def _profit_body(**overrides) -> dict:
    body = {
        "mode": "profit_calc",
        "country": "US",
        "product_name": "anchor product",
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
        "product_name": "anchor eu product",
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


def _identity_tolerance(sale_price: float) -> float:
    """0.01（付款侧 2 位金额舍入）/ price + 1e-4（比率 4 位舍入）。"""
    return 0.01 / sale_price + 0.0001


class TestRichContract:
    """R1 / R2 / R3：读取时派生，不落库、零迁移。"""

    def test_r1_returns_anchor_block(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        resp = client.get(_shop_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        item = resp.json()["data"]["items"][0]
        anchor = item["anchor"]
        assert anchor["breakeven_advertising_rate"] == BASE_BREAKEVEN
        assert anchor["non_ad_fee_usd"] == BASE_NON_AD_FEE
        assert anchor["max_ad_spend_per_unit_usd"] == BASE_MAX_AD_SPEND
        assert anchor["breakeven_advertising_rate_after_vat"] is None, "US 无 VAT"
        assert anchor["target_net_margin"] is None
        assert anchor["target_advertising_rate"] is None
        assert anchor["basis"]["usd_to_rmb_rate"] == 7.2
        assert anchor["basis"]["usd_to_rmb_rate_source"] == "test"
        assert anchor["basis"]["observed_at"] is not None, (
            "锚必须和它依据的观测时刻一起返回"
        )

    def test_r1_include_anchor_false_is_byte_identical_to_old_shape(
        self, client, shipment_env
    ):
        """parity：关掉 anchor 后响应与旧版一致（键都要消失，不是置 null）。"""
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        with_anchor = client.get(
            _shop_url(shipment_env), headers=shipment_env["headers"]
        ).json()["data"]
        without = client.get(
            _shop_url(shipment_env) + "?include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]

        assert "anchor" not in without["items"][0]
        assert without["items"][0] == {
            k: v for k, v in with_anchor["items"][0].items() if k != "anchor"
        }, "除 anchor 外必须逐字段一致"
        assert without["total"] == with_anchor["total"]

    def test_r1_target_net_margin_drives_target_advertising_rate(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        item = client.get(
            _shop_url(shipment_env) + "?target_net_margin=0.1",
            headers=shipment_env["headers"],
        ).json()["data"]["items"][0]
        assert item["anchor"]["target_net_margin"] == 0.1
        assert item["anchor"]["target_advertising_rate"] == 0.2997

    def test_r1_negative_target_margin_allowed_for_clearance(
        self, client, shipment_env
    ):
        """清库存档允许亏：目标净利率 −10pt 必须放行（校验是 ge=-1 而非 ge=0）。"""
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        resp = client.get(
            _shop_url(shipment_env) + "?target_net_margin=-0.1",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        anchor = resp.json()["data"]["items"][0]["anchor"]
        assert anchor["target_net_margin"] == -0.1
        assert anchor["target_advertising_rate"] == 0.4997

    @pytest.mark.parametrize("bad", ["1.5", "-1.5"])
    def test_r1_target_margin_out_of_range_rejected(self, client, shipment_env, bad):
        """越界参数走 agent 壳的 VALIDATION_FAILED（400，不是原生 422）。"""
        resp = client.get(
            _shop_url(shipment_env) + f"?target_net_margin={bad}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_r2_sku_detail_returns_anchor(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        body = client.get(
            _shop_url(shipment_env, "/skus/X-001"),
            headers=shipment_env["headers"],
        ).json()["data"]
        assert body["anchor"]["breakeven_advertising_rate"] == BASE_BREAKEVEN

        stripped = client.get(
            _shop_url(shipment_env, "/skus/X-001") + "?include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]
        assert "anchor" not in stripped

        targeted = client.get(
            _shop_url(shipment_env, "/skus/X-001") + "?target_net_margin=0.1",
            headers=shipment_env["headers"],
        ).json()["data"]
        assert targeted["anchor"]["target_advertising_rate"] == 0.2997

    def test_r3_history_returns_anchor(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        items = client.get(
            _shop_url(shipment_env, "/skus/X-001/history"),
            headers=shipment_env["headers"],
        ).json()["data"]["items"]
        assert items[0]["anchor"]["breakeven_advertising_rate"] == BASE_BREAKEVEN


class TestAppendPreview:
    def test_preview_carries_anchor(self, client, shipment_env, confirm_memory_store):
        body = shop_calc_body(sku="X-001", sale_price_usd=22.0, profit_usd=6.0)
        resp = client.post(
            _shop_url(shipment_env),
            json=body,
            headers={
                **shipment_env["headers"],
                "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}",
            },
        )
        assert resp.status_code == 200, resp.text
        preview = resp.json()["preview"]
        # 预览用的是请求体自带的拆项：non_ad = 10.2 − 2.4 = 7.8，price 由 body 给
        assert preview["anchor"]["breakeven_advertising_rate"] is not None
        assert preview["anchor"]["non_ad_fee_usd"] == BASE_NON_AD_FEE
        assert preview["anchor"]["target_net_margin"] is None


class TestCompute:
    def test_profit_calc_returns_anchor_in_both_payloads(self, client, shipment_env):
        resp = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        calc_anchor = data["calculation"]["anchor"]
        snap_anchor = data["snapshot"]["anchor"]
        assert calc_anchor == snap_anchor, "两个载荷的 anchor 必须同口径"
        assert calc_anchor["breakeven_advertising_rate"] is not None
        assert calc_anchor["breakeven_advertising_rate_after_vat"] is None, "US 无 VAT"
        # 试算不落库 → observed_at 无来源
        assert calc_anchor["basis"]["observed_at"] is None
        assert calc_anchor["basis"]["usd_to_rmb_rate"] == 7.2
        assert calc_anchor["basis"]["usd_to_rmb_rate_source"] == "manual"

    def test_identity_holds_on_engine_output(self, client, shipment_env):
        data = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        ).json()["data"]
        anchor = data["calculation"]["anchor"]
        profit_rate = data["calculation"]["profit"]["profit_rate"]
        advertising_rate = data["calculation"]["advertising_rate"]
        residual = abs(
            anchor["breakeven_advertising_rate"] - (advertising_rate + profit_rate)
        )
        assert residual <= _identity_tolerance(19.99)

    def test_feeding_breakeven_back_zeroes_profit(self, client, shipment_env):
        """闭环：把锚喂回同一 payload（**同一 fx**）→ 利润归零。"""
        first = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_profit_body(),
            headers=shipment_env["headers"],
        ).json()["data"]
        breakeven = first["calculation"]["anchor"]["breakeven_advertising_rate"]

        replay = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_profit_body(advertising_rate=breakeven),
            headers=shipment_env["headers"],
        ).json()["data"]
        assert abs(replay["calculation"]["profit"]["profit_rate"]) <= 0.0002

    def test_target_net_margin_returns_target_advertising_rate(
        self, client, shipment_env
    ):
        data = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_profit_body(target_net_margin=0.10),
            headers=shipment_env["headers"],
        ).json()["data"]
        anchor = data["calculation"]["anchor"]
        assert anchor["target_net_margin"] == 0.1
        assert anchor["target_advertising_rate"] == round(
            anchor["breakeven_advertising_rate"] - 0.1, 4
        )

    def test_eu_mode_reports_after_vat_anchor(self, client, shipment_env):
        data = client.post(
            _shop_url(shipment_env, "/compute"),
            json=_eu_body(),
            headers=shipment_env["headers"],
        ).json()["data"]
        anchor = data["calculation"]["anchor"]
        assert anchor["breakeven_advertising_rate_after_vat"] is not None, "EU 有 VAT"
        assert (
            anchor["breakeven_advertising_rate_after_vat"]
            < anchor["breakeven_advertising_rate"]
        )
        assert (
            data["snapshot"]["anchor"]["breakeven_advertising_rate_after_vat"]
            is not None
        )


class TestBiFlatContract:
    """R5/R6：扁平行没有费用拆项 → 服务端必须显式补派生列。"""

    def test_flat_history_exposes_breakeven_column(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shop-calculation-history",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert row["breakeven_advertising_rate"] == BASE_BREAKEVEN
        assert row["non_ad_fee_usd"] == BASE_NON_AD_FEE
        assert row["max_ad_spend_per_unit_usd"] == BASE_MAX_AD_SPEND
        assert row["target_advertising_rate"] is None

    def test_flat_history_honours_target_net_margin(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation-history?target_net_margin=0.1",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert row["target_advertising_rate"] == 0.2997

    def test_flat_snapshots_carry_same_columns(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation/snapshots?sku=X-001",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert row["breakeven_advertising_rate"] == BASE_BREAKEVEN
        assert row["non_ad_fee_usd"] == BASE_NON_AD_FEE
        assert row["max_ad_spend_per_unit_usd"] == BASE_MAX_AD_SPEND

    def test_flat_history_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation-history?include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert FLAT_ANCHOR_FIELDS.isdisjoint(row)

    def test_flat_snapshots_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        row = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/shop-calculation/snapshots?sku=X-001&include_anchor=false",
            headers=shipment_env["headers"],
        ).json()["data"]["data"][0]
        assert FLAT_ANCHOR_FIELDS.isdisjoint(row)


class TestPricingSnapshot:
    def _seed_snapshot(self, env) -> tuple[int, str]:
        """返回 (snapshot_id, as_of)。

        ``snapshot_date`` 是 DB ``now()``（服务端时区），所以 ``as_of`` 从快照自身
        取值——硬写 ``date.today()`` 会在本地时区跟 DB 时区不一致时（如 CST 跨零点）
        变成「查询早于快照」而 404。
        """
        db = SessionLocal()
        try:
            snapshot = pricing_calculation_snapshot_service.create_snapshot(
                db,
                project_id=env["project_id"],
                country="US",
                name="anchor-test",
                description=None,
                operator="pytest",
            )
            db.commit()
            db.refresh(snapshot)
            return snapshot.id, snapshot.snapshot_date.date().isoformat()
        finally:
            db.close()

    def _cleanup(self, snapshot_id: int) -> None:
        db = SessionLocal()
        try:
            pricing_calculation_snapshot_service.delete_snapshot(db, snapshot_id)
        finally:
            db.close()

    def test_pricing_snapshot_exposes_breakeven_column(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        snapshot_id, as_of = self._seed_snapshot(shipment_env)
        base = f"/api/v1/agent/projects/{shipment_env['project_id']}/pricing-snapshots"
        try:
            resp = client.get(f"{base}?as_of={as_of}", headers=shipment_env["headers"])
            assert resp.status_code == 200, resp.text
            rows = resp.json()["data"]["data"]
            assert rows[0]["breakeven_advertising_rate"] == BASE_BREAKEVEN
            assert rows[0]["non_ad_fee_usd"] == BASE_NON_AD_FEE
            assert rows[0]["max_ad_spend_per_unit_usd"] == BASE_MAX_AD_SPEND

            targeted = client.get(
                f"{base}?as_of={as_of}&target_net_margin=0.1",
                headers=shipment_env["headers"],
            )
            assert targeted.status_code == 200, targeted.text
            assert (
                targeted.json()["data"]["data"][0]["target_advertising_rate"] == 0.2997
            )
        finally:
            self._cleanup(snapshot_id)

    def test_pricing_snapshot_include_anchor_false_omits_anchor_columns(
        self, client, shipment_env
    ):
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        snapshot_id, as_of = self._seed_snapshot(shipment_env)
        base = f"/api/v1/agent/projects/{shipment_env['project_id']}/pricing-snapshots"
        try:
            row = client.get(
                f"{base}?as_of={as_of}&include_anchor=false",
                headers=shipment_env["headers"],
            ).json()["data"]["data"][0]
            assert FLAT_ANCHOR_FIELDS.isdisjoint(row)
        finally:
            self._cleanup(snapshot_id)


class TestNewProductDomain:
    """新品域复用同一 helper：读侧用行上 target_profit_rate，试算侧接受同一目标。"""

    def test_read_item_carries_anchor_with_target_from_row(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            target_profit_rate=0.2,
        )
        items = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/new-product-calculations",
            headers=shipment_env["headers"],
        ).json()["data"]["items"]
        anchor = items[0]["anchor"]
        assert anchor["breakeven_advertising_rate"] == BASE_BREAKEVEN
        assert anchor["target_net_margin"] == 0.2
        assert anchor["target_advertising_rate"] == 0.1997

    def test_profit_reverse_target_advertising_rate_self_consistent(
        self, client, shipment_env
    ):
        """profit_reverse 解出售价后，锚反推出的目标广告费率应收束到输入的广告费率。"""
        data = client.post(
            f"/api/v1/agent/projects/{shipment_env['project_id']}"
            "/new-product-calculations/compute",
            json={
                "mode": "profit_reverse",
                "country": "US",
                "product_name": "anchor reverse",
                "sku": "X-001",
                "package_length_cm": 10.0,
                "package_width_cm": 8.0,
                "package_height_cm": 5.0,
                "weight_kg": 0.5,
                "fob_product_cost_rmb": 20.0,
                "first_leg_cost_rmb": 5.0,
                "target_profit_rate": 0.2,
                "advertising_rate": 0.12,
                "return_loss_rate": 0.04,
                "storage_months": 1.0,
                "usd_to_rmb_rate": 7.2,
            },
            headers=shipment_env["headers"],
        )
        assert data.status_code == 200, data.text
        anchor = data.json()["data"]["snapshot"]["anchor"]
        assert anchor["target_net_margin"] == 0.2
        assert anchor["target_advertising_rate"] is not None
        assert abs(anchor["target_advertising_rate"] - 0.12) <= 0.001, (
            "反算出的目标广告费率应收束到输入的 advertising_rate"
        )
