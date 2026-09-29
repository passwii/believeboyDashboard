from __future__ import annotations

from io import BytesIO

from openpyxl import load_workbook

from app.models.new_product_calculation import NewProductCalculation
from app.schemas.new_product_calculation import NewProductCalculationCreateRequest
from app.services import new_product_calculation_service
from app.services.new_product_calculation_export import (
    build_new_product_comparison_export,
)


def _read_matrix(content: bytes) -> tuple[list[object], dict[str, list[object]]]:
    sheet = load_workbook(BytesIO(content), data_only=True).active
    headers = [sheet.cell(1, col).value for col in range(1, sheet.max_column + 1)]
    rows = {
        str(sheet.cell(row, 2).value): [
            sheet.cell(row, col).value for col in range(3, sheet.max_column + 1)
        ]
        for row in range(2, sheet.max_row + 1)
    }
    return headers, rows


def _seed_snapshot(
    db_session,
    project_id: int,
    project_name: str,
    *,
    sku: str,
    sale_price_usd: float = 19.99,
    referral_fee_usd: float = 3.0,
) -> int:
    payload = NewProductCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        sku=sku,
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
        referral_fee_usd=referral_fee_usd,
        advertising_fee_usd=2.4,
        return_loss_usd=0.8,
        fba_fulfillment_fee_usd=3.5,
        inbound_config_fee_usd=0.3,
        storage_fee_usd=0.2,
        total_fee_usd=10.2,
        payout_usd=15.0,
        profit_usd=4.8,
        profit_rate=0.24,
        source="agent_listing_pull",
    )
    item = new_product_calculation_service.upsert_snapshot(
        db_session, payload, operator=None
    )
    db_session.flush()
    return item.id


def _load_rows(db_session, ids: list[int]) -> list[NewProductCalculation]:
    return [
        row
        for snapshot_id in ids
        if (row := db_session.get(NewProductCalculation, snapshot_id)) is not None
    ]


def test_export_preserves_selected_order_and_missing_fields(db_session):
    project_id = 90000001
    project_name = "导出测试项目"
    first = _seed_snapshot(
        db_session,
        project_id,
        project_name,
        sku="X-001",
        sale_price_usd=19.99,
        referral_fee_usd=3.0,
    )
    second = _seed_snapshot(
        db_session,
        project_id,
        project_name,
        sku="X-002",
        sale_price_usd=20.0,
        referral_fee_usd=4.0,
    )

    result = build_new_product_comparison_export(
        _load_rows(db_session, [second, first]),
        project_name=project_name,
        snapshot_ids=[second, first],
    )
    headers, rows = _read_matrix(result.content)

    assert headers[2:] == [
        f"{project_name} / X-002",
        f"{project_name} / X-001",
    ]
    assert rows["SKU"] == ["X-002", "X-001"]
    assert rows["竞品链接"] == ["-", "-"]
    assert rows["头程单价(RMB/kg)"] == ["-", "-"]
    assert rows["头程数量"] == ["-", "-"]
    assert rows["平台佣金率"][1] == 3.0 / 19.99
    assert result.column_count == 2


def test_export_supports_twelve_columns(db_session):
    project_id = 90000002
    project_name = "导出测试项目"
    ids = [
        _seed_snapshot(
            db_session,
            project_id,
            project_name,
            sku=f"X-{index:03d}",
        )
        for index in range(1, 13)
    ]

    result = build_new_product_comparison_export(
        _load_rows(db_session, ids),
        project_name=project_name,
        snapshot_ids=ids,
    )
    headers, _ = _read_matrix(result.content)
    assert len(headers) == 14
    assert result.column_count == 12
