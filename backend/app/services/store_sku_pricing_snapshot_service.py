from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import StoreSkuPricingSnapshot
from app.schemas.store_sku_pricing_snapshot import (
    StoreSkuPricingSnapshotCreateRequest,
    StoreSkuPricingSnapshotItem,
)


def _to_item(row: StoreSkuPricingSnapshot) -> StoreSkuPricingSnapshotItem:
    """将数据库模型转换为 API 响应"""
    return StoreSkuPricingSnapshotItem(
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
        target_profit_rate=float(row.target_profit_rate) if row.target_profit_rate is not None else None,
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
        dimensions={
            'longest_side_in': float(row.longest_side_in),
            'middle_side_in': float(row.middle_side_in),
            'shortest_side_in': float(row.shortest_side_in),
            'length_plus_girth_in': float(row.length_plus_girth_in),
            'volume_cubic_in': float(row.volume_cubic_in),
            'volume_cubic_ft': float(row.volume_cubic_ft),
        },
        weights={
            'product_weight_lb': float(row.product_weight_lb),
            'product_weight_oz': float(row.product_weight_oz),
            'dimensional_weight_lb': float(row.dimensional_weight_lb),
            'chargeable_weight_lb': float(row.chargeable_weight_lb),
            'chargeable_weight_oz': float(row.chargeable_weight_oz),
            'chargeable_weight_rule': row.chargeable_weight_rule,
        },
        fees={
            'referral_fee_usd': float(row.referral_fee_usd),
            'advertising_fee_usd': float(row.advertising_fee_usd),
            'return_loss_usd': float(row.return_loss_usd),
            'fba_fulfillment_fee_usd': float(row.fba_fulfillment_fee_usd),
            'inbound_config_fee_usd': float(row.inbound_config_fee_usd),
            'storage_fee_usd': float(row.storage_fee_usd),
            'total_fee_usd': float(row.total_fee_usd),
        },
        profit={
            'ddp_cost_rmb': float(row.ddp_cost_rmb),
            'ddp_cost_usd': float(row.ddp_cost_usd),
            'payout_usd': float(row.payout_usd),
            'profit_usd': float(row.profit_usd),
            'profit_rate': float(row.profit_rate),
        },
        warnings=row.warnings_json or [],
        notes=row.notes,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def upsert_snapshot(
    db: Session,
    payload: StoreSkuPricingSnapshotCreateRequest,
    *,
    operator: str | None = None,
) -> StoreSkuPricingSnapshotItem:
    """创建或更新店铺 SKU 核算快照（upsert）"""
    # 查询是否已存在相同 project_id + sku + calculation_type 的记录
    existing = db.execute(
        select(StoreSkuPricingSnapshot).where(
            StoreSkuPricingSnapshot.project_id == payload.project_id,
            StoreSkuPricingSnapshot.sku == payload.sku,
            StoreSkuPricingSnapshot.calculation_type == payload.calculation_type,
        )
    ).scalar_one_or_none()

    if existing:
        # 更新现有记录
        _update_snapshot(existing, payload, operator)
        db.flush()
        db.refresh(existing)
        return _to_item(existing)
    else:
        # 创建新记录
        row = _create_snapshot(payload, operator)
        db.add(row)
        db.flush()
        db.refresh(row)
        return _to_item(row)


def _create_snapshot(
    payload: StoreSkuPricingSnapshotCreateRequest,
    operator: str | None,
) -> StoreSkuPricingSnapshot:
    """创建新的快照记录"""
    return StoreSkuPricingSnapshot(
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
        target_profit_rate=Decimal(str(payload.target_profit_rate)) if payload.target_profit_rate is not None else None,
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
        warnings_json=payload.warnings,
        notes=payload.notes,
        created_by=(operator or '').strip() or None,
    )


def _update_snapshot(
    existing: StoreSkuPricingSnapshot,
    payload: StoreSkuPricingSnapshotCreateRequest,
    operator: str | None,
) -> None:
    """更新现有快照记录"""
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
    existing.target_profit_rate = Decimal(str(payload.target_profit_rate)) if payload.target_profit_rate is not None else None
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
    existing.warnings_json = payload.warnings
    existing.notes = payload.notes
    if operator:
        existing.created_by = (operator or '').strip() or None


def list_snapshots(
    db: Session,
    *,
    project_id: int | None = None,
    calculation_type: str | None = None,
    page: int = 1,
    page_size: int = 200,
) -> tuple[list[StoreSkuPricingSnapshotItem], int]:
    """查询店铺 SKU 核算快照列表"""
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 500)

    stmt = select(StoreSkuPricingSnapshot)

    if project_id is not None:
        stmt = stmt.where(StoreSkuPricingSnapshot.project_id == project_id)
    if calculation_type is not None:
        stmt = stmt.where(StoreSkuPricingSnapshot.calculation_type == calculation_type)

    # 统计总数
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar_one() or 0)

    # 分页查询
    rows = db.execute(
        stmt.order_by(StoreSkuPricingSnapshot.updated_at.desc(), StoreSkuPricingSnapshot.id.desc())
        .offset((safe_page - 1) * safe_page_size)
        .limit(safe_page_size)
    ).scalars().all()

    return [_to_item(row) for row in rows], total


def get_snapshot(
    db: Session,
    project_id: int,
    sku: str,
    calculation_type: str,
) -> StoreSkuPricingSnapshotItem | None:
    """获取单个店铺 SKU 核算快照"""
    row = db.execute(
        select(StoreSkuPricingSnapshot).where(
            StoreSkuPricingSnapshot.project_id == project_id,
            StoreSkuPricingSnapshot.sku == sku,
            StoreSkuPricingSnapshot.calculation_type == calculation_type,
        )
    ).scalar_one_or_none()

    return _to_item(row) if row else None


def delete_snapshot(db: Session, snapshot_id: int) -> bool:
    """删除店铺 SKU 核算快照"""
    row = db.get(StoreSkuPricingSnapshot, snapshot_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True
