"""内部定价快照明细接口的定价派生块 ``anchor`` 回归（BLF-1043）。

背景（review 第 1 次 @-back 的阻塞项）：``pricing_calculation_snapshot_service
._snapshot_item_to_dto`` 之前只映射既有字段、没挂 ``anchor``，于是两个**内部**
端点响应里看不到锚 —— agent R7（``/pricing-snapshots``）走的是另一条 BI 扁平化
路径，覆盖不到它们。

本文件锁定这两个内部端点：
* ``GET /api/v1/pricing-calculation-snapshots/{snapshot_id}``（详情，含 items）
* ``GET /api/v1/pricing-calculation-snapshots/{snapshot_id}/items``（前端回放）

断言它们与 agent R7 扁平行**同口径**（同一个 ``pricing.anchor`` helper、同一份
费用拆项），且覆盖 US 锚值与 EU（含 VAT）明细口径。

数值口径（seeded 行，全部 2 位金额 / 4 位比率，与 tests/api/agent 的
``SHOP_CALC_BASE`` 对齐）：

* US：total_fee 10.20 / advertising_fee 2.40 / ddp 4.20 / sale 19.99 →
  non_ad_fee 7.80、锚 = 1 − (7.80 + 4.20) / 19.99 = 0.3997、max_ad_spend 7.99
* EU（DE，含 VAT）：total_fee 9.25 / advertising_fee 2.00 / ddp 5.00 / sale 24.99 /
  vat 4.75 → non_ad_fee 7.25、锚 = 1 − (7.25 + 5.00) / 24.99 = 0.5098、
  含 VAT 锚 = 1 − (7.25 + 5.00 + 4.75) / 24.99 = 0.3197、max_ad_spend 12.74
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.pricing_calculation_snapshot import (
    PricingCalculationSnapshot,
    PricingCalculationSnapshotItem,
)
from app.models.shop_calculation import ShopCalculation
from app.schemas.shop_calculation import ShopCalculationCreateRequest
from app.services import (
    pricing_calculation_snapshot_service,
    shop_calculation_service,
)

# US：1 − (7.80 + 4.20) / 19.99
US_ANCHOR = 0.3997
US_NON_AD_FEE = 7.80
US_MAX_AD_SPEND = 7.99
US_ADVERTISING_RATE = 0.12
US_PROFIT_RATE = 0.2796

# EU：1 − (7.25 + 5.00) / 24.99；含 VAT：1 − (7.25 + 5.00 + 4.75) / 24.99
EU_ANCHOR = 0.5098
EU_ANCHOR_AFTER_VAT = 0.3197
EU_NON_AD_FEE = 7.25
EU_MAX_AD_SPEND = 12.74
EU_ADVERTISING_RATE = 0.08
EU_PROFIT_RATE = 0.4298
EU_PROFIT_RATE_AFTER_VAT = 0.2397

# 与 tests/api/agent/conftest.py SHOP_CALC_BASE 同值（total_fee 10.20 含退货损失）
_BASE = {
    "country": "US",
    "accounting_type": "profit_calc",
    "asin": "ASIN-X-001",
    "package_length_cm": 10.0,
    "package_width_cm": 8.0,
    "package_height_cm": 5.0,
    "weight_kg": 0.5,
    "fob_product_cost_rmb": 20.0,
    "first_leg_cost_rmb": 5.0,
    "ddp_cost_rmb": 30.0,
    "ddp_cost_usd": 4.2,
    "sale_price_usd": 19.99,
    "advertising_rate": 0.12,
    "return_loss_rate": 0.04,
    "storage_months": 1.0,
    "inbound_placement_mode": "single_destination",
    "usd_to_rmb_rate": 7.2,
    "usd_to_rmb_rate_source": "test",
    "size_tier": "standard",
    "size_tier_label": "标准尺寸",
    "price_band": "15_25",
    "price_band_label": "$15-25",
    "longest_side_in": 4.0,
    "middle_side_in": 3.0,
    "shortest_side_in": 2.0,
    "length_plus_girth_in": 14.0,
    "volume_cubic_in": 24.0,
    "volume_cubic_ft": 0.014,
    "product_weight_lb": 1.0,
    "product_weight_oz": 16.0,
    "dimensional_weight_lb": 0.8,
    "chargeable_weight_lb": 1.0,
    "chargeable_weight_oz": 16.0,
    "chargeable_weight_rule": "actual",
    "fulfillment_fee_rule_label": "rule",
    "inbound_config_fee_rule_label": "rule",
    "storage_fee_rule_label": "rule",
    "referral_fee_usd": 3.0,
    "advertising_fee_usd": 2.4,
    "return_loss_usd": 0.8,
    "fba_fulfillment_fee_usd": 3.5,
    "inbound_config_fee_usd": 0.3,
    "storage_fee_usd": 0.2,
    "total_fee_usd": 10.2,
    "payout_usd": 9.79,
    "profit_usd": 5.59,
    "profit_rate": 0.2796,
}

# EU 行：把 EU 三笔手动费写进 total_fee（引擎以 fba/inbound/storage 为别名回填），
# platform_fee 是 referral_fee 的别名（不进 total_fee）
_EU_OVERRIDES = {
    "country": "DE",
    "accounting_type": "eu_accounting",
    "sale_price_usd": 24.99,
    "advertising_rate": 0.08,
    "ddp_cost_rmb": 35.0,
    "ddp_cost_usd": 5.0,
    "usd_to_rmb_rate": 7.8,
    "referral_fee_usd": 3.75,
    "advertising_fee_usd": 2.0,
    "fba_fulfillment_fee_usd": 2.0,
    "inbound_config_fee_usd": 1.0,
    "storage_fee_usd": 0.5,
    "total_fee_usd": 9.25,
    "delivery_fee_usd": 2.0,
    "inbound_config_fee_manual_usd": 1.0,
    "storage_fee_manual_usd": 0.5,
    "platform_fee_usd": 3.75,
    "payout_usd": 15.74,
    "profit_usd": 10.74,
    "profit_rate": 0.4298,
    "vat_usd": 4.75,
    "profit_after_vat_usd": 5.99,
    "profit_after_vat_rate": 0.2397,
}


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def snapshot_env():
    """建「项目 + shop_calculation 当前态行 + 定价快照」并返回 id（测后清理）。

    快照走 ``create_snapshot``（与生产同路径），所以明细行是服务端复制的副本，
    与 agent R7 读到的完全是同一批行。
    """
    created: list[tuple[int, int]] = []

    def _make(*, sku: str = "X-001", **overrides) -> dict:
        suffix = uuid.uuid4().hex[:8]
        project_name = f"blf1043-snap-{suffix}"
        db = SessionLocal()
        try:
            project = Project(
                project_name=project_name,
                project_operator="pytest",
                assistant_operator=None,
                sort_order=0,
                is_active=True,
            )
            db.add(project)
            db.commit()
            db.refresh(project)

            payload = ShopCalculationCreateRequest(
                project_id=project.id,
                project_name=project_name,
                sku=sku,
                source="manual",
                **{**_BASE, **overrides},
            )
            shop_calculation_service.append_calculation(db, payload, operator="pytest")
            db.commit()

            country = payload.country
            snapshot = pricing_calculation_snapshot_service.create_snapshot(
                db,
                project_id=project.id,
                country=country,
                name="anchor-test",
                description=None,
                operator="pytest",
            )
            db.commit()
            db.refresh(snapshot)
            created.append((project.id, snapshot.id))
            return {
                "project_id": project.id,
                "project_name": project_name,
                "country": country,
                "snapshot_id": snapshot.id,
                "snapshot_date": snapshot.snapshot_date.date().isoformat(),
            }
        finally:
            db.close()

    yield _make

    db = SessionLocal()
    try:
        for project_id, snapshot_id in created:
            db.execute(
                delete(PricingCalculationSnapshotItem).where(
                    PricingCalculationSnapshotItem.snapshot_id == snapshot_id
                )
            )
            db.execute(
                delete(PricingCalculationSnapshot).where(
                    PricingCalculationSnapshot.id == snapshot_id
                )
            )
            db.execute(
                delete(ShopCalculation).where(ShopCalculation.project_id == project_id)
            )
            obj = db.get(Project, project_id)
            if obj is not None:
                db.delete(obj)
        db.commit()
    finally:
        db.close()


def _internal_headers() -> dict:
    return {"X-API-Key": get_settings().api_key}


def _identity_tolerance(sale_price: float) -> float:
    """恒等式容差 = 舍入地板：0.01（金额 2 位）/ price + 1e-4（比率 4 位）。"""
    return 0.01 / sale_price + 0.0001


def _detail(client: TestClient, snapshot_id: int) -> dict:
    resp = client.get(
        f"/api/v1/pricing-calculation-snapshots/{snapshot_id}",
        headers=_internal_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _items(client: TestClient, snapshot_id: int) -> dict:
    resp = client.get(
        f"/api/v1/pricing-calculation-snapshots/{snapshot_id}/items",
        headers=_internal_headers(),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _agent_rows(client: TestClient, env: dict, key: dict) -> list[dict]:
    """agent R7（``/pricing-snapshots``）扁平行 —— 同口径基准。"""
    resp = client.get(
        f"/api/v1/agent/projects/{env['project_id']}/pricing-snapshots"
        f"?country={env['country']}",
        headers={
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": key["agent_id"],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["data"]


class TestInternalSnapshotDetailAnchor:
    """内部明细接口必须真正挂上 ``anchor``（不是 schema 里的 null 兜底）。"""

    def test_detail_endpoint_mounts_us_anchor(self, client, snapshot_env):
        env = snapshot_env(sku="X-US")
        item = _detail(client, env["snapshot_id"])["items"][0]
        anchor = item["anchor"]
        assert anchor["breakeven_advertising_rate"] == US_ANCHOR
        assert anchor["non_ad_fee_usd"] == US_NON_AD_FEE
        assert anchor["max_ad_spend_per_unit_usd"] == US_MAX_AD_SPEND
        assert anchor["breakeven_advertising_rate_after_vat"] is None, "US 无 VAT"
        assert anchor["target_net_margin"] is None
        assert anchor["target_advertising_rate"] is None
        assert anchor["basis"]["usd_to_rmb_rate"] == 7.2
        assert anchor["basis"]["usd_to_rmb_rate_source"] == "test"
        assert anchor["basis"]["observed_at"] is not None, (
            "锚必须和它依据的观测时刻一起返回（快照回放无独立 observed_at，"
            "用明细行 created_at 兜底）"
        )
        # 恒等式自检：breakeven ≡ advertising_rate + profit_rate
        # （两侧都是引擎舍入值，容差取舍入地板 0.01 / price + 1e-4）
        assert item["advertising_rate"] == US_ADVERTISING_RATE
        assert item["profit"]["profit_rate"] == US_PROFIT_RATE
        assert abs(
            anchor["breakeven_advertising_rate"]
            - (item["advertising_rate"] + item["profit"]["profit_rate"])
        ) <= _identity_tolerance(item["sale_price_usd"])

    def test_items_endpoint_mounts_us_anchor(self, client, snapshot_env):
        env = snapshot_env(sku="X-US-ITEMS")
        item = _items(client, env["snapshot_id"])["items"][0]
        anchor = item["anchor"]
        assert anchor["breakeven_advertising_rate"] == US_ANCHOR
        assert anchor["non_ad_fee_usd"] == US_NON_AD_FEE
        assert anchor["max_ad_spend_per_unit_usd"] == US_MAX_AD_SPEND
        assert anchor["breakeven_advertising_rate_after_vat"] is None
        assert anchor["target_advertising_rate"] is None

    def test_internal_endpoints_match_agent_r7_flat_columns(
        self, client, snapshot_env, make_api_key
    ):
        """两条内部路径 + agent R7 扁平行必须逐字段同口径（同一个 helper）。"""
        env = snapshot_env(sku="X-US-PARITY")
        key = make_api_key(agent_id=f"blf1043-{uuid.uuid4().hex[:8]}")

        detail_anchor = _detail(client, env["snapshot_id"])["items"][0]["anchor"]
        items_anchor = _items(client, env["snapshot_id"])["items"][0]["anchor"]
        agent_row = _agent_rows(client, env, key)[0]

        assert detail_anchor == items_anchor
        assert (
            detail_anchor["breakeven_advertising_rate"]
            == agent_row["breakeven_advertising_rate"]
            == US_ANCHOR
        )
        assert (
            detail_anchor["max_ad_spend_per_unit_usd"]
            == agent_row["max_ad_spend_per_unit_usd"]
            == US_MAX_AD_SPEND
        )
        assert detail_anchor["non_ad_fee_usd"] == US_NON_AD_FEE

    def test_detail_endpoint_keeps_null_anchor_when_sale_price_is_zero(
        self, client, snapshot_env
    ):
        """边界：``sale_price_usd == 0`` → 锚为 null（不是 0，0 会被读成「一分不能花」）。"""
        env = snapshot_env(sku="X-US-ZERO", sale_price_usd=0.0)
        anchor = _detail(client, env["snapshot_id"])["items"][0]["anchor"]
        assert anchor is not None, "块本身要返回（消费方按块存在与否判断口径）"
        assert anchor["breakeven_advertising_rate"] is None
        assert anchor["max_ad_spend_per_unit_usd"] is None
        assert anchor["non_ad_fee_usd"] == US_NON_AD_FEE


class TestInternalSnapshotDetailAnchorEu:
    """EU 明细口径：含 VAT 锚必须带实数，且与行上 profit_after_vat_rate 同族。"""

    def test_eu_detail_and_items_expose_after_vat_anchor(self, client, snapshot_env):
        env = snapshot_env(sku="X-EU", **_EU_OVERRIDES)
        assert env["country"] == "DE"

        detail_anchor = _detail(client, env["snapshot_id"])["items"][0]["anchor"]
        items_anchor = _items(client, env["snapshot_id"])["items"][0]["anchor"]

        for anchor in (detail_anchor, items_anchor):
            # 不含 VAT 锚：EU 三笔手动费已在 total_fee 内、platform_fee 不再加一次
            assert anchor["breakeven_advertising_rate"] == EU_ANCHOR
            assert anchor["non_ad_fee_usd"] == EU_NON_AD_FEE
            assert anchor["max_ad_spend_per_unit_usd"] == EU_MAX_AD_SPEND
            # 含 VAT 锚：比不含 VAT 锚低 vat / sale_price = 4.75 / 24.99
            assert anchor["breakeven_advertising_rate_after_vat"] == EU_ANCHOR_AFTER_VAT
            assert anchor["basis"]["usd_to_rmb_rate"] == 7.8

        # 恒等式自检（EU 侧同族）：含 VAT 锚 ≡ advertising_rate + profit_after_vat_rate
        detail_item = _detail(client, env["snapshot_id"])["items"][0]
        assert detail_item["advertising_rate"] == EU_ADVERTISING_RATE
        assert abs(
            detail_anchor["breakeven_advertising_rate"]
            - (detail_item["advertising_rate"] + EU_PROFIT_RATE)
        ) <= _identity_tolerance(detail_item["sale_price_usd"])
        assert abs(
            detail_anchor["breakeven_advertising_rate_after_vat"]
            - (detail_item["advertising_rate"] + EU_PROFIT_RATE_AFTER_VAT)
        ) <= _identity_tolerance(detail_item["sale_price_usd"])
        assert (
            detail_item["profit"]["profit_after_vat_rate"] == EU_PROFIT_RATE_AFTER_VAT
        )

    def test_eu_anchor_matches_agent_r7_flat_columns(
        self, client, snapshot_env, make_api_key
    ):
        env = snapshot_env(sku="X-EU-PARITY", **_EU_OVERRIDES)
        key = make_api_key(agent_id=f"blf1043-eu-{uuid.uuid4().hex[:8]}")

        detail_item = _detail(client, env["snapshot_id"])["items"][0]
        detail_anchor = detail_item["anchor"]
        agent_row = _agent_rows(client, env, key)[0]

        assert agent_row["sku"] == "X-EU-PARITY"
        assert (
            detail_anchor["breakeven_advertising_rate"]
            == agent_row["breakeven_advertising_rate"]
            == EU_ANCHOR
        )
        assert (
            detail_anchor["max_ad_spend_per_unit_usd"]
            == agent_row["max_ad_spend_per_unit_usd"]
            == EU_MAX_AD_SPEND
        )
        assert (
            detail_anchor["breakeven_advertising_rate_after_vat"] == EU_ANCHOR_AFTER_VAT
        )
        # BI 扁平行本身不带 after_vat 列（列契约只到 breakeven / max_ad_spend）
        assert "breakeven_advertising_rate_after_vat" not in agent_row
