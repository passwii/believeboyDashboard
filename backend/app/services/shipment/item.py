"""
SKU 明细管理模块

提供发货计划 SKU 明细的 CRUD 操作
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select

from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.models.sku_info import SkuRecord
from app.services.shipment.csv_parser import (
    parse_shipment_items_csv,
)
from app.services.shipment.validation import (
    DECIMAL_ZERO,
    normalize_text_value,
)
from app.services.shipping_plan.allocation import shipment_item_replacement_conflicts

if TYPE_CHECKING:
    from sqlalchemy.orm import Session


# ============================================================
# SKU 明细验证
# ============================================================

def validate_items_against_product_costs(
    db: Session,
    schedule: ShipmentSchedule,
    items: list[dict[str, object]],
) -> None:
    """
    验证 SKU 明细中的 SKU 是否在 product_costs 中存在

    如果只有 carton_count 没有 quantity，会通过 units_per_carton 反推
    """
    sku_values = sorted({str(item["sku"]) for item in items})
    if not sku_values:
        return

    # 获取 SKU 的装箱率信息
    product_rows = db.execute(
        select(SkuRecord.sku, SkuRecord.units_per_carton).where(
            SkuRecord.project_name == schedule.project_name_snapshot,
            SkuRecord.sku.in_(sku_values),
            SkuRecord.country == schedule.country,
        )
    ).all()
    product_map = {str(row[0]): int(row[1] or 0) for row in product_rows}

    # 补全 carton_count 和 quantity
    for item in items:
        sku = str(item["sku"])
        units_per_carton = product_map.get(sku, 0)
        if units_per_carton <= 0:
            continue
        # 优先用 quantity 反推 carton_count
        if item.get("carton_count") is None and item.get("quantity") is not None:
            item["carton_count"] = int(item["quantity"]) // units_per_carton
        # 如果只有 carton_count，反推 quantity
        elif item.get("quantity") is None and item.get("carton_count") is not None:
            item["quantity"] = int(item["carton_count"]) * units_per_carton

    # 检查未匹配的 SKU
    matched_skus = set(product_map.keys())
    missing = [item for item in items if str(item["sku"]) not in matched_skus]
    if not missing:
        return

    # 生成错误信息
    detail_lines = [f"第 {int(item['row_no'])} 行 SKU: {item['sku']}" for item in missing[:20]]
    remaining = len(missing) - len(detail_lines)
    if remaining > 0:
        detail_lines.append(f"其余 {remaining} 行未展开")

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"以下 SKU 未在 SKU 信息中找到记录（项目: {schedule.project_name_snapshot}，"
            f"国家: {schedule.country}），请先在 SKU 信息页面维护后再导入："
            + "；".join(detail_lines)
        ),
    )


# ============================================================
# SKU 明细替换
# ============================================================

def replace_shipment_schedule_items(
    db: Session,
    schedule: ShipmentSchedule,
    items: list[dict[str, object]],
    *,
    source_type: str,
    source_file: str | None = None,
) -> int:
    """
    替换发货计划的 SKU 明细

    返回: 总数量
    """
    validate_items_against_product_costs(db, schedule, items)

    # Allocation writes lock this same schedule row first, serializing replacement
    # with allocation and preserving the established lock order.
    db.execute(
        select(ShipmentSchedule.id)
        .where(ShipmentSchedule.id == schedule.id)
        .with_for_update()
    ).scalar_one()
    conflicts = shipment_item_replacement_conflicts(
        db, schedule_id=schedule.id, items=items
    )
    if conflicts:
        detail = ", ".join(
            f"{row['sku']}（已关联 {row['allocated_quantity']}，替换后 {row['replacement_quantity']}）"
            for row in conflicts
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"替换明细会破坏发货规划关联，请先解绑或调整关联：{detail}",
        )

    # 删除现有明细
    db.execute(
        delete(ShipmentScheduleItem).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule.id
        )
    )

    total_quantity = 0
    for item in items:
        if item["quantity"] is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"第 {int(item['row_no'])} 行无法确定 quantity"
                    "（请在 CSV 中填写 quantity 或 carton_count，并确保 SKU 在 SKU 信息中有装箱率）"
                ),
            )
        total_quantity += int(item["quantity"])
        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=schedule.project_id,
                shipment_no=schedule.shipment_no,
                item_date=item["item_date"],
                sku=str(item["sku"]),
                quantity=int(item["quantity"]),
                carton_count=item.get("carton_count"),
                remark=item["remark"],
                source_type=source_type,
                source_file=source_file,
                average_logistics_unit_price=DECIMAL_ZERO,
            )
        )

    # 重置计划费用信息
    schedule.source_type = source_type
    schedule.source_file = source_file
    schedule.total_volume_m3 = DECIMAL_ZERO
    schedule.total_chargeable_weight_kg = DECIMAL_ZERO
    schedule.logistics_total_price = DECIMAL_ZERO
    return total_quantity


# ============================================================
# 从 CSV 导入 SKU 明细
# ============================================================

def replace_shipment_schedule_items_from_csv(
    db: Session,
    schedule_id: int,
    content: bytes,
    *,
    filename: str | None = None,
) -> tuple[ShipmentSchedule, int, int, int]:
    """
    从 CSV 文件导入 SKU 明细

    返回: (计划对象, 导入行数, 替换行数, 总数量)
    """
    from app.services.shipment.summary import (
        refresh_shipment_sku_summary,
        sync_first_leg_cost_from_shipment_summary,
    )

    # 获取计划
    schedule = _get_schedule_or_404(db, schedule_id)

    # 解析 CSV
    items = parse_shipment_items_csv(content)

    # 验证货件编号和项目名称匹配
    for item in items:
        if item["shipment_no"] != schedule.shipment_no:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CSV 中存在不匹配的货件编号: {item['shipment_no']}，当前记录是 {schedule.shipment_no}",
            )
        if item["project_name"] != schedule.project_name_snapshot:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CSV 中项目名称 {item['project_name']} 与当前记录项目 {schedule.project_name_snapshot} 不一致",
            )

    # 获取现有明细数量
    replaced = db.execute(
        select(func.count(ShipmentScheduleItem.id)).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule_id
        )
    ).scalar_one()

    # 导入明细
    source_file = normalize_text_value(filename, max_length=255)
    total_quantity = replace_shipment_schedule_items(
        db,
        schedule,
        items,
        source_type="csv_import",
        source_file=source_file,
    )

    db.flush()
    refresh_shipment_sku_summary(db)
    sync_first_leg_cost_from_shipment_summary(db, project_id=schedule.project_id)
    db.refresh(schedule)
    return schedule, len(items), int(replaced), total_quantity


# ============================================================
# 辅助函数
# ============================================================

def _get_schedule_or_404(db: Session, schedule_id: int) -> ShipmentSchedule:
    """获取发货计划，不存在则抛出 404"""
    from sqlalchemy import select
    from sqlalchemy.orm import selectinload

    stmt = (
        select(ShipmentSchedule)
        .where(ShipmentSchedule.id == schedule_id)
        .options(selectinload(ShipmentSchedule.items))
    )
    row = db.execute(stmt).scalars().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="船期记录不存在",
        )
    return row