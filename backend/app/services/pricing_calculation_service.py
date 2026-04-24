from __future__ import annotations

from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import math

from sqlalchemy import func, inspect, select, text
from sqlalchemy.orm import Session

from app.models import ExchangeRate, PricingCalculationRun, ShipmentSkuSummary
from app.schemas.pricing_calculation import (
    PricingCalculationCostReverseRequest,
    PricingCalculationCreateRequest,
    PricingCalculationFbmRequest,
    PricingCalculationReverseRequest,
)

CM_PER_INCH = Decimal("2.54")
KG_PER_LB = Decimal("0.45359237")
OZ_PER_LB = Decimal("16")
DIM_DIVISOR = Decimal("139")
CUBIC_IN_PER_CUBIC_FT = Decimal("1728")
MONEY_QUANT = Decimal("0.01")
METRIC_QUANT = Decimal("0.0001")
RATE_QUANT = Decimal("0.000001")
VOLUME_FT_QUANT = Decimal("0.000001")

COMMISSION_RATE = Decimal("0.15")
RETURN_COMMISSION_RELIEF_RATE = Decimal("0.20")
STANDARD_STORAGE_RATE = Decimal("0.78")
OVERSIZE_STORAGE_RATE = Decimal("0.56")

PRICE_BANDS = [
    ("lt_10", "售价 < $10"),
    ("between_10_50", "售价 $10 ~ $50"),
    ("gt_50", "售价 > $50"),
]

SMALL_STANDARD_FEES = [
    (Decimal("2"), ("2.43", "3.32", "3.58"), "不超过 2 盎司"),
    (Decimal("4"), ("2.49", "3.42", "3.68"), "2 至 4 盎司"),
    (Decimal("6"), ("2.56", "3.45", "3.71"), "4 至 6 盎司"),
    (Decimal("8"), ("2.66", "3.54", "3.80"), "6 至 8 盎司"),
    (Decimal("10"), ("2.77", "3.68", "3.94"), "8 至 10 盎司"),
    (Decimal("12"), ("2.82", "3.78", "4.04"), "10 至 12 盎司"),
    (Decimal("14"), ("2.92", "3.91", "4.17"), "12 至 14 盎司"),
    (Decimal("16"), ("2.95", "3.96", "4.22"), "14 至 16 盎司"),
]

LARGE_STANDARD_FIXED_FEES = [
    (Decimal("4") / OZ_PER_LB, ("2.91", "3.73", "3.99"), "不超过 4 盎司"),
    (Decimal("8") / OZ_PER_LB, ("3.13", "3.95", "4.21"), "4 至 8 盎司"),
    (Decimal("12") / OZ_PER_LB, ("3.38", "4.20", "4.46"), "8 至 12 盎司"),
    (Decimal("16") / OZ_PER_LB, ("3.78", "4.60", "4.86"), "12 至 16 盎司"),
    (Decimal("1.25"), ("4.22", "5.04", "5.30"), "1 至 1.25 磅"),
    (Decimal("1.5"), ("4.60", "5.42", "5.68"), "1.25 至 1.5 磅"),
    (Decimal("1.75"), ("4.75", "5.57", "5.83"), "1.5 至 1.75 磅"),
    (Decimal("2"), ("5.00", "5.82", "6.08"), "1.75 至 2 磅"),
    (Decimal("2.25"), ("5.10", "5.92", "6.18"), "2 至 2.25 磅"),
    (Decimal("2.5"), ("5.28", "6.10", "6.36"), "2.25 至 2.5 磅"),
    (Decimal("2.75"), ("5.44", "6.26", "6.52"), "2.5 至 2.75 磅"),
    (Decimal("3"), ("5.85", "6.67", "6.93"), "2.75 至 3 磅"),
]

SMALL_STANDARD_INBOUND_FEES = [
    (Decimal("8"), Decimal("0.32"), "不超过 8 盎司"),
    (Decimal("16"), Decimal("0.32"), "8 至 16 盎司"),
]

LARGE_STANDARD_INBOUND_FEES = [
    (Decimal("12") / OZ_PER_LB, Decimal("0.40"), "不超过 12 盎司"),
    (Decimal("1.5"), Decimal("0.50"), "12 盎司至 1.5 磅"),
    (Decimal("3"), Decimal("0.60"), "1.5 至 3 磅"),
    (Decimal("5"), Decimal("0.76"), "3 至 5 磅"),
    (Decimal("7"), Decimal("0.98"), "5 至 7 磅"),
    (Decimal("10"), Decimal("1.20"), "7 至 10 磅"),
    (Decimal("15"), Decimal("1.50"), "10 至 15 磅"),
    (Decimal("20"), Decimal("1.90"), "15 至 20 磅"),
]

SMALL_OVERSIZE_INBOUND_FEES = [
    (Decimal("5"), Decimal("1.60"), "小于或等于 5 磅"),
    (Decimal("12"), Decimal("2.40"), "5 至 12 磅"),
    (Decimal("28"), Decimal("3.50"), "12 至 28 磅"),
    (Decimal("42"), Decimal("4.95"), "28 至 42 磅"),
    (Decimal("50"), Decimal("5.95"), "42 至 50 磅"),
]

LARGE_OVERSIZE_INBOUND_FEES = [
    (Decimal("5"), Decimal("1.80"), "小于或等于 5 磅"),
    (Decimal("12"), Decimal("2.90"), "5 至 12 磅"),
    (Decimal("28"), Decimal("4.10"), "12 至 28 磅"),
    (Decimal("42"), Decimal("5.60"), "28 至 42 磅"),
    (Decimal("50"), Decimal("6.50"), "42 至 50 磅"),
]

TIER_LABELS = {
    "small_standard": "小号标准尺寸",
    "large_standard": "大号标准尺寸",
    "small_oversize": "小号大件",
    "large_oversize": "大号大件",
    "oversize_0_50": "超大件（0 至 50 磅）",
    "oversize_50_70": "超大件（50 至 70 磅）",
    "oversize_70_150": "超大件（70 至 150 磅）",
    "oversize_150_plus": "超大件（150 磅以上）",
}


def ensure_tables(db: Session) -> None:
    bind = db.get_bind()
    if bind.dialect.name != "sqlite":
        return
    PricingCalculationRun.__table__.create(bind=bind, checkfirst=True)
    inspector = inspect(bind)
    columns = {
        column["name"] for column in inspector.get_columns("pricing_calculation_runs")
    }
    if "calculation_type" not in columns:
        bind.execute(
            text(
                "ALTER TABLE pricing_calculation_runs ADD COLUMN calculation_type VARCHAR(32) NOT NULL DEFAULT 'profit_calc'"
            )
        )
    if "country" not in columns:
        bind.execute(
            text(
                "ALTER TABLE pricing_calculation_runs ADD COLUMN country VARCHAR(10) NOT NULL DEFAULT 'US'"
            )
        )


def create_pricing_run(
    db: Session,
    payload: PricingCalculationCreateRequest,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    ensure_tables(db)
    computed = _compute_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=payload.product_name.strip(),
        country=payload.country,
        package_length_cm=computed["inputs"]["package_length_cm"],
        package_width_cm=computed["inputs"]["package_width_cm"],
        package_height_cm=computed["inputs"]["package_height_cm"],
        weight_kg=computed["inputs"]["weight_kg"],
        fob_product_cost_rmb=computed["inputs"]["fob_product_cost_rmb"],
        first_leg_cost_rmb=computed["inputs"]["first_leg_cost_rmb"],
        ddp_cost_rmb=computed["profit_decimal"]["ddp_cost_rmb"],
        ddp_cost_usd=computed["profit_decimal"]["ddp_cost_usd"],
        sale_price_usd=computed["inputs"]["sale_price_usd"],
        calculation_type="profit_calc",
        commission_rate=computed["inputs"]["commission_rate"],
        advertising_rate=computed["inputs"]["advertising_rate"],
        return_loss_rate=computed["inputs"]["return_loss_rate"],
        storage_months=computed["inputs"]["storage_months"],
        inbound_placement_mode=computed["inputs"]["inbound_placement_mode"],
        usd_to_rmb_rate=computed["usd_to_rmb_rate"],
        usd_to_rmb_rate_source=computed["usd_to_rmb_rate_source"],
        size_tier=computed["size_tier"],
        size_tier_label=computed["size_tier_label"],
        price_band=computed["price_band"],
        price_band_label=computed["price_band_label"],
        longest_side_in=computed["dimensions_decimal"]["longest_side_in"],
        middle_side_in=computed["dimensions_decimal"]["middle_side_in"],
        shortest_side_in=computed["dimensions_decimal"]["shortest_side_in"],
        length_plus_girth_in=computed["dimensions_decimal"]["length_plus_girth_in"],
        volume_cubic_in=computed["dimensions_decimal"]["volume_cubic_in"],
        volume_cubic_ft=computed["dimensions_decimal"]["volume_cubic_ft"],
        product_weight_lb=computed["weights_decimal"]["product_weight_lb"],
        product_weight_oz=computed["weights_decimal"]["product_weight_oz"],
        dimensional_weight_lb=computed["weights_decimal"]["dimensional_weight_lb"],
        chargeable_weight_lb=computed["weights_decimal"]["chargeable_weight_lb"],
        chargeable_weight_oz=computed["weights_decimal"]["chargeable_weight_oz"],
        chargeable_weight_rule=computed["weights"]["chargeable_weight_rule"],
        fulfillment_fee_rule_label=computed["fulfillment_fee_rule_label"],
        inbound_config_fee_rule_label=computed["inbound_config_fee_rule_label"],
        storage_fee_rule_label=computed["storage_fee_rule_label"],
        referral_fee_usd=computed["fees_decimal"]["referral_fee_usd"],
        advertising_fee_usd=computed["fees_decimal"]["advertising_fee_usd"],
        return_loss_usd=computed["fees_decimal"]["return_loss_usd"],
        fba_fulfillment_fee_usd=computed["fees_decimal"]["fba_fulfillment_fee_usd"],
        inbound_config_fee_usd=computed["fees_decimal"]["inbound_config_fee_usd"],
        storage_fee_usd=computed["fees_decimal"]["storage_fee_usd"],
        total_fee_usd=computed["fees_decimal"]["total_fee_usd"],
        payout_usd=computed["profit_decimal"]["payout_usd"],
        profit_usd=computed["profit_decimal"]["profit_usd"],
        profit_rate=computed["profit_decimal"]["profit_rate"],
        vat_usd=computed["profit_decimal"].get("vat_usd", Decimal("0")),
        profit_after_vat_usd=computed["profit_decimal"].get("profit_after_vat_usd"),
        profit_after_vat_rate=computed["profit_decimal"].get("profit_after_vat_rate"),
        warnings_json=computed["warnings"],
        notes="\n".join(computed["warnings"]) if computed["warnings"] else None,
        created_by=(operator or "").strip() or None,
        project_id=payload.project_id,
        sku=payload.sku,
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def create_pricing_reverse_run(
    db: Session,
    payload: PricingCalculationReverseRequest,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    ensure_tables(db)
    resolved_sale_price_usd = _solve_sale_price_for_profit_rate(payload, db)
    create_payload = PricingCalculationCreateRequest(
        country=payload.country,
        product_name=payload.product_name,
        package_length_cm=payload.package_length_cm,
        package_width_cm=payload.package_width_cm,
        package_height_cm=payload.package_height_cm,
        weight_kg=payload.weight_kg,
        fob_product_cost_rmb=payload.fob_product_cost_rmb,
        first_leg_cost_rmb=payload.first_leg_cost_rmb,
        project_id=payload.project_id,
        sku=payload.sku,
        use_historical_shipping_cost=payload.use_historical_shipping_cost,
        sale_price_usd=float(resolved_sale_price_usd),
        commission_rate=payload.commission_rate,
        advertising_rate=payload.advertising_rate,
        return_loss_rate=payload.return_loss_rate,
        storage_months=payload.storage_months,
        inbound_placement_mode=payload.inbound_placement_mode,
        usd_to_rmb_rate=payload.usd_to_rmb_rate,
    )
    row = create_pricing_run(db, create_payload, operator=operator)
    row.calculation_type = "profit_reverse"
    db.flush()
    db.refresh(row)
    return row


def create_pricing_cost_reverse_run(
    db: Session,
    payload: PricingCalculationCostReverseRequest,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    ensure_tables(db)
    resolved_fob_cost_rmb = _solve_fob_cost_for_profit_rate(payload, db)
    create_payload = PricingCalculationCreateRequest(
        country=payload.country,
        product_name=payload.product_name,
        package_length_cm=payload.package_length_cm,
        package_width_cm=payload.package_width_cm,
        package_height_cm=payload.package_height_cm,
        weight_kg=payload.weight_kg,
        fob_product_cost_rmb=float(resolved_fob_cost_rmb),
        first_leg_cost_rmb=payload.first_leg_cost_rmb,
        project_id=payload.project_id,
        sku=payload.sku,
        use_historical_shipping_cost=payload.use_historical_shipping_cost,
        sale_price_usd=payload.sale_price_usd,
        commission_rate=payload.commission_rate,
        advertising_rate=payload.advertising_rate,
        return_loss_rate=payload.return_loss_rate,
        storage_months=payload.storage_months,
        inbound_placement_mode=payload.inbound_placement_mode,
        usd_to_rmb_rate=payload.usd_to_rmb_rate,
    )
    row = create_pricing_run(db, create_payload, operator=operator)
    row.calculation_type = "cost_reverse"
    db.flush()
    db.refresh(row)
    return row


def create_pricing_fbm_run(
    db: Session,
    payload: PricingCalculationFbmRequest,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    ensure_tables(db)
    computed = _compute_fbm_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=payload.product_name.strip(),
        country=payload.country,
        package_length_cm=computed["inputs"]["package_length_cm"],
        package_width_cm=computed["inputs"]["package_width_cm"],
        package_height_cm=computed["inputs"]["package_height_cm"],
        weight_kg=computed["inputs"]["weight_kg"],
        fob_product_cost_rmb=computed["inputs"]["fob_product_cost_rmb"],
        first_leg_cost_rmb=computed["inputs"]["first_leg_cost_rmb"],
        ddp_cost_rmb=computed["profit_decimal"]["ddp_cost_rmb"],
        ddp_cost_usd=computed["profit_decimal"]["ddp_cost_usd"],
        sale_price_usd=computed["inputs"]["sale_price_usd"],
        calculation_type="fbm_calc",
        commission_rate=computed["inputs"]["commission_rate"],
        advertising_rate=computed["inputs"]["advertising_rate"],
        return_loss_rate=computed["inputs"]["return_loss_rate"],
        storage_months=computed["inputs"]["storage_months"],
        inbound_placement_mode=computed["inputs"]["inbound_placement_mode"],
        usd_to_rmb_rate=computed["usd_to_rmb_rate"],
        usd_to_rmb_rate_source=computed["usd_to_rmb_rate_source"],
        size_tier=computed["size_tier"],
        size_tier_label=computed["size_tier_label"],
        price_band=computed["price_band"],
        price_band_label=computed["price_band_label"],
        longest_side_in=computed["dimensions_decimal"]["longest_side_in"],
        middle_side_in=computed["dimensions_decimal"]["middle_side_in"],
        shortest_side_in=computed["dimensions_decimal"]["shortest_side_in"],
        length_plus_girth_in=computed["dimensions_decimal"]["length_plus_girth_in"],
        volume_cubic_in=computed["dimensions_decimal"]["volume_cubic_in"],
        volume_cubic_ft=computed["dimensions_decimal"]["volume_cubic_ft"],
        product_weight_lb=computed["weights_decimal"]["product_weight_lb"],
        product_weight_oz=computed["weights_decimal"]["product_weight_oz"],
        dimensional_weight_lb=computed["weights_decimal"]["dimensional_weight_lb"],
        chargeable_weight_lb=computed["weights_decimal"]["chargeable_weight_lb"],
        chargeable_weight_oz=computed["weights_decimal"]["chargeable_weight_oz"],
        chargeable_weight_rule=computed["weights"]["chargeable_weight_rule"],
        fulfillment_fee_rule_label=computed["fulfillment_fee_rule_label"],
        inbound_config_fee_rule_label=computed["inbound_config_fee_rule_label"],
        storage_fee_rule_label=computed["storage_fee_rule_label"],
        referral_fee_usd=computed["fees_decimal"]["referral_fee_usd"],
        advertising_fee_usd=computed["fees_decimal"]["advertising_fee_usd"],
        return_loss_usd=computed["fees_decimal"]["return_loss_usd"],
        fba_fulfillment_fee_usd=computed["fees_decimal"]["delivery_fee_usd"],
        inbound_config_fee_usd=computed["fees_decimal"]["inbound_config_fee_usd"],
        storage_fee_usd=computed["fees_decimal"]["storage_fee_usd"],
        total_fee_usd=computed["fees_decimal"]["total_fee_usd"],
        payout_usd=computed["profit_decimal"]["payout_usd"],
        profit_usd=computed["profit_decimal"]["profit_usd"],
        profit_rate=computed["profit_decimal"]["profit_rate"],
        vat_usd=computed["profit_decimal"].get("vat_usd", Decimal("0")),
        profit_after_vat_usd=computed["profit_decimal"].get("profit_after_vat_usd"),
        profit_after_vat_rate=computed["profit_decimal"].get("profit_after_vat_rate"),
        warnings_json=computed["warnings"],
        notes="\n".join(computed["warnings"]) if computed["warnings"] else None,
        created_by=(operator or "").strip() or None,
        project_id=payload.project_id,
        sku=payload.sku,
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def create_pricing_eu_run(
    db: Session,
    payload: PricingCalculationEURequest,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    """欧洲（德国/英国）店铺 SKU 核算，使用手动费用和 VAT 计算"""
    ensure_tables(db)
    computed = _compute_eu_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=payload.product_name.strip(),
        country=payload.country,
        package_length_cm=computed["inputs"]["package_length_cm"],
        package_width_cm=computed["inputs"]["package_width_cm"],
        package_height_cm=computed["inputs"]["package_height_cm"],
        weight_kg=computed["inputs"]["weight_kg"],
        fob_product_cost_rmb=computed["inputs"]["fob_product_cost_rmb"],
        first_leg_cost_rmb=computed["inputs"]["first_leg_cost_rmb"],
        ddp_cost_rmb=computed["profit_decimal"]["ddp_cost_rmb"],
        ddp_cost_usd=computed["profit_decimal"]["ddp_cost_usd"],
        sale_price_usd=computed["inputs"]["sale_price_usd"],
        calculation_type="eu_accounting",
        commission_rate=computed["inputs"]["commission_rate"],
        advertising_rate=computed["inputs"]["advertising_rate"],
        return_loss_rate=computed["inputs"]["return_loss_rate"],
        storage_months=computed["inputs"]["storage_months"],
        inbound_placement_mode=computed["inputs"]["inbound_placement_mode"],
        usd_to_rmb_rate=computed["usd_to_rmb_rate"],
        usd_to_rmb_rate_source=computed["usd_to_rmb_rate_source"],
        size_tier=computed["size_tier"],
        size_tier_label=computed["size_tier_label"],
        price_band=computed["price_band"],
        price_band_label=computed["price_band_label"],
        longest_side_in=computed["dimensions_decimal"]["longest_side_in"],
        middle_side_in=computed["dimensions_decimal"]["middle_side_in"],
        shortest_side_in=computed["dimensions_decimal"]["shortest_side_in"],
        length_plus_girth_in=computed["dimensions_decimal"]["length_plus_girth_in"],
        volume_cubic_in=computed["dimensions_decimal"]["volume_cubic_in"],
        volume_cubic_ft=computed["dimensions_decimal"]["volume_cubic_ft"],
        product_weight_lb=computed["weights_decimal"]["product_weight_lb"],
        product_weight_oz=computed["weights_decimal"]["product_weight_oz"],
        dimensional_weight_lb=computed["weights_decimal"]["dimensional_weight_lb"],
        chargeable_weight_lb=computed["weights_decimal"]["chargeable_weight_lb"],
        chargeable_weight_oz=computed["weights_decimal"]["chargeable_weight_oz"],
        chargeable_weight_rule=computed["weights"]["chargeable_weight_rule"],
        fulfillment_fee_rule_label=computed["fulfillment_fee_rule_label"],
        inbound_config_fee_rule_label=computed["inbound_config_fee_rule_label"],
        storage_fee_rule_label=computed["storage_fee_rule_label"],
        referral_fee_usd=computed["fees_decimal"]["referral_fee_usd"],
        advertising_fee_usd=computed["fees_decimal"]["advertising_fee_usd"],
        return_loss_usd=computed["fees_decimal"]["return_loss_usd"],
        fba_fulfillment_fee_usd=computed["fees_decimal"]["fba_fulfillment_fee_usd"],
        inbound_config_fee_usd=computed["fees_decimal"]["inbound_config_fee_usd"],
        storage_fee_usd=computed["fees_decimal"]["storage_fee_usd"],
        total_fee_usd=computed["fees_decimal"]["total_fee_usd"],
        payout_usd=computed["profit_decimal"]["payout_usd"],
        profit_usd=computed["profit_decimal"]["profit_usd"],
        profit_rate=computed["profit_decimal"]["profit_rate"],
        vat_usd=computed["profit_decimal"].get("vat_usd", Decimal("0")),
        profit_after_vat_usd=computed["profit_decimal"].get("profit_after_vat_usd"),
        profit_after_vat_rate=computed["profit_decimal"].get("profit_after_vat_rate"),
        warnings_json=computed["warnings"],
        notes="\n".join(computed["warnings"]) if computed["warnings"] else None,
        created_by=(operator or "").strip() or None,
        project_id=payload.project_id,
        sku=payload.sku,
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def list_pricing_runs(
    db: Session,
    *,
    page: int = 1,
    page_size: int = 20,
    exclude_project_id: bool = True,
    country: str | None = None,
    operator: str | None = None,
    is_admin: bool = False,
) -> tuple[list[PricingCalculationRun], int]:
    ensure_tables(db)
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 100)
    stmt = select(PricingCalculationRun)
    # 过滤：如果 exclude_project_id 为 True，则只返回没有 project_id 的记录（新品核算）
    if exclude_project_id:
        stmt = stmt.where(PricingCalculationRun.project_id.is_(None))
    if country:
        stmt = stmt.where(PricingCalculationRun.country == country)
    normalized_operator = (operator or "").strip()
    if not is_admin:
        if normalized_operator:
            stmt = stmt.where(PricingCalculationRun.created_by == normalized_operator)
        else:
            stmt = stmt.where(PricingCalculationRun.id == -1)
    total = int(
        db.execute(select(func.count()).select_from(stmt.subquery())).scalar_one() or 0
    )
    rows = (
        db.execute(
            stmt.order_by(
                PricingCalculationRun.created_at.desc(), PricingCalculationRun.id.desc()
            )
            .offset((safe_page - 1) * safe_page_size)
            .limit(safe_page_size)
        )
        .scalars()
        .all()
    )
    return rows, total


def can_access_pricing_run(
    row: PricingCalculationRun | None,
    *,
    operator: str | None = None,
    is_admin: bool = False,
) -> bool:
    if row is None:
        return False
    if is_admin:
        return True
    normalized_operator = (operator or "").strip()
    if not normalized_operator:
        return False
    return (row.created_by or "").strip() == normalized_operator


def delete_pricing_run(
    db: Session, run_id: int, *, operator: str | None = None, is_admin: bool = False
) -> bool:
    ensure_tables(db)
    row = db.get(PricingCalculationRun, run_id)
    if row is None:
        return False
    if not can_access_pricing_run(row, operator=operator, is_admin=is_admin):
        return False
    db.delete(row)
    db.flush()
    return True


def serialize_pricing_run(row: PricingCalculationRun) -> dict[str, object]:
    # Compute VAT for EU countries
    country = str(getattr(row, "country", "US") or "US")
    vat_usd = float(getattr(row, "vat_usd", Decimal("0")) or Decimal("0"))
    profit_after_vat_usd = float(row.profit_after_vat_usd) if row.profit_after_vat_usd is not None else None
    profit_after_vat_rate = float(row.profit_after_vat_rate) if row.profit_after_vat_rate is not None else None
    payout_usd = float(row.payout_usd)

    return {
        "id": int(row.id),
        "country": country,
        "product_name": str(row.product_name),
        "calculation_type": str(
            getattr(row, "calculation_type", "profit_calc") or "profit_calc"
        ),
        "project_id": getattr(row, "project_id", None),
        "sku": getattr(row, "sku", None),
        "package_length_cm": float(row.package_length_cm),
        "package_width_cm": float(row.package_width_cm),
        "package_height_cm": float(row.package_height_cm),
        "weight_kg": float(row.weight_kg),
        "fob_product_cost_rmb": float(row.fob_product_cost_rmb),
        "first_leg_cost_rmb": float(row.first_leg_cost_rmb),
        "sale_price_usd": float(row.sale_price_usd),
        "commission_rate": float(row.commission_rate),
        "advertising_rate": float(row.advertising_rate),
        "return_loss_rate": float(row.return_loss_rate),
        "storage_months": float(row.storage_months),
        "inbound_placement_mode": str(row.inbound_placement_mode),
        "size_tier": str(row.size_tier),
        "size_tier_label": str(row.size_tier_label),
        "price_band": str(row.price_band),
        "price_band_label": str(row.price_band_label),
        "usd_to_rmb_rate": float(row.usd_to_rmb_rate),
        "usd_to_rmb_rate_source": str(row.usd_to_rmb_rate_source),
        "fulfillment_fee_rule_label": str(row.fulfillment_fee_rule_label),
        "inbound_config_fee_rule_label": str(row.inbound_config_fee_rule_label),
        "storage_fee_rule_label": str(row.storage_fee_rule_label),
        "dimensions": {
            "longest_side_in": float(row.longest_side_in),
            "middle_side_in": float(row.middle_side_in),
            "shortest_side_in": float(row.shortest_side_in),
            "length_plus_girth_in": float(row.length_plus_girth_in),
            "volume_cubic_in": float(row.volume_cubic_in),
            "volume_cubic_ft": float(row.volume_cubic_ft),
        },
        "weights": {
            "product_weight_lb": float(row.product_weight_lb),
            "product_weight_oz": float(row.product_weight_oz),
            "dimensional_weight_lb": float(row.dimensional_weight_lb),
            "chargeable_weight_lb": float(row.chargeable_weight_lb),
            "chargeable_weight_oz": float(row.chargeable_weight_oz),
            "chargeable_weight_rule": str(row.chargeable_weight_rule),
        },
        "fees": {
            "referral_fee_usd": float(row.referral_fee_usd),
            "advertising_fee_usd": float(row.advertising_fee_usd),
            "return_loss_usd": float(row.return_loss_usd),
            "fba_fulfillment_fee_usd": float(row.fba_fulfillment_fee_usd),
            "inbound_config_fee_usd": float(row.inbound_config_fee_usd),
            "storage_fee_usd": float(row.storage_fee_usd),
            "total_fee_usd": float(row.total_fee_usd),
        },
        "profit": {
            "ddp_cost_rmb": float(row.ddp_cost_rmb),
            "ddp_cost_usd": float(row.ddp_cost_usd),
            "payout_usd": payout_usd,
            "profit_usd": float(row.profit_usd),
            "profit_rate": float(row.profit_rate),
            "vat_usd": vat_usd,
            "profit_after_vat_usd": profit_after_vat_usd,
            "profit_after_vat_rate": profit_after_vat_rate,
        },
        "warnings": list(row.warnings_json or []),
        "created_by": row.created_by,
        "created_at": _to_iso(row.created_at),
        "updated_at": _to_iso(row.updated_at),
    }


def _compute_fbm_pricing(
    payload: PricingCalculationFbmRequest, db: Session
) -> dict[str, object]:
    """FBM（Fulfillment by Merchant）报价计算，不使用 FBA 规则"""
    length_cm = _decimal(payload.package_length_cm)
    width_cm = _decimal(payload.package_width_cm)
    height_cm = _decimal(payload.package_height_cm)
    weight_kg = _decimal(payload.weight_kg)
    sale_price_usd = _money(payload.sale_price_usd)
    fob_product_cost_rmb = _money(payload.fob_product_cost_rmb)
    full_container_quantity = _money(payload.full_container_quantity)
    full_container_price_rmb = _money(payload.full_container_price_rmb)
    delivery_fee_usd = _money(payload.delivery_fee_usd)
    commission_rate = _ratio(_decimal(payload.commission_rate))
    advertising_rate = _ratio(_decimal(payload.advertising_rate))
    return_loss_rate = _ratio(_decimal(payload.return_loss_rate))
    storage_months = _quantize(_decimal(payload.storage_months), Decimal("0.01"))

    if full_container_quantity > 0:
        first_leg_cost_rmb = _money_decimal(full_container_price_rmb / full_container_quantity)
    else:
        first_leg_cost_rmb = Decimal("0")

    usd_to_rmb_rate, rate_source = _resolve_exchange_rate_to_rmb(
        db,
        manual_rate=payload.usd_to_rmb_rate,
        currency="USD",
    )

    sides_in = sorted(
        [length_cm / CM_PER_INCH, width_cm / CM_PER_INCH, height_cm / CM_PER_INCH],
        reverse=True,
    )
    longest_side_in, middle_side_in, shortest_side_in = sides_in
    length_plus_girth_in = longest_side_in + (middle_side_in + shortest_side_in) * 2
    volume_cubic_in = longest_side_in * middle_side_in * shortest_side_in
    volume_cubic_ft = volume_cubic_in / CUBIC_IN_PER_CUBIC_FT
    product_weight_lb = weight_kg / KG_PER_LB
    product_weight_oz = product_weight_lb * OZ_PER_LB
    dimensional_weight_lb = volume_cubic_in / DIM_DIVISOR

    size_tier, size_rule, chargeable_weight_lb = _resolve_size_tier(
        longest_side_in=longest_side_in,
        middle_side_in=middle_side_in,
        shortest_side_in=shortest_side_in,
        length_plus_girth_in=length_plus_girth_in,
        product_weight_lb=product_weight_lb,
        dimensional_weight_lb=dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd
        * commission_rate
        * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)
    # FBM：无 FBA 配送费/配置费/仓储费，仅有手动填写的 delivery_fee_usd
    total_fee_usd = _money_decimal(
        referral_fee_usd
        + advertising_fee_usd
        + return_loss_usd
        + delivery_fee_usd
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd)
        if sale_price_usd > 0
        else Decimal("0")
    )

    warnings: list[str] = []
    # FBM 无 VAT（中国直发美国）

    return {
        "inputs": {
            "package_length_cm": _quantize(length_cm, METRIC_QUANT),
            "package_width_cm": _quantize(width_cm, METRIC_QUANT),
            "package_height_cm": _quantize(height_cm, METRIC_QUANT),
            "weight_kg": _quantize(weight_kg, METRIC_QUANT),
            "fob_product_cost_rmb": fob_product_cost_rmb,
            "first_leg_cost_rmb": first_leg_cost_rmb,
            "sale_price_usd": sale_price_usd,
            "commission_rate": commission_rate,
            "advertising_rate": advertising_rate,
            "return_loss_rate": return_loss_rate,
            "storage_months": storage_months,
            "inbound_placement_mode": payload.inbound_placement_mode,
        },
        "size_tier": size_tier,
        "size_tier_label": TIER_LABELS[size_tier],
        "price_band": price_band,
        "price_band_label": price_band_label,
        "usd_to_rmb_rate": _quantize(usd_to_rmb_rate, RATE_QUANT),
        "usd_to_rmb_rate_source": rate_source,
        "dimensions_decimal": {
            "longest_side_in": _quantize(longest_side_in, METRIC_QUANT),
            "middle_side_in": _quantize(middle_side_in, METRIC_QUANT),
            "shortest_side_in": _quantize(shortest_side_in, METRIC_QUANT),
            "length_plus_girth_in": _quantize(length_plus_girth_in, METRIC_QUANT),
            "volume_cubic_in": _quantize(volume_cubic_in, METRIC_QUANT),
            "volume_cubic_ft": _quantize(volume_cubic_ft, VOLUME_FT_QUANT),
        },
        "weights_decimal": {
            "product_weight_lb": _quantize(product_weight_lb, METRIC_QUANT),
            "product_weight_oz": _quantize(product_weight_oz, METRIC_QUANT),
            "dimensional_weight_lb": _quantize(dimensional_weight_lb, METRIC_QUANT),
            "chargeable_weight_lb": _quantize(chargeable_weight_lb, METRIC_QUANT),
            "chargeable_weight_oz": _quantize(chargeable_weight_oz, METRIC_QUANT),
        },
        "weights": {
            "chargeable_weight_rule": size_rule,
        },
        "fulfillment_fee_rule_label": "FBM（无 FBA 配送费）",
        "inbound_config_fee_rule_label": "FBM（无配置费）",
        "storage_fee_rule_label": "FBM（无 FBA 仓储费）",
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "delivery_fee_usd": delivery_fee_usd,
            "inbound_config_fee_usd": Decimal("0"),
            "storage_fee_usd": Decimal("0"),
            "total_fee_usd": total_fee_usd,
        },
        "profit_decimal": {
            "ddp_cost_rmb": ddp_cost_rmb,
            "ddp_cost_usd": ddp_cost_usd,
            "payout_usd": payout_usd,
            "profit_usd": profit_usd,
            "profit_rate": profit_rate,
            "vat_usd": Decimal("0"),
            "profit_after_vat_usd": None,
            "profit_after_vat_rate": None,
        },
        "warnings": warnings,
    }


def _compute_pricing(
    payload: PricingCalculationCreateRequest, db: Session
) -> dict[str, object]:
    length_cm = _decimal(payload.package_length_cm)
    width_cm = _decimal(payload.package_width_cm)
    height_cm = _decimal(payload.package_height_cm)
    weight_kg = _decimal(payload.weight_kg)
    sale_price_usd = _money(payload.sale_price_usd)
    fob_product_cost_rmb = _money(payload.fob_product_cost_rmb)
    first_leg_cost_rmb, shipping_cost_warning = _resolve_first_leg_cost_rmb(payload, db)
    commission_rate = _ratio(_decimal(payload.commission_rate))
    advertising_rate = _ratio(_decimal(payload.advertising_rate))
    return_loss_rate = _ratio(_decimal(payload.return_loss_rate))
    storage_months = _quantize(_decimal(payload.storage_months), Decimal("0.01"))

    usd_to_rmb_rate, rate_source = _resolve_exchange_rate_to_rmb(
        db,
        manual_rate=payload.usd_to_rmb_rate,
        currency="USD",
    )

    sides_in = sorted(
        [length_cm / CM_PER_INCH, width_cm / CM_PER_INCH, height_cm / CM_PER_INCH],
        reverse=True,
    )
    longest_side_in, middle_side_in, shortest_side_in = sides_in
    length_plus_girth_in = longest_side_in + (middle_side_in + shortest_side_in) * 2
    volume_cubic_in = longest_side_in * middle_side_in * shortest_side_in
    volume_cubic_ft = volume_cubic_in / CUBIC_IN_PER_CUBIC_FT
    product_weight_lb = weight_kg / KG_PER_LB
    product_weight_oz = product_weight_lb * OZ_PER_LB
    dimensional_weight_lb = volume_cubic_in / DIM_DIVISOR

    size_tier, size_rule, chargeable_weight_lb = _resolve_size_tier(
        longest_side_in=longest_side_in,
        middle_side_in=middle_side_in,
        shortest_side_in=shortest_side_in,
        length_plus_girth_in=length_plus_girth_in,
        product_weight_lb=product_weight_lb,
        dimensional_weight_lb=dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)
    fulfillment_fee_usd, fulfillment_rule = _resolve_fba_fee(
        size_tier, chargeable_weight_lb, chargeable_weight_oz, price_band
    )
    inbound_fee_usd, inbound_rule, inbound_warnings = _resolve_inbound_config_fee(
        size_tier=size_tier,
        chargeable_weight_lb=chargeable_weight_lb,
        chargeable_weight_oz=chargeable_weight_oz,
        inbound_placement_mode=payload.inbound_placement_mode,
    )
    storage_fee_usd, storage_rule = _resolve_storage_fee(
        size_tier=size_tier,
        volume_cubic_ft=volume_cubic_ft,
        storage_months=storage_months,
    )

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd
        * commission_rate
        * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)
    total_fee_usd = _money_decimal(
        referral_fee_usd
        + advertising_fee_usd
        + return_loss_usd
        + fulfillment_fee_usd
        + inbound_fee_usd
        + storage_fee_usd
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd)
        if sale_price_usd > 0
        else Decimal("0")
    )

    # VAT computation for EU countries (Germany 19%, UK 20%)
    vat_rate_map: dict[str, Decimal] = {
        "DE": Decimal("0.19"),
        "UK": Decimal("0.20"),
    }
    country_upper = payload.country.upper()
    vat_rate = vat_rate_map.get(country_upper)
    vat_usd = Decimal("0")
    profit_after_vat_usd_dec: Decimal | None = None
    profit_after_vat_rate_dec: Decimal | None = None
    if vat_rate is not None:
        vat_usd = _money_decimal(sale_price_usd * vat_rate / (Decimal("1") + vat_rate))
        profit_after_vat = payout_usd - vat_usd - ddp_cost_usd
        profit_after_vat_usd_dec = _money_decimal(profit_after_vat)
        profit_after_vat_rate_dec = (
            _ratio_decimal(profit_after_vat_usd_dec / sale_price_usd)
            if sale_price_usd > 0
            else Decimal("0")
        )

    warnings = list(inbound_warnings)
    if shipping_cost_warning:
        warnings.append(shipping_cost_warning)

    return {
        "inputs": {
            "package_length_cm": _quantize(length_cm, METRIC_QUANT),
            "package_width_cm": _quantize(width_cm, METRIC_QUANT),
            "package_height_cm": _quantize(height_cm, METRIC_QUANT),
            "weight_kg": _quantize(weight_kg, METRIC_QUANT),
            "fob_product_cost_rmb": fob_product_cost_rmb,
            "first_leg_cost_rmb": first_leg_cost_rmb,
            "sale_price_usd": sale_price_usd,
            "commission_rate": commission_rate,
            "advertising_rate": advertising_rate,
            "return_loss_rate": return_loss_rate,
            "storage_months": storage_months,
            "inbound_placement_mode": payload.inbound_placement_mode,
        },
        "size_tier": size_tier,
        "size_tier_label": TIER_LABELS[size_tier],
        "price_band": price_band,
        "price_band_label": price_band_label,
        "usd_to_rmb_rate": _quantize(usd_to_rmb_rate, RATE_QUANT),
        "usd_to_rmb_rate_source": rate_source,
        "dimensions_decimal": {
            "longest_side_in": _quantize(longest_side_in, METRIC_QUANT),
            "middle_side_in": _quantize(middle_side_in, METRIC_QUANT),
            "shortest_side_in": _quantize(shortest_side_in, METRIC_QUANT),
            "length_plus_girth_in": _quantize(length_plus_girth_in, METRIC_QUANT),
            "volume_cubic_in": _quantize(volume_cubic_in, METRIC_QUANT),
            "volume_cubic_ft": _quantize(volume_cubic_ft, VOLUME_FT_QUANT),
        },
        "weights_decimal": {
            "product_weight_lb": _quantize(product_weight_lb, METRIC_QUANT),
            "product_weight_oz": _quantize(product_weight_oz, METRIC_QUANT),
            "dimensional_weight_lb": _quantize(dimensional_weight_lb, METRIC_QUANT),
            "chargeable_weight_lb": _quantize(chargeable_weight_lb, METRIC_QUANT),
            "chargeable_weight_oz": _quantize(chargeable_weight_oz, METRIC_QUANT),
        },
        "weights": {
            "chargeable_weight_rule": size_rule,
        },
        "fulfillment_fee_rule_label": fulfillment_rule,
        "inbound_config_fee_rule_label": inbound_rule,
        "storage_fee_rule_label": storage_rule,
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "fba_fulfillment_fee_usd": fulfillment_fee_usd,
            "inbound_config_fee_usd": inbound_fee_usd,
            "storage_fee_usd": storage_fee_usd,
            "total_fee_usd": total_fee_usd,
        },
        "profit_decimal": {
            "ddp_cost_rmb": ddp_cost_rmb,
            "ddp_cost_usd": ddp_cost_usd,
            "payout_usd": payout_usd,
            "profit_usd": profit_usd,
            "profit_rate": profit_rate,
            "vat_usd": vat_usd,
            "profit_after_vat_usd": profit_after_vat_usd_dec,
            "profit_after_vat_rate": profit_after_vat_rate_dec,
        },
        "commission_rate": commission_rate,
        "warnings": warnings,
    }


def _compute_eu_pricing(
    payload: PricingCalculationEURequest, db: Session
) -> dict[str, object]:
    """欧洲（德国/英国）店铺 SKU 核算，不使用 FBA 规则"""
    length_cm = _decimal(payload.package_length_cm)
    width_cm = _decimal(payload.package_width_cm)
    height_cm = _decimal(payload.package_height_cm)
    weight_kg = _decimal(payload.weight_kg)
    sale_price_usd = _money(payload.sale_price_usd)
    fob_product_cost_rmb = _money(payload.fob_product_cost_rmb)
    first_leg_cost_rmb = _money(payload.first_leg_cost_rmb)
    commission_rate = _ratio(_decimal(payload.commission_rate))
    advertising_rate = _ratio(_decimal(payload.advertising_rate))
    return_loss_rate = _ratio(_decimal(payload.return_loss_rate))
    # EU: 手动填写费用
    delivery_fee_usd = _money(payload.delivery_fee_usd)
    inbound_config_fee_manual = _money(payload.inbound_config_fee_usd)
    storage_fee_manual = _money(payload.storage_fee_usd)

    currency_by_country = {
        "DE": "EUR",
        "UK": "GBP",
    }
    target_currency = currency_by_country.get(payload.country.upper())
    if target_currency is None:
        raise ValueError(f"不支持的欧洲站点国家: {payload.country}")

    usd_to_rmb_rate, rate_source = _resolve_exchange_rate_to_rmb(
        db,
        manual_rate=payload.usd_to_rmb_rate,
        currency=target_currency,
    )

    sides_in = sorted(
        [length_cm / CM_PER_INCH, width_cm / CM_PER_INCH, height_cm / CM_PER_INCH],
        reverse=True,
    )
    longest_side_in, middle_side_in, shortest_side_in = sides_in
    length_plus_girth_in = longest_side_in + (middle_side_in + shortest_side_in) * 2
    volume_cubic_in = longest_side_in * middle_side_in * shortest_side_in
    volume_cubic_ft = volume_cubic_in / CUBIC_IN_PER_CUBIC_FT
    product_weight_lb = weight_kg / KG_PER_LB
    product_weight_oz = product_weight_lb * OZ_PER_LB
    dimensional_weight_lb = volume_cubic_in / DIM_DIVISOR

    size_tier, size_rule, chargeable_weight_lb = _resolve_size_tier(
        longest_side_in=longest_side_in,
        middle_side_in=middle_side_in,
        shortest_side_in=shortest_side_in,
        length_plus_girth_in=length_plus_girth_in,
        product_weight_lb=product_weight_lb,
        dimensional_weight_lb=dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd
        * commission_rate
        * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)
    # EU: 派送费和配置费使用手动输入，仓储费也使用手动输入
    total_fee_usd = _money_decimal(
        referral_fee_usd
        + advertising_fee_usd
        + return_loss_usd
        + delivery_fee_usd
        + inbound_config_fee_manual
        + storage_fee_manual
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd)
        if sale_price_usd > 0
        else Decimal("0")
    )

    # VAT computation for EU countries (Germany 19%, UK 20%)
    vat_rate_map: dict[str, Decimal] = {
        "DE": Decimal("0.19"),
        "UK": Decimal("0.20"),
    }
    country_upper = payload.country.upper()
    vat_rate = vat_rate_map.get(country_upper)
    vat_usd = Decimal("0")
    profit_after_vat_usd_dec: Decimal | None = None
    profit_after_vat_rate_dec: Decimal | None = None
    vat_rate_label = ""
    if vat_rate is not None:
        vat_usd = _money_decimal(sale_price_usd * vat_rate / (Decimal("1") + vat_rate))
        profit_after_vat = payout_usd - vat_usd - ddp_cost_usd
        profit_after_vat_usd_dec = _money_decimal(profit_after_vat)
        profit_after_vat_rate_dec = (
            _ratio_decimal(profit_after_vat_usd_dec / sale_price_usd)
            if sale_price_usd > 0
            else Decimal("0")
        )
        vat_rate_label = f"{country_upper} VAT {int(vat_rate * 100)}%"

    warnings: list[str] = []
    if vat_rate_label:
        warnings.append(f"含{vat_rate_label}")

    return {
        "inputs": {
            "package_length_cm": _quantize(length_cm, METRIC_QUANT),
            "package_width_cm": _quantize(width_cm, METRIC_QUANT),
            "package_height_cm": _quantize(height_cm, METRIC_QUANT),
            "weight_kg": _quantize(weight_kg, METRIC_QUANT),
            "fob_product_cost_rmb": fob_product_cost_rmb,
            "first_leg_cost_rmb": first_leg_cost_rmb,
            "sale_price_usd": sale_price_usd,
            "commission_rate": commission_rate,
            "advertising_rate": advertising_rate,
            "return_loss_rate": return_loss_rate,
            "storage_months": Decimal("1"),  # EU 版本不使用仓储月数
            "inbound_placement_mode": "single_destination",
            "delivery_fee_usd": delivery_fee_usd,
            "inbound_config_fee_manual_usd": inbound_config_fee_manual,
            "storage_fee_manual_usd": storage_fee_manual,
        },
        "size_tier": size_tier,
        "size_tier_label": TIER_LABELS[size_tier],
        "price_band": price_band,
        "price_band_label": price_band_label,
        "usd_to_rmb_rate": _quantize(usd_to_rmb_rate, RATE_QUANT),
        "usd_to_rmb_rate_source": rate_source,
        "dimensions_decimal": {
            "longest_side_in": _quantize(longest_side_in, METRIC_QUANT),
            "middle_side_in": _quantize(middle_side_in, METRIC_QUANT),
            "shortest_side_in": _quantize(shortest_side_in, METRIC_QUANT),
            "length_plus_girth_in": _quantize(length_plus_girth_in, METRIC_QUANT),
            "volume_cubic_in": _quantize(volume_cubic_in, METRIC_QUANT),
            "volume_cubic_ft": _quantize(volume_cubic_ft, VOLUME_FT_QUANT),
        },
        "weights_decimal": {
            "product_weight_lb": _quantize(product_weight_lb, METRIC_QUANT),
            "product_weight_oz": _quantize(product_weight_oz, METRIC_QUANT),
            "dimensional_weight_lb": _quantize(dimensional_weight_lb, METRIC_QUANT),
            "chargeable_weight_lb": _quantize(chargeable_weight_lb, METRIC_QUANT),
            "chargeable_weight_oz": _quantize(chargeable_weight_oz, METRIC_QUANT),
        },
        "weights": {
            "chargeable_weight_rule": size_rule,
        },
        "fulfillment_fee_rule_label": "手动填写",
        "inbound_config_fee_rule_label": "手动填写",
        "storage_fee_rule_label": "手动填写",
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "fba_fulfillment_fee_usd": delivery_fee_usd,  # 派送费
            "inbound_config_fee_usd": inbound_config_fee_manual,
            "storage_fee_usd": storage_fee_manual,
            "total_fee_usd": total_fee_usd,
        },
        "profit_decimal": {
            "ddp_cost_rmb": ddp_cost_rmb,
            "ddp_cost_usd": ddp_cost_usd,
            "payout_usd": payout_usd,
            "profit_usd": profit_usd,
            "profit_rate": profit_rate,
            "vat_usd": vat_usd,
            "profit_after_vat_usd": profit_after_vat_usd_dec,
            "profit_after_vat_rate": profit_after_vat_rate_dec,
        },
        "commission_rate": commission_rate,
        "warnings": warnings,
    }


def _solve_sale_price_for_profit_rate(
    payload: PricingCalculationReverseRequest, db: Session
) -> Decimal:
    target_profit_rate = _ratio(_decimal(payload.target_profit_rate))
    low = Decimal("0.01")
    high = Decimal("10")

    def compute_at(price: Decimal) -> dict[str, object]:
        candidate_payload = PricingCalculationCreateRequest(
            product_name=payload.product_name,
            package_length_cm=payload.package_length_cm,
            package_width_cm=payload.package_width_cm,
            package_height_cm=payload.package_height_cm,
            weight_kg=payload.weight_kg,
            fob_product_cost_rmb=payload.fob_product_cost_rmb,
            first_leg_cost_rmb=payload.first_leg_cost_rmb,
            project_id=payload.project_id,
            sku=payload.sku,
            use_historical_shipping_cost=payload.use_historical_shipping_cost,
            sale_price_usd=float(price),
            commission_rate=payload.commission_rate,
            advertising_rate=payload.advertising_rate,
            return_loss_rate=payload.return_loss_rate,
            storage_months=payload.storage_months,
            inbound_placement_mode=payload.inbound_placement_mode,
            usd_to_rmb_rate=payload.usd_to_rmb_rate,
        )
        return _compute_pricing(candidate_payload, db)

    high_result = compute_at(high)
    high_profit_rate = high_result["profit_decimal"]["profit_rate"]
    while high_profit_rate < target_profit_rate:
        high *= Decimal("2")
        if high > Decimal("1000000"):
            raise ValueError("目标利润率过高，当前参数下无法倒算出合理售价")
        high_result = compute_at(high)
        high_profit_rate = high_result["profit_decimal"]["profit_rate"]

    for _ in range(40):
        mid = _money_decimal((low + high) / Decimal("2"))
        result = compute_at(mid)
        current_profit_rate = result["profit_decimal"]["profit_rate"]
        if current_profit_rate >= target_profit_rate:
            high = mid
        else:
            low = mid

    final_price = _money_decimal(high)
    final_result = compute_at(final_price)
    if final_result["profit_decimal"]["profit_rate"] < target_profit_rate:
        final_price = _money_decimal(final_price + Decimal("0.01"))

    return final_price


def _solve_fob_cost_for_profit_rate(
    payload: PricingCalculationCostReverseRequest, db: Session
) -> Decimal:
    target_profit_rate = _ratio(_decimal(payload.target_profit_rate))
    low = Decimal("0.01")
    high = Decimal("100000")
    best_cost = low
    best_result: dict[str, object] | None = None

    def compute_at(cost: Decimal) -> dict[str, object]:
        candidate_payload = PricingCalculationCreateRequest(
            product_name=payload.product_name,
            package_length_cm=payload.package_length_cm,
            package_width_cm=payload.package_width_cm,
            package_height_cm=payload.package_height_cm,
            weight_kg=payload.weight_kg,
            fob_product_cost_rmb=float(cost),
            first_leg_cost_rmb=payload.first_leg_cost_rmb,
            project_id=payload.project_id,
            sku=payload.sku,
            use_historical_shipping_cost=payload.use_historical_shipping_cost,
            sale_price_usd=payload.sale_price_usd,
            commission_rate=payload.commission_rate,
            advertising_rate=payload.advertising_rate,
            return_loss_rate=payload.return_loss_rate,
            storage_months=payload.storage_months,
            inbound_placement_mode=payload.inbound_placement_mode,
            usd_to_rmb_rate=payload.usd_to_rmb_rate,
        )
        return _compute_pricing(candidate_payload, db)

    for _ in range(40):
        mid = _money_decimal((low + high) / Decimal("2"))
        result = compute_at(mid)
        current_profit_rate = result["profit_decimal"]["profit_rate"]

        if abs(current_profit_rate - target_profit_rate) < Decimal("0.0001"):
            best_cost = mid
            best_result = result
            break

        if current_profit_rate > target_profit_rate:
            low = mid
        else:
            high = mid

        best_cost = mid
        best_result = result

    if best_result is None:
        raise ValueError("无法找到满足目标利润率的 FOB 成本")

    return _money_decimal(best_cost)


def _resolve_first_leg_cost_rmb(
    payload: PricingCalculationCreateRequest, db: Session
) -> tuple[Decimal, str | None]:
    manual_cost = _money(payload.first_leg_cost_rmb)
    if not payload.use_historical_shipping_cost:
        return manual_cost, None

    if payload.project_id is None or not (payload.sku or "").strip():
        return manual_cost, "历史头程成本未命中项目或 SKU，已回退到手动头程成本"

    row = db.execute(
        select(ShipmentSkuSummary.average_logistics_unit_price)
        .where(
            ShipmentSkuSummary.project_id == payload.project_id,
            ShipmentSkuSummary.sku == payload.sku.strip(),
        )
        .limit(1)
    ).scalar_one_or_none()
    if row is None:
        return manual_cost, "未找到该 SKU 的头程历史加权成本，已回退到手动头程成本"

    historical_cost = _money(row)
    if historical_cost <= 0:
        return manual_cost, "该 SKU 的头程历史加权成本为 0，已回退到手动头程成本"
    return historical_cost, None


def _resolve_exchange_rate_to_rmb(
    db: Session, *, manual_rate: float | None, currency: str
) -> tuple[Decimal, str]:
    if manual_rate is not None:
        return _decimal(manual_rate), "manual"
    normalized_currency = currency.strip().upper()
    row = (
        db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.currency == normalized_currency)
            .order_by(ExchangeRate.year_month.desc(), ExchangeRate.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if row is None:
        raise ValueError(
            f"缺少 {normalized_currency} 汇率，请先维护汇率信息或在请求中传入 usd_to_rmb_rate"
        )
    return _decimal(row.rate), f"system:{row.year_month}"


def _resolve_price_band(sale_price_usd: Decimal) -> tuple[str, str]:
    if sale_price_usd < Decimal("10"):
        return PRICE_BANDS[0]
    if sale_price_usd <= Decimal("50"):
        return PRICE_BANDS[1]
    return PRICE_BANDS[2]


def _resolve_size_tier(
    *,
    longest_side_in: Decimal,
    middle_side_in: Decimal,
    shortest_side_in: Decimal,
    length_plus_girth_in: Decimal,
    product_weight_lb: Decimal,
    dimensional_weight_lb: Decimal,
) -> tuple[str, str, Decimal]:
    if (
        longest_side_in <= Decimal("15")
        and middle_side_in <= Decimal("12")
        and shortest_side_in <= Decimal("0.75")
        and product_weight_lb <= Decimal("1")
    ):
        return "small_standard", "商品重量", product_weight_lb

    large_standard_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("18")
        and middle_side_in <= Decimal("14")
        and shortest_side_in <= Decimal("8")
        and large_standard_weight <= Decimal("20")
    ):
        return "large_standard", "商品重量与体积重量取大值", large_standard_weight

    small_oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("37")
        and middle_side_in <= Decimal("28")
        and shortest_side_in <= Decimal("20")
        and length_plus_girth_in <= Decimal("130")
        and small_oversize_weight <= Decimal("50")
    ):
        return "small_oversize", "商品重量与体积重量取大值", small_oversize_weight

    large_oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("59")
        and middle_side_in <= Decimal("33")
        and shortest_side_in <= Decimal("33")
        and length_plus_girth_in <= Decimal("130")
        and large_oversize_weight <= Decimal("50")
    ):
        return "large_oversize", "商品重量与体积重量取大值", large_oversize_weight

    if product_weight_lb > Decimal("150"):
        return "oversize_150_plus", "商品重量", product_weight_lb

    oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if oversize_weight <= Decimal("50"):
        return "oversize_0_50", "商品重量与体积重量取大值", oversize_weight
    if oversize_weight <= Decimal("70"):
        return "oversize_50_70", "商品重量与体积重量取大值", oversize_weight
    return "oversize_70_150", "商品重量与体积重量取大值", oversize_weight


def _resolve_fba_fee(
    size_tier: str,
    chargeable_weight_lb: Decimal,
    chargeable_weight_oz: Decimal,
    price_band: str,
) -> tuple[Decimal, str]:
    price_band_index = {"lt_10": 0, "between_10_50": 1, "gt_50": 2}[price_band]

    if size_tier == "small_standard":
        for upper_oz, fees, label in SMALL_STANDARD_FEES:
            if chargeable_weight_oz <= upper_oz:
                return Decimal(
                    fees[price_band_index]
                ), f"{TIER_LABELS[size_tier]} / {label}"

    if size_tier == "large_standard":
        for upper_lb, fees, label in LARGE_STANDARD_FIXED_FEES:
            if chargeable_weight_lb <= upper_lb:
                return Decimal(
                    fees[price_band_index]
                ), f"{TIER_LABELS[size_tier]} / {label}"
        base_fee = Decimal(("6.15", "6.97", "7.23")[price_band_index])
        increments = _ceil_positive(
            (chargeable_weight_oz - Decimal("48")) / Decimal("4")
        )
        return _money_decimal(
            base_fee + Decimal(increments) * Decimal("0.08")
        ), f"{TIER_LABELS[size_tier]} / 3 至 20 磅"

    if size_tier == "small_oversize":
        return _tier_fee_with_first_pound(
            base=Decimal(("6.78", "7.55", "7.55")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "large_oversize":
        return _tier_fee_with_first_pound(
            base=Decimal(("8.58", "9.35", "9.35")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_0_50":
        return _tier_fee_with_first_pound(
            base=Decimal(("25.56", "26.33", "26.33")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_50_70":
        return _tier_fee_with_threshold(
            base=Decimal(("36.55", "37.32", "37.32")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            threshold_lb=Decimal("51"),
            increment=Decimal("0.75"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_70_150":
        return _tier_fee_with_threshold(
            base=Decimal(("50.55", "51.32", "51.32")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            threshold_lb=Decimal("71"),
            increment=Decimal("0.75"),
            tier_label=TIER_LABELS[size_tier],
        )

    return _tier_fee_with_threshold(
        base=Decimal(("194.18", "194.95", "194.95")[price_band_index]),
        chargeable_weight_lb=chargeable_weight_lb,
        threshold_lb=Decimal("151"),
        increment=Decimal("0.19"),
        tier_label=TIER_LABELS["oversize_150_plus"],
    )


def _resolve_inbound_config_fee(
    *,
    size_tier: str,
    chargeable_weight_lb: Decimal,
    chargeable_weight_oz: Decimal,
    inbound_placement_mode: str,
) -> tuple[Decimal, str, list[str]]:
    if inbound_placement_mode == "amazon_optimized_split":
        return Decimal("0.00"), "亚马逊优化的货件拆分 / 发往五个或更多地点 / 无费用", []

    if size_tier == "small_standard":
        for upper_oz, fee, label in SMALL_STANDARD_INBOUND_FEES:
            if chargeable_weight_oz <= upper_oz:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "large_standard":
        for upper_lb, fee, label in LARGE_STANDARD_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "small_oversize":
        for upper_lb, fee, label in SMALL_OVERSIZE_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "large_oversize":
        for upper_lb, fee, label in LARGE_OVERSIZE_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    oversize_tiers = {
        "oversize_0_50",
        "oversize_50_70",
        "oversize_70_150",
        "oversize_150_plus",
    }
    if size_tier in oversize_tiers:
        return Decimal("0.00"), f"{TIER_LABELS[size_tier]} / 超大件无入库配置费", []

    return (
        Decimal("0.00"),
        f"{TIER_LABELS[size_tier]} / 当前未提供入库配置费规则，暂按 $0 计",
        [
            f"{TIER_LABELS[size_tier]} 当前未提供入库配置费阶梯，系统暂按 $0 计算。",
        ],
    )


def _resolve_storage_fee(
    *, size_tier: str, volume_cubic_ft: Decimal, storage_months: Decimal
) -> tuple[Decimal, str]:
    is_standard = size_tier in {"small_standard", "large_standard"}
    rate = STANDARD_STORAGE_RATE if is_standard else OVERSIZE_STORAGE_RATE
    fee = _money_decimal(volume_cubic_ft * rate * storage_months)
    label = (
        "标准尺寸 / 非危险品 / 非旺季"
        if is_standard
        else "大件商品 / 非危险品 / 非旺季"
    )
    return fee, f"{label} / ${rate} / 立方英尺 / 月"


def _tier_fee_with_first_pound(
    *, base: Decimal, chargeable_weight_lb: Decimal, increment: Decimal, tier_label: str
) -> tuple[Decimal, str]:
    increments = _ceil_positive(chargeable_weight_lb - Decimal("1"))
    return _money_decimal(
        base + Decimal(increments) * increment
    ), f"{tier_label} / 0 至 50 磅"


def _tier_fee_with_threshold(
    *,
    base: Decimal,
    chargeable_weight_lb: Decimal,
    threshold_lb: Decimal,
    increment: Decimal,
    tier_label: str,
) -> tuple[Decimal, str]:
    increments = _ceil_positive(chargeable_weight_lb - threshold_lb)
    return _money_decimal(base + Decimal(increments) * increment), tier_label


def _decimal(value: object) -> Decimal:
    return Decimal(str(value))


def _money(value: object) -> Decimal:
    return _money_decimal(_decimal(value))


def _money_decimal(value: Decimal) -> Decimal:
    return _quantize(value, MONEY_QUANT)


def _ratio(value: Decimal) -> Decimal:
    return _quantize(value, Decimal("0.000001"))


def _ratio_decimal(value: Decimal) -> Decimal:
    return _quantize(value, Decimal("0.0001"))


def _quantize(value: Decimal, precision: Decimal) -> Decimal:
    return value.quantize(precision, rounding=ROUND_HALF_UP)


def _ceil_positive(value: Decimal) -> int:
    if value <= 0:
        return 0
    return int(math.ceil(float(value)))


def _to_iso(value: datetime | None) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return ""
