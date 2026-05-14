"""
汇总计算模块

提供发货计划和 SKU 的汇总统计功能
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.models import Project
from app.models.sku_info import SkuRecord
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.models.shipment_sku_summary import ShipmentSkuSummary
from app.utils.country import normalize_country
from app.services.shipment.validation import (
    DECIMAL_ZERO,
    MONEY_QUANT,
    ROUND_HALF_UP,
    WEIGHT_QUANT,
    decimal_to_float,
    normalize_shipment_no_filters,
    normalize_shipping_method,
    normalize_status,
    parse_date,
)

if TYPE_CHECKING:
    pass


# ============================================================
# SKU 汇总刷新
# ============================================================

def refresh_shipment_sku_summary(db: Session) -> None:
    """
    刷新 ShipmentSkuSummary 表

    基于已完成且纳入历史费用计算的船期明细重新聚合
    """
    db.execute(delete(ShipmentSkuSummary))

    summary_rows = db.execute(
        select(
            ShipmentSchedule.project_id.label("project_id"),
            ShipmentSchedule.project_name_snapshot.label("project_name"),
            ShipmentSchedule.country.label("country"),
            ShipmentScheduleItem.sku.label("sku"),
            func.count(func.distinct(ShipmentScheduleItem.shipment_schedule_id)).label(
                "shipment_count"
            ),
            func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label(
                "total_quantity"
            ),
            func.coalesce(func.sum(ShipmentScheduleItem.chargeable_weight_kg), 0).label(
                "total_chargeable_weight_kg"
            ),
            func.coalesce(
                func.sum(ShipmentScheduleItem.estimated_logistics_cost), 0
            ).label("total_logistics_cost"),
        )
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .where(
            ShipmentSchedule.shipment_status == "completed",
            ShipmentSchedule.include_in_history_shipping_calc.is_(True),
        )
        .group_by(
            ShipmentSchedule.project_id,
            ShipmentSchedule.project_name_snapshot,
            ShipmentSchedule.country,
            ShipmentScheduleItem.sku,
        )
    ).all()

    for row in summary_rows:
        total_quantity = int(row.total_quantity or 0)
        total_logistics_cost = Decimal(str(row.total_logistics_cost or 0)).quantize(
            MONEY_QUANT, rounding=ROUND_HALF_UP
        )
        average_unit_price = (
            (total_logistics_cost / Decimal(str(total_quantity))).quantize(
                Decimal("0.0001"), rounding=ROUND_HALF_UP
            )
            if total_quantity > 0
            else DECIMAL_ZERO.quantize(Decimal("0.0001"))
        )
        db.add(
            ShipmentSkuSummary(
                project_id=int(row.project_id),
                project_name_snapshot=str(row.project_name),
                country=str(row.country),
                sku=str(row.sku),
                shipment_count=int(row.shipment_count or 0),
                total_quantity=total_quantity,
                total_chargeable_weight_kg=Decimal(
                    str(row.total_chargeable_weight_kg or 0)
                ).quantize(WEIGHT_QUANT, rounding=ROUND_HALF_UP),
                total_logistics_cost=total_logistics_cost,
                average_logistics_unit_price=average_unit_price,
            )
        )
    db.flush()


def sync_first_leg_cost_from_shipment_summary(
    db: Session,
    *,
    project_id: int | None = None,
    sku: str | None = None,
    country: str | None = None,
) -> int:
    """
    将历史出运汇总得到的 average_logistics_unit_price
    同步到 product_costs.first_leg_cost_rmb。

    只同步 is_active=True 的 product_cost 记录。
    只同步 average_logistics_unit_price > 0 的 shipment summary 记录。

    返回: 更新的记录数
    """
    money_precision = Decimal("0.01")
    summaries: dict[tuple[str, str, str], Decimal] = {}

    summary_rows = list_shipment_sku_summary(
        db,
        project_id=project_id,
        country=country,
        include_only_history_calc=True,
        shipment_status="completed,in_transit",
    )
    for row in summary_rows:
        average_logistics_unit_price = row["average_logistics_unit_price"]
        if average_logistics_unit_price and average_logistics_unit_price > 0:
            summaries[
                (
                    str(row["project_name"]),
                    str(row["sku"]),
                    str(row["country"]),
                )
            ] = Decimal(str(average_logistics_unit_price)).quantize(money_precision)

    if not summaries:
        return 0

    # 构建 sku_record 查询
    cost_stmt = select(SkuRecord).where(SkuRecord.is_active.is_(True))
    if project_id is not None:
        project_name_from_id = db.execute(
            select(Project.project_name).where(Project.id == project_id)
        ).scalar_one_or_none()
        if project_name_from_id:
            cost_stmt = cost_stmt.where(
                SkuRecord.project_name == project_name_from_id
            )
    if sku:
        cost_stmt = cost_stmt.where(SkuRecord.sku == sku)
    if country:
        cost_stmt = cost_stmt.where(SkuRecord.country == country.upper())

    updated = 0
    for cost in db.execute(cost_stmt).scalars().all():
        key = (cost.project_name, cost.sku, cost.country)
        if key in summaries:
            new_val = summaries[key]
            current_val = Decimal(str(cost.first_leg_cost_rmb)).quantize(
                money_precision
            )
            if current_val != new_val:
                cost.first_leg_cost_rmb = new_val
                updated += 1

    db.flush()
    return updated


# ============================================================
# SKU 汇总查询
# ============================================================

def list_shipment_sku_summary(
    db: Session,
    *,
    project_id: int | None = None,
    project_ids: list[int] | None = None,
    country: str | None = None,
    include_only_history_calc: bool = True,
    shipment_status: str | None = "completed,in_transit",
    shipment_nos: list[str] | None = None,
    created_date_from: str | None = None,
    created_date_to: str | None = None,
) -> list[dict[str, object]]:
    """
    查询 SKU 维度的出运汇总

    优先使用预计算的 ShipmentSkuSummary 表
    当有额外过滤条件（shipment_nos, date_range）时走实时查询
    """
    shipment_statuses = normalize_status_filters(shipment_status)
    use_completed_cache = shipment_statuses == ["completed"]

    # 当有额外过滤条件时，绕过预计算表
    has_extra_filters = (
        bool(shipment_nos) or bool(created_date_from) or bool(created_date_to)
    )

    if include_only_history_calc and use_completed_cache and not has_extra_filters:
        # 使用预计算表
        existing_count_stmt = select(func.count()).select_from(ShipmentSkuSummary)
        existing_count = int(db.execute(existing_count_stmt).scalar_one() or 0)

        if existing_count == 0:
            eligible_count = int(
                db.execute(
                    select(func.count())
                    .select_from(ShipmentScheduleItem)
                    .join(
                        ShipmentSchedule,
                        ShipmentSchedule.id
                        == ShipmentScheduleItem.shipment_schedule_id,
                    )
                    .where(
                        ShipmentSchedule.shipment_status == "completed",
                        ShipmentSchedule.include_in_history_shipping_calc.is_(True),
                    )
                ).scalar_one()
                or 0
            )
            if eligible_count > 0:
                refresh_shipment_sku_summary(db)
                sync_first_leg_cost_from_shipment_summary(db)

        stmt = select(ShipmentSkuSummary).order_by(
            ShipmentSkuSummary.project_name_snapshot.asc(),
            ShipmentSkuSummary.sku.asc(),
        )
        if project_ids is not None:
            stmt = stmt.where(ShipmentSkuSummary.project_id.in_(project_ids))
        if project_id is not None:
            stmt = stmt.where(ShipmentSkuSummary.project_id == project_id)
        if country:
            stmt = stmt.where(ShipmentSkuSummary.country == normalize_country(country))

        rows = db.execute(stmt).scalars().all()
        return [
            {
                "project_id": int(row.project_id),
                "project_name": str(row.project_name_snapshot),
                "country": str(row.country),
                "sku": str(row.sku),
                "shipment_count": int(row.shipment_count),
                "total_quantity": int(row.total_quantity),
                "total_chargeable_weight_kg": decimal_to_float(
                    row.total_chargeable_weight_kg, WEIGHT_QUANT
                ),
                "total_logistics_cost": decimal_to_float(
                    row.total_logistics_cost, MONEY_QUANT
                ),
                "average_logistics_unit_price": decimal_to_float(
                    row.average_logistics_unit_price, Decimal("0.0001")
                ),
            }
            for row in rows
        ]

    # 实时查询
    stmt = (
        select(
            ShipmentSchedule.project_id.label("project_id"),
            ShipmentSchedule.project_name_snapshot.label("project_name"),
            ShipmentSchedule.country.label("country"),
            ShipmentScheduleItem.sku.label("sku"),
            func.count(func.distinct(ShipmentScheduleItem.shipment_schedule_id)).label(
                "shipment_count"
            ),
            func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label(
                "total_quantity"
            ),
            func.coalesce(func.sum(ShipmentScheduleItem.chargeable_weight_kg), 0).label(
                "total_chargeable_weight_kg"
            ),
            func.coalesce(
                func.sum(ShipmentScheduleItem.estimated_logistics_cost), 0
            ).label("total_logistics_cost"),
        )
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .group_by(
            ShipmentSchedule.project_id,
            ShipmentSchedule.project_name_snapshot,
            ShipmentSchedule.country,
            ShipmentScheduleItem.sku,
        )
        .order_by(
            ShipmentSchedule.project_name_snapshot.asc(),
            ShipmentScheduleItem.sku.asc(),
        )
    )

    if project_ids is not None:
        stmt = stmt.where(ShipmentSchedule.project_id.in_(project_ids))
    if project_id is not None:
        stmt = stmt.where(ShipmentSchedule.project_id == project_id)
    if country:
        stmt = stmt.where(ShipmentSchedule.country == normalize_country(country))
    if include_only_history_calc:
        stmt = stmt.where(ShipmentSchedule.include_in_history_shipping_calc.is_(True))
    if shipment_statuses:
        stmt = stmt.where(ShipmentSchedule.shipment_status.in_(shipment_statuses))
    if shipment_nos:
        stmt = stmt.where(ShipmentSchedule.shipment_no.in_(shipment_nos))
    if created_date_from:
        stmt = stmt.where(ShipmentSchedule.created_date >= created_date_from)
    if created_date_to:
        stmt = stmt.where(ShipmentSchedule.created_date <= created_date_to)

    rows = db.execute(stmt).all()
    summary_items: list[dict[str, object]] = []
    for row in rows:
        total_quantity = int(row.total_quantity or 0)
        total_logistics_cost = decimal_to_float(row.total_logistics_cost, MONEY_QUANT)
        average_unit_price = (
            round(total_logistics_cost / total_quantity, 4)
            if total_quantity > 0
            else 0.0
        )
        summary_items.append(
            {
                "project_id": int(row.project_id),
                "project_name": str(row.project_name),
                "country": str(row.country),
                "sku": str(row.sku),
                "shipment_count": int(row.shipment_count or 0),
                "total_quantity": total_quantity,
                "total_chargeable_weight_kg": decimal_to_float(
                    row.total_chargeable_weight_kg, WEIGHT_QUANT
                ),
                "total_logistics_cost": total_logistics_cost,
                "average_logistics_unit_price": average_unit_price,
            }
        )
    return summary_items


# ============================================================
# 辅助函数
# ============================================================

def normalize_status_filters(value: str | None) -> list[str]:
    """验证并规范化 shipment_status 过滤条件"""
    if value is None:
        return []
    parts = value.split(",")
    return [normalize_status(p.strip()) for p in parts if p.strip()]


# ============================================================
# 费用汇总统计
# ============================================================

def summarize_shipment_schedule_costs(
    db: Session,
    *,
    project_id: int | None,
    project_ids: list[int] | None = None,
    country: str | None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_no: str | None,
    created_date_from: str | None,
    created_date_to: str | None,
) -> dict[str, object]:
    """汇总发货计划费用"""
    item_agg = (
        select(
            ShipmentScheduleItem.shipment_schedule_id.label("schedule_id"),
            func.count(ShipmentScheduleItem.id).label("sku_count"),
            func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label(
                "total_quantity"
            ),
        )
        .group_by(ShipmentScheduleItem.shipment_schedule_id)
        .subquery()
    )

    stmt = (
        select(
            func.count(ShipmentSchedule.id).label("shipment_count"),
            func.coalesce(func.sum(item_agg.c.sku_count), 0).label("total_sku"),
            func.coalesce(func.sum(item_agg.c.total_quantity), 0).label(
                "total_quantity"
            ),
            func.coalesce(
                func.sum(ShipmentSchedule.total_chargeable_weight_kg), 0
            ).label("total_chargeable_weight_kg"),
            func.coalesce(func.sum(ShipmentSchedule.logistics_total_price), 0).label(
                "total_logistics_cost"
            ),
        )
        .select_from(ShipmentSchedule)
        .outerjoin(item_agg, item_agg.c.schedule_id == ShipmentSchedule.id)
    )

    if project_ids is not None:
        stmt = stmt.where(ShipmentSchedule.project_id.in_(project_ids))
    if project_id is not None:
        stmt = stmt.where(ShipmentSchedule.project_id == project_id)
    if country:
        stmt = stmt.where(ShipmentSchedule.country == normalize_country(country))
    if shipment_status:
        stmt = stmt.where(ShipmentSchedule.shipment_status == normalize_status(shipment_status))
    if shipping_method:
        stmt = stmt.where(
            ShipmentSchedule.shipping_method == normalize_shipping_method(shipping_method)
        )

    normalized_shipment_nos = normalize_shipment_no_filters(shipment_no)
    if len(normalized_shipment_nos) > 1:
        stmt = stmt.where(ShipmentSchedule.shipment_no.in_(normalized_shipment_nos))
    elif len(normalized_shipment_nos) == 1:
        stmt = stmt.where(
            ShipmentSchedule.shipment_no.ilike(f"%{normalized_shipment_nos[0]}%")
        )

    created_from_date = parse_date(created_date_from, "created_date_from")
    created_to_date = parse_date(created_date_to, "created_date_to")
    if created_from_date is not None:
        stmt = stmt.where(ShipmentSchedule.created_date >= created_from_date)
    if created_to_date is not None:
        stmt = stmt.where(ShipmentSchedule.created_date <= created_to_date)

    row = db.execute(stmt).one()
    return {
        "shipment_count": int(row.shipment_count or 0),
        "total_sku": int(row.total_sku or 0),
        "total_quantity": int(row.total_quantity or 0),
        "total_chargeable_weight_kg": decimal_to_float(
            row.total_chargeable_weight_kg, WEIGHT_QUANT
        ),
        "total_logistics_cost": decimal_to_float(
            row.total_logistics_cost, MONEY_QUANT
        ),
    }