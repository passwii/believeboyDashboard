"""Agent 货件域测试 fixture（P2）。

shipment_env：临时项目 + 2 个 SKU（X-001/X-002，US，装箱率 10）+ 一张 agent 凭据。
测试后按 items → schedules → skus → project 顺序清理（key 由 make_api_key 自清）。
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.models import Project
from app.models.new_product_calculation import NewProductCalculation
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


# 新品测算（BLF-451）测试基座：镜像 NewProductCalculationCreateRequest 快照字段
# （不含 project_id/project_name/created_by，W1 服务端派生）。
NEW_PRODUCT_BASE = dict(
    sku="X-001",
    asin="ASIN-X-001",
    country="US",
    calculation_type="profit_calc",
    package_length_cm=10.0,
    package_width_cm=8.0,
    package_height_cm=5.0,
    weight_kg=0.5,
    fob_product_cost_rmb=20.0,
    first_leg_cost_rmb=5.0,
    ddp_cost_rmb=30.0,
    ddp_cost_usd=4.2,
    sale_price_usd=19.99,
    target_profit_rate=None,
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


def new_product_body(**overrides) -> dict:
    """W1 请求体（无 project_id/project_name/created_by；source 必填）。"""
    body = {**NEW_PRODUCT_BASE, "source": "agent_listing_pull"}
    body.update(overrides)
    return body


def seed_new_product_calculation(
    project_id: int,
    project_name: str,
    *,
    sku: str = "X-001",
    country: str = "US",
    calculation_type: str = "profit_calc",
    sale_price_usd: float = 19.99,
    observed_at=None,
    **overrides,
) -> int:
    """直接走 service upsert 落一行已提交的快照，返回 row id。

    W1 路由/审计测试需要落库可见的行；service 层 upsert 不 commit，这里补上。
    """
    from app.schemas.new_product_calculation import NewProductCalculationCreateRequest
    from app.services import new_product_calculation_service

    payload = NewProductCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        **{
            **NEW_PRODUCT_BASE,
            "sku": sku,
            "country": country,
            "calculation_type": calculation_type,
            "sale_price_usd": sale_price_usd,
            **overrides,
        },
        source="agent_listing_pull",
    )
    if observed_at is not None:
        payload.observed_at = observed_at
    db = SessionLocal()
    try:
        item = new_product_calculation_service.upsert_snapshot(
            db, payload, operator=None
        )
        db.commit()
        return item.id
    finally:
        db.close()


def seed_return_analysis(
    project_id: int,
    *,
    country: str = "US",
    return_rows: list[dict] | None = None,
    sales_rows: list[dict] | None = None,
    aggregate_rows: list[dict] | None = None,
) -> None:
    """Seed return analysis data（BLF-470 测试基座）。

    建一张 ``return_report`` source file（is_current=True）+ 可选 raw rows /
    sales rows / aggregate rows。返回 (return_source_file_id, sales_source_file_id)。
    ``computed_at`` 缺省走 server_default=now() → aggregate 视为「新鲜」，
    可让 ``is_snapshot_fresh_for_range`` 命中 snapshot 路径。
    """
    from app.models import (
        AnalysisReturnAggregate,
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
    )

    today = date.today() - timedelta(days=1)
    period_start = today - timedelta(days=6)
    period_end = today

    db = SessionLocal()
    try:
        # find-or-create：同一 (project, country, report_type, period) 的 source file
        # 复用（analysis_sources_period_version_key 唯一约束，多次 seed 不冲突）。
        sf_ret = db.execute(
            select(AnalysisSourceFile).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.period_start_date == period_start,
                AnalysisSourceFile.period_end_date == period_end,
            )
        ).scalars().first()
        if sf_ret is None:
            sf_ret = AnalysisSourceFile(
                project_id=project_id,
                country=country,
                report_type="return_report",
                upload_file_id=f"test_ret_{project_id}_{uuid.uuid4().hex[:6]}",
                upload_file_path="/tmp/test_ret.csv",
                original_filename="test_ret.csv",
                stored_filename="test_ret.csv",
                logical_filename="test_ret.csv",
                storage_key="test_ret.csv",
                period_start_date=period_start,
                period_end_date=period_end,
                is_current=True,
                ingestion_status="success",
                row_count_total=0,
                created_by="pytest",
            )
            db.add(sf_ret)
            db.flush()

        sf_sales = db.execute(
            select(AnalysisSourceFile).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.period_start_date == period_start,
                AnalysisSourceFile.period_end_date == period_end,
            )
        ).scalars().first()
        if sf_sales is None:
            sf_sales = AnalysisSourceFile(
                project_id=project_id,
                country=country,
                report_type="sales_report",
                upload_file_id=f"test_sales_{project_id}_{uuid.uuid4().hex[:6]}",
                upload_file_path="/tmp/test_sales.csv",
                original_filename="test_sales.csv",
                stored_filename="test_sales.csv",
                logical_filename="test_sales.csv",
                storage_key="test_sales.csv",
                period_start_date=period_start,
                period_end_date=period_end,
                is_current=True,
                ingestion_status="success",
                created_by="pytest",
            )
            db.add(sf_sales)
            db.flush()

        for i, r in enumerate(return_rows or []):
            db.add(
                AnalysisReturnRow(
                    project_id=project_id,
                    country=country,
                    source_file_id=sf_ret.id,
                    source_row_no=i + 1,
                    return_date=r["return_date"],
                    order_id=r["order_id"],
                    sku=r["sku"],
                    asin=r.get("asin"),
                    product_name=r.get("product_name"),
                    quantity=r.get("quantity", 1),
                    fulfillment_center_id=r.get("fulfillment_center_id"),
                    detailed_disposition=r.get("detailed_disposition", "SELLABLE"),
                    reason=r.get("reason", "NOT_AS_DESCRIBED"),
                    status=r.get("status", "PROCESSED"),
                    license_plate_number=r.get(
                        "license_plate_number", f"LP-{project_id}-{i}"
                    ),
                    original_return_datetime=r.get(
                        "original_return_datetime",
                        f"{r['return_date']}T10:00:00+00:00",
                    ),
                    customer_comments=r.get("customer_comments"),
                    raw_row={},
                )
            )

        for i, s in enumerate(sales_rows or []):
            db.add(
                AnalysisSalesOrderRow(
                    project_id=project_id,
                    country=country,
                    source_file_id=sf_sales.id,
                    source_row_no=i + 1,
                    amazon_order_id=s["order_id"],
                    purchase_at_utc=datetime.now(timezone.utc),
                    purchase_at_pt=datetime.now(timezone.utc),
                    purchase_date_pt=s["purchase_date_pt"],
                    order_status=s.get("order_status", "Shipped"),
                    sku=s["sku"],
                    asin=s.get("asin"),
                    quantity=s["quantity"],
                    item_price=s.get("item_price", 10),
                    shipping_price=0,
                    currency="USD",
                    is_counted_sales=True,
                    raw_row={},
                )
            )

        for i, a in enumerate(aggregate_rows or []):
            db.add(
                AnalysisReturnAggregate(
                    project_id=project_id,
                    country=country,
                    sku=a["sku"],
                    asin=a.get("asin"),
                    data_date=a["data_date"],
                    return_count=a.get("return_count", 1),
                    return_quantity=a.get("return_quantity", 1),
                    sales_quantity=a.get("sales_quantity", 10),
                    return_rate=a.get("return_rate", 0),
                    cycle_avg_days=a.get("cycle_avg_days"),
                    cycle_min_days=a.get("cycle_min_days"),
                    cycle_max_days=a.get("cycle_max_days"),
                    reason_top1=a.get("reason_top1"),
                    disposition_top1=a.get("disposition_top1"),
                    dominant_fc_id=a.get("dominant_fc_id"),
                    risk_level=a.get("risk_level", "normal"),
                    wilson_lower=a.get("wilson_lower"),
                    computed_at=a.get("computed_at"),
                )
            )

        sf_ret.row_count_total = len(return_rows or [])
        db.commit()
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
        from app.models import (
            AnalysisReturnAggregate,
            AnalysisReturnRow,
            AnalysisSalesOrderRow,
            AnalysisSourceFile,
        )

        # BLF-470：退货分析测试数据清理（FK 顺序：rows → source_files → aggregates）
        db.execute(
            delete(AnalysisReturnRow).where(AnalysisReturnRow.project_id == project_id)
        )
        db.execute(
            delete(AnalysisSalesOrderRow).where(
                AnalysisSalesOrderRow.project_id == project_id
            )
        )
        db.execute(
            delete(AnalysisSourceFile).where(AnalysisSourceFile.project_id == project_id)
        )
        db.execute(
            delete(AnalysisReturnAggregate).where(
                AnalysisReturnAggregate.project_id == project_id
            )
        )
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
        db.execute(
            delete(NewProductCalculation).where(
                NewProductCalculation.project_id == project_id
            )
        )
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()
