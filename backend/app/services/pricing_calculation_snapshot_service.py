"""Pricing calculation snapshot service.

提供店铺定价历史快照的创建 / 列表 / 详情 / 更新 / 删除。
区别于 ``store_sku_pricing_snapshot_service``（每个 SKU 只有"最新一条"的当前态缓存），
本服务的快照是 append-only 模式：每次创建新增 header + items，旧快照不被覆盖。
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    PricingCalculationSnapshot,
    PricingCalculationSnapshotItem,
    StoreSkuPricingSnapshot,
)
from app.schemas.pricing_calculation_snapshot import (
    PricingCalculationSnapshotDetail,
    PricingCalculationSnapshotItemsResponse,
    PricingCalculationSnapshotListItem,
    PricingCalculationSnapshotSummary,
)
from app.schemas.store_sku_pricing_snapshot import StoreSkuPricingSnapshotItem
from app.services import store_sku_pricing_snapshot_service as _cur_svc
from app.utils.text_utils import normalize_text


# ── Summary helpers ──────────────────────────────────────────────────────────


def _compute_summary(items: list[StoreSkuPricingSnapshot]) -> dict[str, Any]:
    """基于快照明细计算 stat bar 4 字段

    total / calculated 都用 ``row_count`` —— 快照中"已测算"的 SKU 总数。
    profitable 取 EU 走 ``profit_after_vat_usd``、US 走 ``profit_usd``，与前端
    loadStats 行为一致。
    """
    total = len(items)
    profitable = 0
    for row in items:
        profit = row.profit_after_vat_usd if row.profit_after_vat_usd is not None else row.profit_usd
        if profit is not None and profit >= 0:
            profitable += 1
    pass_rate = (profitable / total * 100.0) if total > 0 else 0.0
    return {
        'total': total,
        'calculated': total,
        'profitable': profitable,
        'passRate': pass_rate,
    }


def _summary_from_dict(data: dict[str, Any] | None) -> PricingCalculationSnapshotSummary:
    if not data:
        return PricingCalculationSnapshotSummary()
    return PricingCalculationSnapshotSummary(
        total=int(data.get('total', 0) or 0),
        calculated=int(data.get('calculated', 0) or 0),
        profitable=int(data.get('profitable', 0) or 0),
        passRate=float(data.get('passRate', 0.0) or 0.0),
    )


# ── Snapshot CRUD ────────────────────────────────────────────────────────────


def create_snapshot(
    db: Session,
    *,
    project_id: int,
    country: str,
    name: str | None,
    description: str | None,
    operator: str | None,
) -> PricingCalculationSnapshot:
    """创建定价历史快照。

    从 ``store_sku_pricing_snapshots`` 读取 ``(project_id, country)`` 的当前态，
    复制一份到 ``pricing_calculation_snapshot_items``。原"当前态缓存"表不受影响。

    Raises
    ------
    HTTPException 404
        项目下没有可快照的 SKU 记录时
    """
    # 读取当前态行
    current_rows = db.execute(
        select(StoreSkuPricingSnapshot)
        .where(
            StoreSkuPricingSnapshot.project_id == project_id,
            StoreSkuPricingSnapshot.country == country,
        )
        .order_by(StoreSkuPricingSnapshot.sku.asc())
    ).scalars().all()

    if not current_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f'项目 {project_id} 在 {country} 站点下没有可快照的核算记录',
        )

    project_name = current_rows[0].project_name

    # 计算 summary
    summary = _compute_summary(current_rows)

    # 建 header
    snapshot = PricingCalculationSnapshot(
        project_id=project_id,
        project_name=project_name,
        country=country,
        name=normalize_text(name, max_length=255) if name else None,
        description=description.strip() if description else None,
        summary_json=summary,
        row_count=len(current_rows),
        created_by=normalize_text(operator, max_length=255) if operator else None,
    )
    db.add(snapshot)
    db.flush()  # 拿 id

    # 批量复制明细
    for idx, row in enumerate(current_rows):
        item = PricingCalculationSnapshotItem(
            snapshot_id=snapshot.id,
            source_row_no=idx,
            project_id=row.project_id,
            project_name=row.project_name,
            sku=row.sku,
            asin=row.asin,
            country=row.country,
            calculation_type=row.calculation_type,
            package_length_cm=row.package_length_cm,
            package_width_cm=row.package_width_cm,
            package_height_cm=row.package_height_cm,
            weight_kg=row.weight_kg,
            fob_product_cost_rmb=row.fob_product_cost_rmb,
            first_leg_cost_rmb=row.first_leg_cost_rmb,
            ddp_cost_rmb=row.ddp_cost_rmb,
            ddp_cost_usd=row.ddp_cost_usd,
            sale_price_usd=row.sale_price_usd,
            target_profit_rate=row.target_profit_rate,
            advertising_rate=row.advertising_rate,
            return_loss_rate=row.return_loss_rate,
            storage_months=row.storage_months,
            inbound_placement_mode=row.inbound_placement_mode,
            usd_to_rmb_rate=row.usd_to_rmb_rate,
            usd_to_rmb_rate_source=row.usd_to_rmb_rate_source,
            size_tier=row.size_tier,
            size_tier_label=row.size_tier_label,
            price_band=row.price_band,
            price_band_label=row.price_band_label,
            longest_side_in=row.longest_side_in,
            middle_side_in=row.middle_side_in,
            shortest_side_in=row.shortest_side_in,
            length_plus_girth_in=row.length_plus_girth_in,
            volume_cubic_in=row.volume_cubic_in,
            volume_cubic_ft=row.volume_cubic_ft,
            product_weight_lb=row.product_weight_lb,
            product_weight_oz=row.product_weight_oz,
            dimensional_weight_lb=row.dimensional_weight_lb,
            chargeable_weight_lb=row.chargeable_weight_lb,
            chargeable_weight_oz=row.chargeable_weight_oz,
            chargeable_weight_rule=row.chargeable_weight_rule,
            fulfillment_fee_rule_label=row.fulfillment_fee_rule_label,
            inbound_config_fee_rule_label=row.inbound_config_fee_rule_label,
            storage_fee_rule_label=row.storage_fee_rule_label,
            referral_fee_usd=row.referral_fee_usd,
            advertising_fee_usd=row.advertising_fee_usd,
            return_loss_usd=row.return_loss_usd,
            fba_fulfillment_fee_usd=row.fba_fulfillment_fee_usd,
            inbound_config_fee_usd=row.inbound_config_fee_usd,
            storage_fee_usd=row.storage_fee_usd,
            total_fee_usd=row.total_fee_usd,
            # platform_fee_usd 列是新加的；旧行没有值时取 0
            platform_fee_usd=getattr(row, 'platform_fee_usd', None) or 0,
            delivery_fee_usd=getattr(row, 'delivery_fee_usd', None) or 0,
            inbound_config_fee_manual_usd=getattr(row, 'inbound_config_fee_manual_usd', None) or 0,
            storage_fee_manual_usd=getattr(row, 'storage_fee_manual_usd', None) or 0,
            payout_usd=row.payout_usd,
            profit_usd=row.profit_usd,
            profit_rate=row.profit_rate,
            vat_usd=getattr(row, 'vat_usd', None) or 0,
            profit_after_vat_usd=row.profit_after_vat_usd,
            profit_after_vat_rate=row.profit_after_vat_rate,
            warnings_json=row.warnings_json,
            notes=row.notes,
        )
        db.add(item)

    db.commit()
    db.refresh(snapshot)
    return snapshot


def list_snapshots(
    db: Session,
    *,
    project_id: int,
    country: str,
    page: int = 1,
    page_size: int = 50,
) -> list[PricingCalculationSnapshotListItem]:
    """列出某 (project, country) 下的全部历史快照，按 snapshot_date desc"""
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 100)

    rows = (
        db.execute(
            select(PricingCalculationSnapshot)
            .where(
                PricingCalculationSnapshot.project_id == project_id,
                PricingCalculationSnapshot.country == country,
            )
            .order_by(
                PricingCalculationSnapshot.snapshot_date.desc(),
                PricingCalculationSnapshot.id.desc(),
            )
            .offset((safe_page - 1) * safe_page_size)
            .limit(safe_page_size)
        )
        .scalars()
        .all()
    )

    return [
        PricingCalculationSnapshotListItem(
            id=row.id,
            project_id=row.project_id,
            project_name=row.project_name,
            country=row.country,
            snapshot_date=row.snapshot_date,
            name=row.name,
            description=row.description,
            row_count=row.row_count,
            created_by=row.created_by,
            created_at=row.created_at.isoformat() if row.created_at else '',
            summary=_summary_from_dict(row.summary_json),
        )
        for row in rows
    ]


def get_snapshot_detail(
    db: Session,
    snapshot_id: int,
) -> PricingCalculationSnapshotDetail | None:
    """获取快照详情（含 items）"""
    row = db.get(PricingCalculationSnapshot, snapshot_id)
    if row is None:
        return None

    items = (
        db.execute(
            select(PricingCalculationSnapshotItem)
            .where(PricingCalculationSnapshotItem.snapshot_id == snapshot_id)
            .order_by(PricingCalculationSnapshotItem.source_row_no.asc())
        )
        .scalars()
        .all()
    )

    # items 表里存的列与 StoreSkuPricingSnapshotItem 形状一致；通过 _cur_svc._to_item 复用映射
    item_dtos: list[StoreSkuPricingSnapshotItem] = [
        _cur_svc._to_item(_item_row_to_proxy(item)) for item in items
    ]

    return PricingCalculationSnapshotDetail(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        snapshot_date=row.snapshot_date,
        name=row.name,
        description=row.description,
        row_count=row.row_count,
        created_by=row.created_by,
        created_at=row.created_at.isoformat() if row.created_at else '',
        summary=_summary_from_dict(row.summary_json),
        items=item_dtos,
    )


def get_snapshot_items(
    db: Session,
    snapshot_id: int,
) -> PricingCalculationSnapshotItemsResponse | None:
    """获取快照明细 + summary + 元数据（前端回放用）

    items 形状与 ``store-sku-pricing-snapshots`` 列表保持一致，前端可直接按
    ``ShopCalculationItem`` 消费。
    """
    snapshot = db.get(PricingCalculationSnapshot, snapshot_id)
    if snapshot is None:
        return None

    items = (
        db.execute(
            select(PricingCalculationSnapshotItem)
            .where(PricingCalculationSnapshotItem.snapshot_id == snapshot_id)
            .order_by(PricingCalculationSnapshotItem.source_row_no.asc())
        )
        .scalars()
        .all()
    )

    item_dtos = [_cur_svc._to_item(_item_row_to_proxy(item)) for item in items]
    return PricingCalculationSnapshotItemsResponse(
        items=item_dtos,
        summary=_summary_from_dict(snapshot.summary_json),
        row_count=len(item_dtos),
        total=len(item_dtos),
        has_next=False,
        snapshot_id=snapshot.id,
        snapshot_date=snapshot.snapshot_date,
        snapshot_name=snapshot.name,
        snapshot_description=snapshot.description,
    )


def update_snapshot(
    db: Session,
    *,
    snapshot_id: int,
    name: str | None,
    description: str | None,
    operator: str | None,
) -> PricingCalculationSnapshotListItem:
    """更新快照名称或备注（仅管理员可调用，由 endpoint 层校验）"""
    row = db.get(PricingCalculationSnapshot, snapshot_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='快照不存在')

    if name is not None:
        row.name = normalize_text(name, max_length=255) if name else None
    if description is not None:
        row.description = description.strip() if description else None
    if operator:
        row.created_by = normalize_text(operator, max_length=255) if operator else row.created_by

    db.commit()
    db.refresh(row)
    return PricingCalculationSnapshotListItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        snapshot_date=row.snapshot_date,
        name=row.name,
        description=row.description,
        row_count=row.row_count,
        created_by=row.created_by,
        created_at=row.created_at.isoformat() if row.created_at else '',
        summary=_summary_from_dict(row.summary_json),
    )


def delete_snapshot(db: Session, snapshot_id: int) -> bool:
    """删除快照（级联删除 items）"""
    row = db.get(PricingCalculationSnapshot, snapshot_id)
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


# ── Internal helpers ─────────────────────────────────────────────────────────


def _item_row_to_proxy(item: PricingCalculationSnapshotItem) -> Any:
    """把 ``pricing_calculation_snapshot_items`` 行映射成 ``_cur_svc._to_item`` 期望的
    属性形状。两者字段几乎完全一致，差异主要在 ``platform_fee_usd``（旧行可能没有），
    用 ``SimpleNamespace`` 适配即可。
    """
    from types import SimpleNamespace

    return SimpleNamespace(
        id=item.snapshot_id * 1_000_000 + item.source_row_no,  # 给前端一个稳定 id 占位
        project_id=item.project_id,
        project_name=item.project_name,
        sku=item.sku,
        asin=item.asin,
        country=item.country,
        calculation_type=item.calculation_type,
        package_length_cm=item.package_length_cm,
        package_width_cm=item.package_width_cm,
        package_height_cm=item.package_height_cm,
        weight_kg=item.weight_kg,
        fob_product_cost_rmb=item.fob_product_cost_rmb,
        first_leg_cost_rmb=item.first_leg_cost_rmb,
        ddp_cost_rmb=item.ddp_cost_rmb,
        ddp_cost_usd=item.ddp_cost_usd,
        sale_price_usd=item.sale_price_usd,
        target_profit_rate=item.target_profit_rate,
        advertising_rate=item.advertising_rate,
        return_loss_rate=item.return_loss_rate,
        storage_months=item.storage_months,
        inbound_placement_mode=item.inbound_placement_mode,
        usd_to_rmb_rate=item.usd_to_rmb_rate,
        usd_to_rmb_rate_source=item.usd_to_rmb_rate_source,
        size_tier=item.size_tier,
        size_tier_label=item.size_tier_label,
        price_band=item.price_band,
        price_band_label=item.price_band_label,
        longest_side_in=item.longest_side_in,
        middle_side_in=item.middle_side_in,
        shortest_side_in=item.shortest_side_in,
        length_plus_girth_in=item.length_plus_girth_in,
        volume_cubic_in=item.volume_cubic_in,
        volume_cubic_ft=item.volume_cubic_ft,
        product_weight_lb=item.product_weight_lb,
        product_weight_oz=item.product_weight_oz,
        dimensional_weight_lb=item.dimensional_weight_lb,
        chargeable_weight_lb=item.chargeable_weight_lb,
        chargeable_weight_oz=item.chargeable_weight_oz,
        chargeable_weight_rule=item.chargeable_weight_rule,
        fulfillment_fee_rule_label=item.fulfillment_fee_rule_label,
        inbound_config_fee_rule_label=item.inbound_config_fee_rule_label,
        storage_fee_rule_label=item.storage_fee_rule_label,
        referral_fee_usd=item.referral_fee_usd,
        advertising_fee_usd=item.advertising_fee_usd,
        return_loss_usd=item.return_loss_usd,
        fba_fulfillment_fee_usd=item.fba_fulfillment_fee_usd,
        inbound_config_fee_usd=item.inbound_config_fee_usd,
        storage_fee_usd=item.storage_fee_usd,
        total_fee_usd=item.total_fee_usd,
        platform_fee_usd=item.platform_fee_usd,
        delivery_fee_usd=item.delivery_fee_usd,
        inbound_config_fee_manual_usd=item.inbound_config_fee_manual_usd,
        storage_fee_manual_usd=item.storage_fee_manual_usd,
        payout_usd=item.payout_usd,
        profit_usd=item.profit_usd,
        profit_rate=item.profit_rate,
        vat_usd=item.vat_usd,
        profit_after_vat_usd=item.profit_after_vat_usd,
        profit_after_vat_rate=item.profit_after_vat_rate,
        warnings_json=item.warnings_json,
        notes=item.notes,
        created_by=None,  # items 行没存 created_by
        created_at=item.created_at,
        updated_at=item.created_at,  # 共用 created_at，前端不依赖这个
    )
