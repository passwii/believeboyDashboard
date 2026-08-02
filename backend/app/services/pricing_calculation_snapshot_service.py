"""Pricing calculation snapshot service.

提供店铺定价历史快照的创建 / 列表 / 详情 / 更新 / 删除。

数据源：``shop_calculation``（US + EU 统一 upsert 表，shop-calculation 页面
"测算"按钮的实际写入目标）。注意：旧表 ``store_sku_pricing_snapshots`` 在
shop-calculation 页面迁到 ``/api/v1/shop-calculation`` 之后已不再被写入，
仍保留历史数据但不是当前态来源。

append-only 模式：每次创建新增 header + items，旧快照不被覆盖。
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    PricingCalculationSnapshot,
    PricingCalculationSnapshotItem,
    ShopCalculation,
)
from app.schemas.pricing_calculation_snapshot import (
    PricingCalculationSnapshotDetail,
    PricingCalculationSnapshotItemsResponse,
    PricingCalculationSnapshotListItem,
    PricingCalculationSnapshotSummary,
)
from app.schemas.shop_calculation import (
    ShopCalculationDimensions,
    ShopCalculationFees,
    ShopCalculationProfit,
    ShopCalculationWeight,
    ShopCalculationItem,
)
from app.utils.text_utils import normalize_text
from app.services import shop_calculation_service


# ── Summary helpers ──────────────────────────────────────────────────────────


def _compute_summary(items: list[ShopCalculation]) -> dict[str, Any]:
    """基于快照明细计算 stat bar 4 字段

    total / calculated 都用 ``row_count`` —— 快照中"已测算"的 SKU 总数。
    profitable 取 EU 走 ``profit_after_vat_usd``、US 走 ``profit_usd``，与前端
    loadStats 行为一致。
    """
    total = len(items)
    profitable = 0
    for row in items:
        profit = (
            row.profit_after_vat_usd
            if row.profit_after_vat_usd is not None
            else row.profit_usd
        )
        if profit is not None and profit >= 0:
            profitable += 1
    pass_rate = (profitable / total * 100.0) if total > 0 else 0.0
    return {
        "total": total,
        "calculated": total,
        "profitable": profitable,
        "passRate": pass_rate,
    }


def _summary_from_dict(
    data: dict[str, Any] | None,
) -> PricingCalculationSnapshotSummary:
    if not data:
        return PricingCalculationSnapshotSummary()
    return PricingCalculationSnapshotSummary(
        total=int(data.get("total", 0) or 0),
        calculated=int(data.get("calculated", 0) or 0),
        profitable=int(data.get("profitable", 0) or 0),
        passRate=float(data.get("passRate", 0.0) or 0.0),
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

    从 ``shop_calculation`` 读取 ``(project_id, country)`` 当前态，
    复制为新的快照（append-only）。原表不受影响。

    Raises
    ------
    HTTPException 404
        项目下没有可快照的 SKU 记录时
    """
    # 读取「当前态」行（shop_calculation 改 append-only 后，取每 SKU 最新有效行；
    # latest_stmt 已含软删过滤。仍按 country 过滤、按 sku 排序）
    current_rows = (
        db.execute(
            shop_calculation_service.latest_stmt()
            .where(
                ShopCalculation.project_id == project_id,
                ShopCalculation.country == country,
            )
            .order_by(ShopCalculation.sku.asc())
        )
        .scalars()
        .all()
    )

    if not current_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"项目 {project_id} 在 {country} 站点下没有可快照的核算记录",
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
    # 注：snapshot items 表的 calculation_type 列存的是 ShopCalculation.accounting_type 的值
    # （'profit_calc' / 'eu_accounting'），列名沿用 calculation_type 仅因历史原因，实际含义
    # 跟 ShopCalculation.accounting_type 一致
    for idx, row in enumerate(current_rows):
        item = PricingCalculationSnapshotItem(
            snapshot_id=snapshot.id,
            source_row_no=idx,
            project_id=row.project_id,
            project_name=row.project_name,
            sku=row.sku,
            asin=row.asin,
            country=row.country,
            calculation_type=row.accounting_type,
            package_length_cm=row.package_length_cm,
            package_width_cm=row.package_width_cm,
            package_height_cm=row.package_height_cm,
            weight_kg=row.weight_kg,
            fob_product_cost_rmb=row.fob_product_cost_rmb,
            first_leg_cost_rmb=row.first_leg_cost_rmb,
            ddp_cost_rmb=row.ddp_cost_rmb,
            ddp_cost_usd=row.ddp_cost_usd,
            sale_price_usd=row.sale_price_usd,
            # ShopCalculation 没有 target_profit_rate 列，置空
            target_profit_rate=None,
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
            platform_fee_usd=row.platform_fee_usd,
            delivery_fee_usd=row.delivery_fee_usd,
            inbound_config_fee_manual_usd=row.inbound_config_fee_manual_usd,
            storage_fee_manual_usd=row.storage_fee_manual_usd,
            payout_usd=row.payout_usd,
            profit_usd=row.profit_usd,
            profit_rate=row.profit_rate,
            vat_usd=row.vat_usd,
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
            created_at=row.created_at.isoformat() if row.created_at else "",
            summary=_summary_from_dict(row.summary_json),
        )
        for row in rows
    ]


def get_snapshot_detail(
    db: Session,
    snapshot_id: int,
) -> PricingCalculationSnapshotDetail | None:
    """获取快照详情（含 items，items 形状 = ShopCalculationItem）"""
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
        created_at=row.created_at.isoformat() if row.created_at else "",
        summary=_summary_from_dict(row.summary_json),
        items=[_snapshot_item_to_dto(item) for item in items],
    )


def get_snapshot_items(
    db: Session,
    snapshot_id: int,
) -> PricingCalculationSnapshotItemsResponse | None:
    """获取快照明细 + summary + 元数据（前端回放用）

    items 形状与 ``/api/v1/shop-calculation`` 列表完全一致（``ShopCalculationItem``），
    前端可直接按 ``ShopCalculationItem`` 消费。
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

    item_dtos = [_snapshot_item_to_dto(item) for item in items]
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    if name is not None:
        row.name = normalize_text(name, max_length=255) if name else None
    if description is not None:
        row.description = description.strip() if description else None
    if operator:
        row.created_by = (
            normalize_text(operator, max_length=255) if operator else row.created_by
        )

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
        created_at=row.created_at.isoformat() if row.created_at else "",
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


def _snapshot_item_to_dto(item: PricingCalculationSnapshotItem) -> ShopCalculationItem:
    """把 ``pricing_calculation_snapshot_items`` 行映射成 ``ShopCalculationItem``。

    形状与 ``/api/v1/shop-calculation`` 列表端点完全一致，前端可无修改地消费。
    """
    # synthetic id：snapshot_id * 1M + source_row_no，保证同一快照内稳定
    synthetic_id = item.snapshot_id * 1_000_000 + item.source_row_no

    return ShopCalculationItem(
        id=synthetic_id,
        project_id=item.project_id,
        project_name=item.project_name,
        sku=item.sku,
        asin=item.asin,
        # 'US' / 'DE' / 'UK' 之一；如果旧数据存了 'us' 等小写，强制大写
        country=item.country.upper() if item.country else "US",  # type: ignore[arg-type]
        # snapshot items 表的 calculation_type 列实际存的是 ShopCalculation.accounting_type
        # 的值（'profit_calc' / 'eu_accounting'），所以可以直接映射
        accounting_type=item.calculation_type or "profit_calc",  # type: ignore[arg-type]
        package_length_cm=float(item.package_length_cm),
        package_width_cm=float(item.package_width_cm),
        package_height_cm=float(item.package_height_cm),
        weight_kg=float(item.weight_kg),
        fob_product_cost_rmb=float(item.fob_product_cost_rmb),
        first_leg_cost_rmb=float(item.first_leg_cost_rmb),
        ddp_cost_rmb=float(item.ddp_cost_rmb),
        ddp_cost_usd=float(item.ddp_cost_usd),
        sale_price_usd=float(item.sale_price_usd),
        advertising_rate=float(item.advertising_rate),
        return_loss_rate=float(item.return_loss_rate),
        storage_months=float(item.storage_months),
        inbound_placement_mode=item.inbound_placement_mode,  # type: ignore[arg-type]
        usd_to_rmb_rate=float(item.usd_to_rmb_rate),
        usd_to_rmb_rate_source=item.usd_to_rmb_rate_source,
        size_tier=item.size_tier,
        size_tier_label=item.size_tier_label,
        price_band=item.price_band,
        price_band_label=item.price_band_label,
        fulfillment_fee_rule_label=item.fulfillment_fee_rule_label,
        inbound_config_fee_rule_label=item.inbound_config_fee_rule_label,
        storage_fee_rule_label=item.storage_fee_rule_label,
        dimensions=ShopCalculationDimensions(
            longest_side_in=float(item.longest_side_in),
            middle_side_in=float(item.middle_side_in),
            shortest_side_in=float(item.shortest_side_in),
            length_plus_girth_in=float(item.length_plus_girth_in),
            volume_cubic_in=float(item.volume_cubic_in),
            volume_cubic_ft=float(item.volume_cubic_ft),
        ),
        weights=ShopCalculationWeight(
            product_weight_lb=float(item.product_weight_lb),
            product_weight_oz=float(item.product_weight_oz),
            dimensional_weight_lb=float(item.dimensional_weight_lb),
            chargeable_weight_lb=float(item.chargeable_weight_lb),
            chargeable_weight_oz=float(item.chargeable_weight_oz),
            chargeable_weight_rule=item.chargeable_weight_rule,
        ),
        fees=ShopCalculationFees(
            referral_fee_usd=float(item.referral_fee_usd),
            advertising_fee_usd=float(item.advertising_fee_usd),
            return_loss_usd=float(item.return_loss_usd),
            fba_fulfillment_fee_usd=float(item.fba_fulfillment_fee_usd),
            inbound_config_fee_usd=float(item.inbound_config_fee_usd),
            storage_fee_usd=float(item.storage_fee_usd),
            total_fee_usd=float(item.total_fee_usd),
            delivery_fee_usd=float(item.delivery_fee_usd),
            inbound_config_fee_manual_usd=float(item.inbound_config_fee_manual_usd),
            storage_fee_manual_usd=float(item.storage_fee_manual_usd),
            platform_fee_usd=float(item.platform_fee_usd),
        ),
        profit=ShopCalculationProfit(
            ddp_cost_rmb=float(item.ddp_cost_rmb),
            ddp_cost_usd=float(item.ddp_cost_usd),
            payout_usd=float(item.payout_usd),
            profit_usd=float(item.profit_usd),
            profit_rate=float(item.profit_rate),
            vat_usd=float(item.vat_usd),
            profit_after_vat_usd=float(item.profit_after_vat_usd)
            if item.profit_after_vat_usd is not None
            else None,
            profit_after_vat_rate=float(item.profit_after_vat_rate)
            if item.profit_after_vat_rate is not None
            else None,
        ),
        warnings=item.warnings_json or [],
        notes=item.notes,
        # items 表没存 created_by / created_at / updated_at；返回 None 让前端用快照 header 的时间
        created_by=None,
        # BEL-378：快照回放无独立 observed_at/source，用快照创建时刻 + 'manual' 兜底
        observed_at=item.created_at,
        source="manual",
        created_at=item.created_at,
        updated_at=item.created_at,
    )
