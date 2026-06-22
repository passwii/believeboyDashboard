from __future__ import annotations

import warnings
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import PricingCalculationRun
from app.services.pricing.computation import _compute_eu_pricing, _compute_pricing
from app.services.pricing.cost_reverse import _solve_fob_cost_for_profit_rate
from app.services.pricing.fbm import _compute_fbm_pricing
from app.services.pricing.reverse import _solve_sale_price_for_profit_rate
from app.services.pricing.utils import _money, _to_iso

__all__ = [
    "PricingCalculationRun",
    "create_pricing_run",
    "create_pricing_reverse_run",
    "create_pricing_cost_reverse_run",
    "create_pricing_fbm_run",
    "create_pricing_eu_run",
    "list_pricing_runs",
    "can_access_pricing_run",
    "delete_pricing_run",
    "serialize_pricing_run",
]


def create_pricing_run(
    db: Session,
    payload: object,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    computed = _compute_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=getattr(payload, "product_name", "").strip(),
        country=getattr(payload, "country", ""),
        package_length_cm=computed["inputs"]["package_length_cm"],
        package_width_cm=computed["inputs"]["package_width_cm"],
        package_height_cm=computed["inputs"]["package_height_cm"],
        weight_kg=computed["inputs"]["weight_kg"],
        fob_product_cost_rmb=computed["inputs"]["fob_product_cost_rmb"],
        first_leg_cost_rmb=computed["inputs"]["first_leg_cost_rmb"],
        first_leg_unit_price_rmb_per_kg=_money(getattr(payload, "first_leg_unit_price_rmb", None))
        if getattr(payload, "first_leg_unit_price_rmb", None) is not None
        else None,
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
        project_id=getattr(payload, "project_id", None),
        sku=getattr(payload, "sku", None),
        competitor_url=getattr(payload, "competitor_url", None),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def create_pricing_reverse_run(
    db: Session,
    payload: object,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    resolved_sale_price_usd = _solve_sale_price_for_profit_rate(payload, db)
    create_payload = _build_create_payload(payload, sale_price_usd=float(resolved_sale_price_usd))
    row = create_pricing_run(db, create_payload, operator=operator)
    row.calculation_type = "profit_reverse"
    db.flush()
    db.refresh(row)
    return row


def create_pricing_cost_reverse_run(
    db: Session,
    payload: object,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    resolved_fob_cost_rmb = _solve_fob_cost_for_profit_rate(payload, db)
    create_payload = _build_create_payload(payload, fob_cost_rmb=float(resolved_fob_cost_rmb))
    row = create_pricing_run(db, create_payload, operator=operator)
    row.calculation_type = "cost_reverse"
    db.flush()
    db.refresh(row)
    return row


def create_pricing_fbm_run(
    db: Session,
    payload: object,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    computed = _compute_fbm_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=getattr(payload, "product_name", "").strip(),
        country=getattr(payload, "country", ""),
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
        delivery_fee_usd=computed["fees_decimal"]["delivery_fee_usd"],
        full_container_quantity=_money(getattr(payload, "full_container_quantity", 0)),
        full_container_price_rmb=_money(getattr(payload, "full_container_price_rmb", 0)),
        warnings_json=computed["warnings"],
        notes="\n".join(computed["warnings"]) if computed["warnings"] else None,
        created_by=(operator or "").strip() or None,
        project_id=getattr(payload, "project_id", None),
        sku=getattr(payload, "sku", None),
        competitor_url=getattr(payload, "competitor_url", None),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def create_pricing_eu_run(
    db: Session,
    payload: object,
    *,
    operator: str | None = None,
) -> PricingCalculationRun:
    computed = _compute_eu_pricing(payload, db)
    row = PricingCalculationRun(
        product_name=getattr(payload, "product_name", "").strip(),
        country=getattr(payload, "country", ""),
        package_length_cm=computed["inputs"]["package_length_cm"],
        package_width_cm=computed["inputs"]["package_width_cm"],
        package_height_cm=computed["inputs"]["package_height_cm"],
        weight_kg=computed["inputs"]["weight_kg"],
        fob_product_cost_rmb=computed["inputs"]["fob_product_cost_rmb"],
        first_leg_cost_rmb=computed["inputs"]["first_leg_cost_rmb"],
        first_leg_unit_price_rmb_per_kg=_money(getattr(payload, "first_leg_unit_price_rmb", None))
        if getattr(payload, "first_leg_unit_price_rmb", None) is not None
        else None,
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
        delivery_fee_usd=computed["fees_decimal"].get("delivery_fee_usd"),
        platform_fee_usd=computed["fees_decimal"].get("platform_fee_usd"),
        warnings_json=computed["warnings"],
        notes="\n".join(computed["warnings"]) if computed["warnings"] else None,
        created_by=(operator or "").strip() or None,
        project_id=getattr(payload, "project_id", None),
        sku=getattr(payload, "sku", None),
        competitor_url=getattr(payload, "competitor_url", None),
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
    keyword: str | None = None,
    operator: str | None = None,
    is_admin: bool = False,
) -> tuple[list[PricingCalculationRun], int]:
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 100)
    stmt = select(PricingCalculationRun)
    if exclude_project_id:
        stmt = stmt.where(PricingCalculationRun.project_id.is_(None))
    if country:
        stmt = stmt.where(PricingCalculationRun.country == country)
    normalized_operator = (operator or "").strip()
    if not is_admin:
        if normalized_operator:
            stmt = stmt.where(PricingCalculationRun.created_by == normalized_operator)
        else:
            stmt = stmt.where(PricingCalculationRun.id == -1)  # 非 admin 且无 operator → 强制空
    # keyword 必须在 operator 隔离之后追加，避免非 admin 越权看到别人记录
    normalized_keyword = (keyword or "").strip()
    if normalized_keyword:
        like_value = f"%{normalized_keyword}%"
        stmt = stmt.where(
            or_(
                PricingCalculationRun.product_name.ilike(like_value),
                PricingCalculationRun.created_by.ilike(like_value),
            )
        )
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
    row = db.get(PricingCalculationRun, run_id)
    if row is None:
        return False
    if not can_access_pricing_run(row, operator=operator, is_admin=is_admin):
        return False
    db.delete(row)
    db.flush()
    return True


def serialize_pricing_run(row: PricingCalculationRun) -> dict[str, object]:
    country = str(getattr(row, "country", "US") or "US")
    vat_usd = float(getattr(row, "vat_usd", Decimal("0")) or Decimal("0"))
    profit_after_vat_usd = float(row.profit_after_vat_usd) if row.profit_after_vat_usd is not None else None
    profit_after_vat_rate = float(row.profit_after_vat_rate) if row.profit_after_vat_rate is not None else None
    payout_usd = float(row.payout_usd)

    return {
        "id": int(row.id),
        "country": country,
        "product_name": str(row.product_name),
        "calculation_type": str(getattr(row, "calculation_type", "profit_calc") or "profit_calc"),
        "project_id": getattr(row, "project_id", None),
        "sku": getattr(row, "sku", None),
        "package_length_cm": float(row.package_length_cm),
        "package_width_cm": float(row.package_width_cm),
        "package_height_cm": float(row.package_height_cm),
        "weight_kg": float(row.weight_kg),
        "fob_product_cost_rmb": float(row.fob_product_cost_rmb),
        "first_leg_cost_rmb": float(row.first_leg_cost_rmb),
        "first_leg_unit_price_rmb_per_kg": float(row.first_leg_unit_price_rmb_per_kg)
        if row.first_leg_unit_price_rmb_per_kg is not None
        else None,
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
            "platform_fee_usd": float(getattr(row, "platform_fee_usd", Decimal("0")) or Decimal("0")),
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
        "delivery_fee_usd": float(row.delivery_fee_usd) if row.delivery_fee_usd is not None else 0.0,
        "platform_fee_usd": float(row.platform_fee_usd) if row.platform_fee_usd is not None else 0.0,
        "full_container_quantity": float(row.full_container_quantity) if row.full_container_quantity is not None else 0.0,
        "full_container_price_rmb": float(row.full_container_price_rmb) if row.full_container_price_rmb is not None else 0.0,
        "competitor_url": getattr(row, "competitor_url", None),
    }


def _build_create_payload(
    source: object,
    sale_price_usd: float | None = None,
    fob_cost_rmb: float | None = None,
) -> object:
    from app.schemas.pricing_calculation import PricingCalculationCreateRequest

    return PricingCalculationCreateRequest(
        product_name=getattr(source, "product_name", ""),
        package_length_cm=getattr(source, "package_length_cm", 0),
        package_width_cm=getattr(source, "package_width_cm", 0),
        package_height_cm=getattr(source, "package_height_cm", 0),
        weight_kg=getattr(source, "weight_kg", 0),
        fob_product_cost_rmb=fob_cost_rmb if fob_cost_rmb is not None else getattr(source, "fob_product_cost_rmb", 0),
        first_leg_cost_rmb=getattr(source, "first_leg_cost_rmb", 0),
        project_id=getattr(source, "project_id", None),
        sku=getattr(source, "sku", None),
        use_historical_shipping_cost=getattr(source, "use_historical_shipping_cost", False),
        sale_price_usd=sale_price_usd if sale_price_usd is not None else getattr(source, "sale_price_usd", 0),
        commission_rate=getattr(source, "commission_rate", 0.15),
        advertising_rate=getattr(source, "advertising_rate", 0),
        return_loss_rate=getattr(source, "return_loss_rate", 0),
        storage_months=getattr(source, "storage_months", 1),
        inbound_placement_mode=getattr(source, "inbound_placement_mode", "single_destination"),
        usd_to_rmb_rate=getattr(source, "usd_to_rmb_rate", None),
        competitor_url=getattr(source, "competitor_url", None),
    )
