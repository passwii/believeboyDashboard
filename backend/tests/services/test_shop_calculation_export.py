from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO

from app.models import Project
from app.models.sku_info import SkuRecord
from app.schemas.shop_calculation import ShopCalculationCreateRequest
from app.services import shop_calculation_service
from app.services.shop_calculation_export import build_shop_calculation_export
from openpyxl import load_workbook

US_FRONTEND_HEADERS = [
    "SKU",
    "FOB(RMB)",
    "长",
    "宽",
    "高",
    "重量(kg)",
    "计费重",
    "头程(RMB)",
    "DDP(RMB)",
    "DDP(USD)",
    "汇率",
    "售价(USD)",
    "广告费率%",
    "广告费",
    "退货折损率%",
    "退货损耗",
    "佣金",
    "派送费",
    "配置费",
    "仓储月数",
    "仓储费",
    "费用合计",
    "回款",
    "利润",
    "利润率",
    "尺寸等级",
    "售价带",
    "规则",
]


def _read_export(content: bytes) -> tuple[list[str], list[dict[str, object]]]:
    workbook = load_workbook(BytesIO(content), data_only=True)
    worksheet = workbook.active
    rows = list(worksheet.iter_rows(values_only=True))
    header_index = next(index for index, row in enumerate(rows) if row[0] == "SKU")
    headers = [str(value) for value in rows[header_index]]
    data = [
        dict(zip(headers, row, strict=False))
        for row in rows[header_index + 1 :]
        if any(value is not None for value in row)
    ]
    return headers, data


def _sku_record(
    project_id: int, project_name: str, sku: str, *, country: str = "US"
) -> SkuRecord:
    return SkuRecord(
        project_id=project_id,
        project_name=project_name,
        sku=sku,
        asin=f"ASIN-{sku}",
        country=country,
        fob_unit_cost=20.0,
        first_leg_cost_rmb=5.0,
        package_length_cm=10.0,
        package_width_cm=8.0,
        package_height_cm=5.0,
        weight_kg=0.5,
        sort_order=1 if sku == "X-001" else 2,
    )


def _calculation_payload(
    project_id: int,
    project_name: str,
    *,
    sku: str = "X-001",
    country: str = "US",
    sale_price_usd: float = 19.99,
    profit_usd: float = 4.8,
    profit_rate: float = 0.24,
    observed_at: datetime | None = None,
) -> ShopCalculationCreateRequest:
    return ShopCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        sku=sku,
        asin=f"ASIN-{sku}",
        country=country,
        accounting_type="profit_calc",
        package_length_cm=10.0,
        package_width_cm=8.0,
        package_height_cm=5.0,
        weight_kg=0.5,
        fob_product_cost_rmb=20.0,
        first_leg_cost_rmb=5.0,
        ddp_cost_rmb=30.0,
        ddp_cost_usd=4.2,
        sale_price_usd=sale_price_usd,
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
        profit_usd=profit_usd,
        profit_rate=profit_rate,
        source="agent_listing_pull",
        observed_at=observed_at,
    )


def _seed_project(db_session, *, with_uncomputed: bool = True) -> tuple[int, str]:
    project_name = "导出测试项目"
    project = Project(
        project_name=project_name,
        project_operator="pytest",
        assistant_operator=None,
        sort_order=0,
        is_active=True,
    )
    db_session.add(project)
    db_session.flush()
    db_session.add(_sku_record(project.id, project_name, "X-001"))
    if with_uncomputed:
        db_session.add(_sku_record(project.id, project_name, "X-002"))
    db_session.flush()
    return project.id, project_name


def test_current_export_uses_latest_snapshot_and_keeps_uncomputed_skus(db_session):
    project_id, project_name = _seed_project(db_session)
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(project_id, project_name, sale_price_usd=10.0),
    )
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(project_id, project_name, sale_price_usd=12.0),
    )

    result = build_shop_calculation_export(
        db_session,
        project_id=project_id,
        project_name=project_name,
        country="US",
        mode="current",
        include_uncomputed=True,
    )
    _, rows = _read_export(result.content)
    by_sku = {row["SKU"]: row for row in rows}
    assert by_sku["X-001"]["售价(USD)"] == 12.0
    assert by_sku["X-002"]["warnings"] == "未核算/缺数据"
    assert result.row_count == 2


def test_history_export_respects_as_of_and_returns_all_snapshots(db_session):
    project_id, project_name = _seed_project(db_session, with_uncomputed=False)
    now = datetime.now(timezone.utc)
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(
            project_id,
            project_name,
            sale_price_usd=10.0,
            observed_at=now - timedelta(days=2),
        ),
    )
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(
            project_id,
            project_name,
            sale_price_usd=11.0,
            observed_at=now - timedelta(days=1),
        ),
    )
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(
            project_id,
            project_name,
            sale_price_usd=12.0,
            observed_at=now,
        ),
    )

    _, rows = _read_export(
        build_shop_calculation_export(
            db_session,
            project_id=project_id,
            project_name=project_name,
            country="US",
            mode="history",
            as_of=now - timedelta(hours=12),
            include_uncomputed=False,
        ).content
    )
    assert [row["售价(USD)"] for row in rows] == [11.0, 10.0]


def test_export_preserves_frontend_columns_and_trace_columns(db_session):
    project_id, project_name = _seed_project(db_session, with_uncomputed=False)
    shop_calculation_service.append_calculation(
        db_session, _calculation_payload(project_id, project_name)
    )

    headers, _ = _read_export(
        build_shop_calculation_export(
            db_session,
            project_id=project_id,
            project_name=project_name,
            country="US",
            mode="current",
            include_uncomputed=False,
        ).content
    )
    assert headers[:28] == US_FRONTEND_HEADERS
    assert headers[-4:] == ["ASIN", "source", "observed_at", "warnings"]


def test_negative_profit_row_is_exported_as_a_number(db_session):
    project_id, project_name = _seed_project(db_session, with_uncomputed=False)
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(
            project_id,
            project_name,
            profit_usd=-2.5,
            profit_rate=-0.125,
        ),
    )

    _, rows = _read_export(
        build_shop_calculation_export(
            db_session,
            project_id=project_id,
            project_name=project_name,
            country="US",
            mode="current",
            include_uncomputed=False,
        ).content
    )
    assert rows[0]["利润"] == -2.5
    assert isinstance(rows[0]["利润"], (int, float))


def test_export_without_country_uses_one_worksheet_per_site(db_session):
    project_id, project_name = _seed_project(db_session, with_uncomputed=False)
    db_session.add(_sku_record(project_id, project_name, "X-DE", country="DE"))
    db_session.flush()
    shop_calculation_service.append_calculation(
        db_session, _calculation_payload(project_id, project_name, country="US")
    )
    shop_calculation_service.append_calculation(
        db_session,
        _calculation_payload(project_id, project_name, sku="X-DE", country="DE"),
    )

    workbook = load_workbook(
        BytesIO(
            build_shop_calculation_export(
                db_session,
                project_id=project_id,
                project_name=project_name,
                include_uncomputed=False,
            ).content
        ),
        data_only=True,
    )
    assert set(workbook.sheetnames) == {"US店铺SKU测算", "DE店铺SKU测算"}
    de_headers = [cell.value for cell in workbook["DE店铺SKU测算"][3]]
    assert de_headers[9] == "DDP(EUR)"
    assert de_headers[11] == "售价(EUR)"
