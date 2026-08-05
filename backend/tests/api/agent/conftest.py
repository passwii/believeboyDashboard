"""Agent 货件域测试 fixture（P2）。

shipment_env：临时项目 + 2 个 SKU（X-001/X-002，US，装箱率 10）+ 一张 agent 凭据。
测试后按 items → schedules → skus → project 顺序清理（key 由 make_api_key 自清）。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.models import Project
from app.models.shop_calculation import ShopCalculation
from app.models.sku_info import SkuRecord
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import ShipmentScheduleCreate
from app.services import shipment as shipment_service
from app.services.shipment.item import replace_shipment_schedule_items


# 店铺测算（BLF-442）测试基座：与 BEL-378 服务测试的 _payload 对齐的完整快照。
SHOP_CALC_BASE = dict(
    sku="X-001",
    asin="ASIN-X-001",
    country="US",
    accounting_type="profit_calc",
    package_length_cm=10.0,
    package_width_cm=8.0,
    package_height_cm=5.0,
    weight_kg=0.5,
    fob_product_cost_rmb=20.0,
    first_leg_cost_rmb=5.0,
    ddp_cost_rmb=30.0,
    ddp_cost_usd=4.2,
    sale_price_usd=19.99,
    advertising_rate=0.12,
    return_loss_rate=0.04,
    storage_months=1.0,
    inbound_placement_mode="single_destination",
    usd_to_rmb_rate=7.2,
    usd_to_rmb_rate_source="test",
    size_tier="standard",
    size_tier_label="标准尺寸",
    price_band="15_25",
    price_band_label="$15-25",
    longest_side_in=4.0,
    middle_side_in=3.0,
    shortest_side_in=2.0,
    length_plus_girth_in=14.0,
    volume_cubic_in=24.0,
    volume_cubic_ft=0.014,
    product_weight_lb=1.0,
    product_weight_oz=16.0,
    dimensional_weight_lb=0.8,
    chargeable_weight_lb=1.0,
    chargeable_weight_oz=16.0,
    chargeable_weight_rule="actual",
    fulfillment_fee_rule_label="rule",
    inbound_config_fee_rule_label="rule",
    storage_fee_rule_label="rule",
    referral_fee_usd=3.0,
    advertising_fee_usd=2.4,
    return_loss_usd=0.8,
    fba_fulfillment_fee_usd=3.5,
    inbound_config_fee_usd=0.3,
    storage_fee_usd=0.2,
    total_fee_usd=10.2,
    payout_usd=15.0,
    profit_usd=4.8,
    profit_rate=0.24,
)


def shop_calc_body(**overrides) -> dict:
    """W1 请求体（无 project_id/project_name；source 必填）。"""
    body = {**SHOP_CALC_BASE, "source": "agent_listing_pull"}
    body.update(overrides)
    return body


def seed_shop_calculation(
    project_id: int,
    project_name: str,
    *,
    sku: str = "X-001",
    country: str = "US",
    sale_price_usd: float = 19.99,
    observed_at=None,
    **overrides,
) -> int:
    """直接走 service 落一行已提交的 append-only 快照，返回 row id。

    W1 路由/审计测试需要落库可见的行；service 层 append 不 commit，这里补上。
    """
    from app.schemas.shop_calculation import ShopCalculationCreateRequest
    from app.services import shop_calculation_service

    payload = ShopCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        **{
            **SHOP_CALC_BASE,
            "sku": sku,
            "country": country,
            "sale_price_usd": sale_price_usd,
            **overrides,
        },
        source="agent_listing_pull",
    )
    if observed_at is not None:
        payload.observed_at = observed_at
    db = SessionLocal()
    try:
        item = shop_calculation_service.append_calculation(db, payload, operator=None)
        db.commit()
        return item.id
    finally:
        db.close()


def seed_schedule(project_id: int, shipment_no: str) -> int:
    """建一张 draft 货件 + 2 行明细（X-001×100、X-002×50），返回 schedule id。

    放在 conftest 里供同目录测试文件 `from conftest import seed_schedule`
    （tests 目录非 package，不能跨模块 `from tests....` 导入）。
    """
    db = SessionLocal()
    try:
        payload = ShipmentScheduleCreate(
            project_id=project_id,
            country="US",
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            logistics_unit_price=13.5,
        )
        row = shipment_service.create_shipment_schedule(db, payload, operator="pytest")
        items = [
            {
                "row_no": 1,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-001",
                "quantity": 100,
                "carton_count": 10,
                "remark": None,
            },
            {
                "row_no": 2,
                "project_name": None,
                "shipment_no": None,
                "item_date": None,
                "sku": "X-002",
                "quantity": 50,
                "carton_count": 5,
                "remark": None,
            },
        ]
        replace_shipment_schedule_items(db, row, items, source_type="manual")
        db.commit()
        return row.id
    finally:
        db.close()


@pytest.fixture
def shipment_env(make_api_key):
    agent_id = f"p2-agent-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id)
    suffix = uuid.uuid4().hex[:8]
    project_name = f"agent-p2-{suffix}"

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
        for sku in ("X-001", "X-002"):
            db.add(
                SkuRecord(
                    project_id=project.id,
                    project_name=project_name,
                    sku=sku,
                    asin=f"ASIN-{sku}",
                    country="US",
                    fob_unit_cost=10,
                    first_leg_cost_rmb=1,
                    package_length_cm=10,
                    package_width_cm=10,
                    package_height_cm=10,
                    weight_kg=0.5,
                    carton_length_cm=20,
                    carton_width_cm=20,
                    carton_height_cm=20,
                    carton_weight_kg=5,
                    units_per_carton=10,
                    currency="USD",
                    sort_order=0,
                    is_active=True,
                )
            )
        db.commit()
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "headers": {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        },
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(ShipmentScheduleItem).where(
                ShipmentScheduleItem.project_id == project_id
            )
        )
        db.execute(
            delete(ShipmentSchedule).where(ShipmentSchedule.project_id == project_id)
        )
        db.execute(
            delete(ShopCalculation).where(ShopCalculation.project_id == project_id)
        )
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()
