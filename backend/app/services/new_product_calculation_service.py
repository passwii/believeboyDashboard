from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.new_product_calculation import NewProductCalculation
from app.schemas.new_product_calculation import (
    NewProductCalculationCreateRequest,
    NewProductCalculationItem,
)


def _to_item(row: NewProductCalculation) -> NewProductCalculationItem:
    """将数据库模型转换为 API 响应（2026-08-03 由 _to_item(StoreSkuPricingSnapshot) 改名）"""
    return NewProductCalculationItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        sku=row.sku,
        asin=row.asin,
        country=row.country,
        calculation_type=row.calculation_type,
        package_length_cm=float(row.package_length_cm),
        package_width_cm=float(row.package_width_cm),
        package_height_cm=float(row.package_height_cm),
        weight_kg=float(row.weight_kg),
        fob_product_cost_rmb=float(row.fob_product_cost_rmb),
        first_leg_cost_rmb=float(row.first_leg_cost_rmb),
        ddp_cost_rmb=float(row.ddp_cost_rmb),
        ddp_cost_usd=float(row.ddp_cost_usd),
        sale_price_usd=float(row.sale_price_usd),
        target_profit_rate=float(row.target_profit_rate)
        if row.target_profit_rate is not None
        else None,
        advertising_rate=float(row.advertising_rate),
        return_loss_rate=float(row.return_loss_rate),
        storage_months=float(row.storage_months),
        inbound_placement_mode=row.inbound_placement_mode,
        usd_to_rmb_rate=float(row.usd_to_rmb_rate),
        usd_to_rmb_rate_source=row.usd_to_rmb_rate_source,
        size_tier=row.size_tier,
        size_tier_label=row.size_tier_label,
        price_band=row.price_band,
        price_band_label=row.price_band_label,
        fulfillment_fee_rule_label=row.fulfillment_fee_rule_label,
        inbound_config_fee_rule_label=row.inbound_config_fee_rule_label,
        storage_fee_rule_label=row.storage_fee_rule_label,
        dimensions={
            "longest_side_in": float(row.longest_side_in),
            "middle_side_in": float(row.middle_side_in),
            "shortest_side_in": float(row.shortest_side_in),
            "length_plus_girth_in": float(row.length_plus_girth_in),
            "volume_cubic_in": float(row.volume_cubic_in),
            "volume_cubic_ft": float(row.volume_cubic_ft),
        },
        weights={
            "product_weight_lb": float(row.product_weight_lb),
            "product_weight_oz": float(row.product_weight_oz),
            "dimensional_weight_lb": float(row.dimensional_weight_lb),
            "chargeable_weight_lb": float(row.chargeable_weight_lb),
            "chargeable_weight_oz": float(row.chargeable_weight_oz),
            "chargeable_weight_rule": row.chargeable_weight_rule,
        },
        fees={
            "referral_fee_usd": float(row.referral_fee_usd),
            "advertising_fee_usd": float(row.advertising_fee_usd),
            "return_loss_usd": float(row.return_loss_usd),
            "fba_fulfillment_fee_usd": float(row.fba_fulfillment_fee_usd),
            "inbound_config_fee_usd": float(row.inbound_config_fee_usd),
            "storage_fee_usd": float(row.storage_fee_usd),
            "total_fee_usd": float(row.total_fee_usd),
            "delivery_fee_usd": float(
                getattr(row, "delivery_fee_usd", Decimal("0")) or Decimal("0")
            ),
            "inbound_config_fee_manual_usd": float(
                getattr(row, "inbound_config_fee_manual_usd", Decimal("0"))
                or Decimal("0")
            ),
            "storage_fee_manual_usd": float(
                getattr(row, "storage_fee_manual_usd", Decimal("0")) or Decimal("0")
            ),
        },
        profit={
            "ddp_cost_rmb": float(row.ddp_cost_rmb),
            "ddp_cost_usd": float(row.ddp_cost_usd),
            "payout_usd": float(row.payout_usd),
            "profit_usd": float(row.profit_usd),
            "profit_rate": float(row.profit_rate),
            "vat_usd": float(getattr(row, "vat_usd", Decimal("0")) or Decimal("0")),
            "profit_after_vat_usd": float(row.profit_after_vat_usd)
            if row.profit_after_vat_usd is not None
            else None,
            "profit_after_vat_rate": float(row.profit_after_vat_rate)
            if row.profit_after_vat_rate is not None
            else None,
        },
        warnings=row.warnings_json or [],
        notes=row.notes,
        source=row.source,
        observed_at=row.observed_at,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def upsert_snapshot(
    db: Session,
    payload: NewProductCalculationCreateRequest,
    *,
    operator: str | None = None,
) -> NewProductCalculationItem:
    """创建或更新新品核算快照（upsert，2026-08-03 由 upsert_snapshot(StoreSkuPricingSnapshot) 改名）
    按 (project_id, sku, calculation_type) 唯一键"""
    existing = db.execute(
        select(NewProductCalculation).where(
            NewProductCalculation.project_id == payload.project_id,
            NewProductCalculation.sku == payload.sku,
            NewProductCalculation.calculation_type == payload.calculation_type,
        )
    ).scalar_one_or_none()

    if existing:
        _update_snapshot(existing, payload, operator)
        db.flush()
        db.refresh(existing)
        return _to_item(existing)
    else:
        row = _create_snapshot(payload, operator)
        db.add(row)
        db.flush()
        db.refresh(row)
        return _to_item(row)


def _create_snapshot(
    payload: NewProductCalculationCreateRequest,
    operator: str | None,
) -> NewProductCalculation:
    return NewProductCalculation(
        project_id=payload.project_id,
        project_name=payload.project_name,
        sku=payload.sku,
        asin=payload.asin,
        country=payload.country,
        calculation_type=payload.calculation_type,
        package_length_cm=Decimal(str(payload.package_length_cm)),
        package_width_cm=Decimal(str(payload.package_width_cm)),
        package_height_cm=Decimal(str(payload.package_height_cm)),
        weight_kg=Decimal(str(payload.weight_kg)),
        fob_product_cost_rmb=Decimal(str(payload.fob_product_cost_rmb)),
        first_leg_cost_rmb=Decimal(str(payload.first_leg_cost_rmb)),
        ddp_cost_rmb=Decimal(str(payload.ddp_cost_rmb)),
        ddp_cost_usd=Decimal(str(payload.ddp_cost_usd)),
        sale_price_usd=Decimal(str(payload.sale_price_usd)),
        target_profit_rate=Decimal(str(payload.target_profit_rate))
        if payload.target_profit_rate is not None
        else None,
        advertising_rate=Decimal(str(payload.advertising_rate)),
        return_loss_rate=Decimal(str(payload.return_loss_rate)),
        storage_months=Decimal(str(payload.storage_months)),
        inbound_placement_mode=payload.inbound_placement_mode,
        usd_to_rmb_rate=Decimal(str(payload.usd_to_rmb_rate)),
        usd_to_rmb_rate_source=payload.usd_to_rmb_rate_source,
        size_tier=payload.size_tier,
        size_tier_label=payload.size_tier_label,
        price_band=payload.price_band,
        price_band_label=payload.price_band_label,
        longest_side_in=Decimal(str(payload.longest_side_in)),
        middle_side_in=Decimal(str(payload.middle_side_in)),
        shortest_side_in=Decimal(str(payload.shortest_side_in)),
        length_plus_girth_in=Decimal(str(payload.length_plus_girth_in)),
        volume_cubic_in=Decimal(str(payload.volume_cubic_in)),
        volume_cubic_ft=Decimal(str(payload.volume_cubic_ft)),
        product_weight_lb=Decimal(str(payload.product_weight_lb)),
        product_weight_oz=Decimal(str(payload.product_weight_oz)),
        dimensional_weight_lb=Decimal(str(payload.dimensional_weight_lb)),
        chargeable_weight_lb=Decimal(str(payload.chargeable_weight_lb)),
        chargeable_weight_oz=Decimal(str(payload.chargeable_weight_oz)),
        chargeable_weight_rule=payload.chargeable_weight_rule,
        fulfillment_fee_rule_label=payload.fulfillment_fee_rule_label,
        inbound_config_fee_rule_label=payload.inbound_config_fee_rule_label,
        storage_fee_rule_label=payload.storage_fee_rule_label,
        referral_fee_usd=Decimal(str(payload.referral_fee_usd)),
        advertising_fee_usd=Decimal(str(payload.advertising_fee_usd)),
        return_loss_usd=Decimal(str(payload.return_loss_usd)),
        fba_fulfillment_fee_usd=Decimal(str(payload.fba_fulfillment_fee_usd)),
        inbound_config_fee_usd=Decimal(str(payload.inbound_config_fee_usd)),
        storage_fee_usd=Decimal(str(payload.storage_fee_usd)),
        total_fee_usd=Decimal(str(payload.total_fee_usd)),
        payout_usd=Decimal(str(payload.payout_usd)),
        profit_usd=Decimal(str(payload.profit_usd)),
        profit_rate=Decimal(str(payload.profit_rate)),
        delivery_fee_usd=Decimal(str(payload.delivery_fee_usd)),
        inbound_config_fee_manual_usd=Decimal(
            str(payload.inbound_config_fee_manual_usd)
        ),
        storage_fee_manual_usd=Decimal(str(payload.storage_fee_manual_usd)),
        vat_usd=Decimal(str(payload.vat_usd)),
        profit_after_vat_usd=Decimal(str(payload.profit_after_vat_usd))
        if payload.profit_after_vat_usd is not None
        else None,
        profit_after_vat_rate=Decimal(str(payload.profit_after_vat_rate))
        if payload.profit_after_vat_rate is not None
        else None,
        warnings_json=payload.warnings,
        notes=payload.notes,
        source=payload.source,
        observed_at=payload.observed_at,
        created_by=(operator or "").strip() or None,
    )


def _update_snapshot(
    existing: NewProductCalculation,
    payload: NewProductCalculationCreateRequest,
    operator: str | None,
) -> None:
    existing.asin = payload.asin
    existing.country = payload.country
    existing.package_length_cm = Decimal(str(payload.package_length_cm))
    existing.package_width_cm = Decimal(str(payload.package_width_cm))
    existing.package_height_cm = Decimal(str(payload.package_height_cm))
    existing.weight_kg = Decimal(str(payload.weight_kg))
    existing.fob_product_cost_rmb = Decimal(str(payload.fob_product_cost_rmb))
    existing.first_leg_cost_rmb = Decimal(str(payload.first_leg_cost_rmb))
    existing.ddp_cost_rmb = Decimal(str(payload.ddp_cost_rmb))
    existing.ddp_cost_usd = Decimal(str(payload.ddp_cost_usd))
    existing.sale_price_usd = Decimal(str(payload.sale_price_usd))
    existing.target_profit_rate = (
        Decimal(str(payload.target_profit_rate))
        if payload.target_profit_rate is not None
        else None
    )
    existing.advertising_rate = Decimal(str(payload.advertising_rate))
    existing.return_loss_rate = Decimal(str(payload.return_loss_rate))
    existing.storage_months = Decimal(str(payload.storage_months))
    existing.inbound_placement_mode = payload.inbound_placement_mode
    existing.usd_to_rmb_rate = Decimal(str(payload.usd_to_rmb_rate))
    existing.usd_to_rmb_rate_source = payload.usd_to_rmb_rate_source
    existing.size_tier = payload.size_tier
    existing.size_tier_label = payload.size_tier_label
    existing.price_band = payload.price_band
    existing.price_band_label = payload.price_band_label
    existing.longest_side_in = Decimal(str(payload.longest_side_in))
    existing.middle_side_in = Decimal(str(payload.middle_side_in))
    existing.shortest_side_in = Decimal(str(payload.shortest_side_in))
    existing.length_plus_girth_in = Decimal(str(payload.length_plus_girth_in))
    existing.volume_cubic_in = Decimal(str(payload.volume_cubic_in))
    existing.volume_cubic_ft = Decimal(str(payload.volume_cubic_ft))
    existing.product_weight_lb = Decimal(str(payload.product_weight_lb))
    existing.product_weight_oz = Decimal(str(payload.product_weight_oz))
    existing.dimensional_weight_lb = Decimal(str(payload.dimensional_weight_lb))
    existing.chargeable_weight_lb = Decimal(str(payload.chargeable_weight_lb))
    existing.chargeable_weight_oz = Decimal(str(payload.chargeable_weight_oz))
    existing.chargeable_weight_rule = payload.chargeable_weight_rule
    existing.fulfillment_fee_rule_label = payload.fulfillment_fee_rule_label
    existing.inbound_config_fee_rule_label = payload.inbound_config_fee_rule_label
    existing.storage_fee_rule_label = payload.storage_fee_rule_label
    existing.referral_fee_usd = Decimal(str(payload.referral_fee_usd))
    existing.advertising_fee_usd = Decimal(str(payload.advertising_fee_usd))
    existing.return_loss_usd = Decimal(str(payload.return_loss_usd))
    existing.fba_fulfillment_fee_usd = Decimal(str(payload.fba_fulfillment_fee_usd))
    existing.inbound_config_fee_usd = Decimal(str(payload.inbound_config_fee_usd))
    existing.storage_fee_usd = Decimal(str(payload.storage_fee_usd))
    existing.total_fee_usd = Decimal(str(payload.total_fee_usd))
    existing.payout_usd = Decimal(str(payload.payout_usd))
    existing.profit_usd = Decimal(str(payload.profit_usd))
    existing.profit_rate = Decimal(str(payload.profit_rate))
    existing.delivery_fee_usd = Decimal(str(payload.delivery_fee_usd))
    existing.inbound_config_fee_manual_usd = Decimal(
        str(payload.inbound_config_fee_manual_usd)
    )
    existing.storage_fee_manual_usd = Decimal(str(payload.storage_fee_manual_usd))
    existing.vat_usd = Decimal(str(payload.vat_usd))
    existing.profit_after_vat_usd = (
        Decimal(str(payload.profit_after_vat_usd))
        if payload.profit_after_vat_usd is not None
        else None
    )
    existing.profit_after_vat_rate = (
        Decimal(str(payload.profit_after_vat_rate))
        if payload.profit_after_vat_rate is not None
        else None
    )
    existing.warnings_json = payload.warnings
    existing.notes = payload.notes
    if payload.source is not None:
        existing.source = payload.source
    if payload.observed_at is not None:
        existing.observed_at = payload.observed_at
    if operator:
        existing.created_by = (operator or "").strip() or None


def list_snapshots(
    db: Session,
    *,
    project_id: int | None = None,
    calculation_type: str | None = None,
    country: str | None = None,
    page: int = 1,
    page_size: int = 200,
) -> tuple[list[NewProductCalculationItem], int]:
    """查询新品核算快照列表（2026-08-03 改名）"""
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 500)

    stmt = select(NewProductCalculation)

    if project_id is not None:
        stmt = stmt.where(NewProductCalculation.project_id == project_id)
    if calculation_type is not None:
        stmt = stmt.where(NewProductCalculation.calculation_type == calculation_type)
    if country is not None:
        stmt = stmt.where(NewProductCalculation.country == country)

    # 统计总数
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar_one() or 0)

    # 分页查询
    rows = (
        db.execute(
            stmt.order_by(
                NewProductCalculation.updated_at.desc(), NewProductCalculation.id.desc()
            )
            .offset((safe_page - 1) * safe_page_size)
            .limit(safe_page_size)
        )
        .scalars()
        .all()
    )

    return [_to_item(row) for row in rows], total


def get_snapshot(
    db: Session,
    project_id: int,
    sku: str,
    calculation_type: str,
) -> NewProductCalculationItem | None:
    """获取单个新品核算快照（2026-08-03 改名）"""
    row = db.execute(
        select(NewProductCalculation).where(
            NewProductCalculation.project_id == project_id,
            NewProductCalculation.sku == sku,
            NewProductCalculation.calculation_type == calculation_type,
        )
    ).scalar_one_or_none()

    return _to_item(row) if row else None


def delete_snapshot(db: Session, snapshot_id: int) -> bool:
    """删除新品核算快照（2026-08-03 改名）"""
    row = db.get(NewProductCalculation, snapshot_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True
