from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models.shop_calculation import ShopCalculation
from app.schemas.shop_calculation import (
    ShopCalculationCreateRequest,
    ShopCalculationItem,
)


def _to_item(row: ShopCalculation) -> ShopCalculationItem:
    """将数据库模型转换为 API 响应"""
    return ShopCalculationItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        sku=row.sku,
        asin=row.asin,
        country=row.country,
        accounting_type=row.accounting_type,
        package_length_cm=float(row.package_length_cm),
        package_width_cm=float(row.package_width_cm),
        package_height_cm=float(row.package_height_cm),
        weight_kg=float(row.weight_kg),
        fob_product_cost_rmb=float(row.fob_product_cost_rmb),
        first_leg_cost_rmb=float(row.first_leg_cost_rmb),
        ddp_cost_rmb=float(row.ddp_cost_rmb),
        ddp_cost_usd=float(row.ddp_cost_usd),
        sale_price_usd=float(row.sale_price_usd),
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
            "platform_fee_usd": float(
                getattr(row, "platform_fee_usd", Decimal("0")) or Decimal("0")
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
        created_by=row.created_by,
        observed_at=row.observed_at,
        source=row.source,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ── append-only「当前态」查询辅助 ─────────────────────────────────────────────
#
# shop_calculation 改为 append-only 后，每个 (project_id, sku, country) 会有多行
# 历史。「当前态」= 每组最新的有效行。append-only 下 id 单调递增，故 MAX(id) 即最新；
# deleted_at IS NULL 过滤软删。用 MAX(id) 子查询而非 DISTINCT ON，跨 SQLite/Postgres 可用。


def latest_ids_subquery():
    """每个 (project_id, sku, country) 最新有效行 id 的子查询。"""
    return (
        select(func.max(ShopCalculation.id))
        .where(ShopCalculation.deleted_at.is_(None))
        .group_by(
            ShopCalculation.project_id,
            ShopCalculation.sku,
            ShopCalculation.country,
        )
    )


def latest_stmt():
    """「当前态」基础 SELECT（每 SKU 最新有效行）；调用方自行追加 where / order。"""
    return select(ShopCalculation).where(
        ShopCalculation.deleted_at.is_(None),
        ShopCalculation.id.in_(latest_ids_subquery()),
    )


# ── 写入（append-only）────────────────────────────────────────────────────────


def append_calculation(
    db: Session,
    payload: ShopCalculationCreateRequest,
    *,
    operator: str | None = None,
) -> ShopCalculationItem:
    """append-only 写入：每次新增一行（带 observed_at + source），不再覆盖历史。

    手动编辑 / AI Agent 抓价 / 外部 API 写入都走这里，共用一张表。
    """
    row = _create(payload, operator)
    db.add(row)
    db.flush()
    db.refresh(row)
    return _to_item(row)


def _create(
    payload: ShopCalculationCreateRequest,
    operator: str | None,
) -> ShopCalculation:
    row = ShopCalculation(
        project_id=payload.project_id,
        project_name=payload.project_name,
        sku=payload.sku,
        asin=payload.asin,
        country=payload.country,
        accounting_type=payload.accounting_type,
        package_length_cm=Decimal(str(payload.package_length_cm)),
        package_width_cm=Decimal(str(payload.package_width_cm)),
        package_height_cm=Decimal(str(payload.package_height_cm)),
        weight_kg=Decimal(str(payload.weight_kg)),
        fob_product_cost_rmb=Decimal(str(payload.fob_product_cost_rmb)),
        first_leg_cost_rmb=Decimal(str(payload.first_leg_cost_rmb)),
        ddp_cost_rmb=Decimal(str(payload.ddp_cost_rmb)),
        ddp_cost_usd=Decimal(str(payload.ddp_cost_usd)),
        sale_price_usd=Decimal(str(payload.sale_price_usd)),
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
        delivery_fee_usd=Decimal(str(payload.delivery_fee_usd)),
        inbound_config_fee_manual_usd=Decimal(
            str(payload.inbound_config_fee_manual_usd)
        ),
        storage_fee_manual_usd=Decimal(str(payload.storage_fee_manual_usd)),
        platform_fee_usd=Decimal(str(payload.platform_fee_usd)),
        payout_usd=Decimal(str(payload.payout_usd)),
        profit_usd=Decimal(str(payload.profit_usd)),
        profit_rate=Decimal(str(payload.profit_rate)),
        vat_usd=Decimal(str(payload.vat_usd)),
        profit_after_vat_usd=Decimal(str(payload.profit_after_vat_usd))
        if payload.profit_after_vat_usd is not None
        else None,
        profit_after_vat_rate=Decimal(str(payload.profit_after_vat_rate))
        if payload.profit_after_vat_rate is not None
        else None,
        warnings_json=payload.warnings,
        notes=payload.notes,
        created_by=(operator or "").strip() or None,
        source=(payload.source or "manual").strip() or "manual",
    )
    # observed_at：payload 提供则用之（Agent 补录历史价），否则留空让 server_default=now() 生效
    if payload.observed_at is not None:
        row.observed_at = payload.observed_at
    return row


# ── 读取 ──────────────────────────────────────────────────────────────────────


def list_by_project(
    db: Session,
    *,
    project_id: int | None = None,
    country: str | None = None,
    page: int = 1,
    page_size: int = 200,
) -> tuple[list[ShopCalculationItem], int]:
    """查询店铺测算「当前态」列表（每 SKU 最新有效行，软删过滤）。"""
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 500)

    stmt = latest_stmt()
    if project_id is not None:
        stmt = stmt.where(ShopCalculation.project_id == project_id)
    if country is not None:
        stmt = stmt.where(ShopCalculation.country == country)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar_one() or 0)

    rows = (
        db.execute(
            stmt.order_by(ShopCalculation.observed_at.desc(), ShopCalculation.id.desc())
            .offset((safe_page - 1) * safe_page_size)
            .limit(safe_page_size)
        )
        .scalars()
        .all()
    )

    return [_to_item(row) for row in rows], total


def list_history(
    db: Session,
    *,
    project_id: int,
    sku: str | None = None,
    country: str | None = None,
    include_deleted: bool = False,
) -> list[ShopCalculationItem]:
    """查询某店铺（可指定 SKU / 国家）的全部历史行，按 observed_at 倒序。

    默认排除软删行；``include_deleted=True`` 时连同已删除行一起返回（审计用）。
    """
    stmt = select(ShopCalculation).where(ShopCalculation.project_id == project_id)
    if sku is not None:
        stmt = stmt.where(ShopCalculation.sku == sku)
    if country is not None:
        stmt = stmt.where(ShopCalculation.country == country)
    if not include_deleted:
        stmt = stmt.where(ShopCalculation.deleted_at.is_(None))
    stmt = stmt.order_by(ShopCalculation.observed_at.desc(), ShopCalculation.id.desc())
    rows = db.execute(stmt).scalars().all()
    return [_to_item(row) for row in rows]


# ── 删除（软删除）──────────────────────────────────────────────────────────────


def soft_delete_group(db: Session, item_id: int) -> int:
    """软删除 item_id 所属 (project_id, sku, country) 组的全部有效行。

    列表只展示每 SKU 的最新行，故传入的 item_id 必为最新行；软删整组等价于
    「从当前列表移除该 SKU」，同时保留全部历史（deleted_at 标记，可恢复）。
    返回被软删的行数（0 表示 item_id 不存在）。
    """
    row = db.get(ShopCalculation, item_id)
    if row is None:
        return 0
    result = db.execute(
        update(ShopCalculation)
        .where(
            ShopCalculation.project_id == row.project_id,
            ShopCalculation.sku == row.sku,
            ShopCalculation.country == row.country,
            ShopCalculation.deleted_at.is_(None),
        )
        .values(deleted_at=datetime.now(timezone.utc))
    )
    db.flush()
    return int(result.rowcount or 0)
