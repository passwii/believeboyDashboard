"""
计划管理模块

提供发货计划的主 CRUD 操作和费用计算
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.models import Project, ShipmentBatchDropdownHidden
from app.models.sku_info import SkuRecord
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import (
    ShipmentScheduleCreate,
    ShipmentScheduleItemInput,
    ShipmentScheduleUpdate,
)
from app.utils.country import normalize_country
from app.services.shipment.item import replace_shipment_schedule_items
from app.services.shipment.sku_sort import natural_sku_sort_key
from app.services.shipment.summary import (
    refresh_shipment_sku_summary,
    sync_first_leg_cost_from_shipment_summary,
)
from app.services.shipment.csv_parser import parse_shipment_schedules_csv
from app.services.shipment.validation import (
    CANCELLED_SHIPMENT_STATUS,
    DECIMAL_ZERO,
    MONEY_QUANT,
    ROUND_HALF_UP,
    VOLUME_QUANT,
    WEIGHT_QUANT,
    decimal_to_float,
    manual_items_match_existing,
    normalize_manual_items,
    normalize_non_negative_decimal,
    normalize_shipment_no_filters,
    normalize_shipping_method,
    normalize_status,
    normalize_status_filters,
    normalize_text_value,
    parse_date,
)

if TYPE_CHECKING:
    pass


# ============================================================
# 辅助函数
# ============================================================

def _get_project_or_404(db: Session, project_id: int) -> Project:
    """获取项目，不存在则抛出 404"""
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row


def _get_schedule_or_404(db: Session, schedule_id: int) -> ShipmentSchedule:
    """获取发货计划，不存在则抛出 404"""
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


# ============================================================
# 查询操作
# ============================================================

def list_shipment_schedules(
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
    etd_from: str | None,
    etd_to: str | None,
    eta_from: str | None,
    eta_to: str | None,
    page: int,
    page_size: int,
    include_total: bool = False,
) -> tuple[list[tuple[ShipmentSchedule, int, int]], int | None, bool]:
    """
    分页查询发货计划列表

    返回: (计划列表, 总数, 是否有下一页)
    """
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

    filter_stmt = select(ShipmentSchedule.id)

    if project_ids is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.project_id.in_(project_ids))
    if project_id is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.project_id == project_id)
    if country:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.country == normalize_country(country)
        )
    if shipment_status:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_status == normalize_status(shipment_status)
        )
    else:
        # 未显式指定状态时排除已取消货件（BLF-1287）：已取消货件只在「已取消」
        # 筛选下可见，避免混入默认列表与分页总数。
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_status != CANCELLED_SHIPMENT_STATUS
        )
    if shipping_method:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipping_method
            == normalize_shipping_method(shipping_method)
        )

    normalized_shipment_nos = normalize_shipment_no_filters(shipment_no)
    if len(normalized_shipment_nos) > 1:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_no.in_(normalized_shipment_nos)
        )
    elif len(normalized_shipment_nos) == 1:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_no.ilike(f"%{normalized_shipment_nos[0]}%")
        )

    # 日期范围过滤
    created_from_date = parse_date(created_date_from, "created_date_from")
    created_to_date = parse_date(created_date_to, "created_date_to")
    etd_from_date = parse_date(etd_from, "etd_from")
    etd_to_date = parse_date(etd_to, "etd_to")
    eta_from_date = parse_date(eta_from, "eta_from")
    eta_to_date = parse_date(eta_to, "eta_to")

    if created_from_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.created_date >= created_from_date)
    if created_to_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.created_date <= created_to_date)
    if etd_from_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.etd_date >= etd_from_date)
    if etd_to_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.etd_date <= etd_to_date)
    if eta_from_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.eta_date >= eta_from_date)
    if eta_to_date is not None:
        filter_stmt = filter_stmt.where(ShipmentSchedule.eta_date <= eta_to_date)

    filtered_ids = filter_stmt.subquery()

    stmt = (
        select(
            ShipmentSchedule,
            func.coalesce(item_agg.c.sku_count, 0),
            func.coalesce(item_agg.c.total_quantity, 0),
        )
        .join(filtered_ids, filtered_ids.c.id == ShipmentSchedule.id)
        .outerjoin(item_agg, item_agg.c.schedule_id == ShipmentSchedule.id)
        .order_by(
            ShipmentSchedule.created_date.desc().nullslast(),
            ShipmentSchedule.id.desc(),
        )
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
    )

    rows = db.execute(stmt).all()
    has_next = len(rows) > page_size
    page_rows = rows[:page_size]

    total = None
    if include_total:
        total = db.execute(select(func.count()).select_from(filtered_ids)).scalar_one()

    return page_rows, total, has_next


def get_shipment_schedule_detail(
    db: Session, schedule_id: int
) -> tuple[ShipmentSchedule, int, int]:
    """
    获取发货计划详情

    返回: (计划对象, SKU 数量, 总数量)
    """
    row = _get_schedule_or_404(db, schedule_id)
    sku_count = len(row.items)
    total_quantity = sum(int(item.quantity) for item in row.items)
    row.items.sort(key=lambda item: (item.item_date or date.min, natural_sku_sort_key(item.sku), item.id))
    return row, sku_count, total_quantity


def list_shipment_batches(
    db: Session,
    *,
    project_id: int,
    country: str,
    operator: str | None = None,
    shipment_status: str | None = None,
) -> list[str]:
    """
    返回该项目+国家下已用过的去重发货批次列表。

    排序：按最近一次更新倒序（MAX(updated_at) DESC），未更新过的排最后。
    过滤：operator 非空时排除该 operator 已隐藏的批次。
    状态过滤：显式传入 shipment_status（支持逗号分隔多值）时按其过滤；
    未传入时排除已取消批次（BLF-1287），避免取消货件把批次选项带出来。
    """
    normalized_country = normalize_country(country)
    status_filters = normalize_status_filters(shipment_status)

    batch_col = ShipmentSchedule.shipment_batch
    latest_updated = func.max(ShipmentSchedule.updated_at).label("latest_updated")

    stmt = (
        select(batch_col, latest_updated)
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == normalized_country,
            batch_col.is_not(None),
        )
        .group_by(batch_col)
    )

    if status_filters:
        stmt = stmt.where(ShipmentSchedule.shipment_status.in_(status_filters))
    else:
        stmt = stmt.where(
            ShipmentSchedule.shipment_status != CANCELLED_SHIPMENT_STATUS
        )

    if operator:
        hidden_subq = (
            select(ShipmentBatchDropdownHidden.shipment_batch)
            .where(
                ShipmentBatchDropdownHidden.project_id == project_id,
                ShipmentBatchDropdownHidden.country == normalized_country,
                ShipmentBatchDropdownHidden.operator == operator,
            )
        )
        stmt = stmt.where(batch_col.notin_(hidden_subq))

    stmt = stmt.order_by(latest_updated.desc(), batch_col.asc())

    return [str(row[0]) for row in db.execute(stmt).all() if row[0]]


def hide_shipment_batch(
    db: Session,
    *,
    operator: str,
    project_id: int,
    country: str,
    shipment_batch: str,
) -> None:
    """把指定 (operator, project, country, shipment_batch) 标记为隐藏。

    幂等：重复调用不会产生重复行（依赖 uq_shipment_batch_dropdown_hidden_scope）。
    不修改 shipment_schedules 表数据。
    """
    if not operator:
        raise ValueError("operator 不能为空")

    normalized_country = normalize_country(country)
    batch = normalize_text_value(shipment_batch, max_length=100)
    if not batch:
        raise ValueError("shipment_batch 不能为空")

    existing = (
        db.query(ShipmentBatchDropdownHidden)
        .filter(
            ShipmentBatchDropdownHidden.operator == operator,
            ShipmentBatchDropdownHidden.project_id == project_id,
            ShipmentBatchDropdownHidden.country == normalized_country,
            ShipmentBatchDropdownHidden.shipment_batch == batch,
        )
        .one_or_none()
    )
    if existing is not None:
        return

    db.add(
        ShipmentBatchDropdownHidden(
            operator=operator,
            project_id=project_id,
            country=normalized_country,
            shipment_batch=batch,
        )
    )
    try:
        db.flush()
    except IntegrityError:
        db.rollback()


# ============================================================
# 创建操作
# ============================================================

def create_shipment_schedule(
    db: Session,
    payload: ShipmentScheduleCreate,
    *,
    operator: str | None = None,
) -> ShipmentSchedule:
    """创建发货计划"""
    project = _get_project_or_404(db, payload.project_id)

    shipment_no = normalize_text_value(payload.shipment_no, max_length=100)
    if shipment_no is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

    # 检查重复
    duplicate = (
        db.execute(
            select(ShipmentSchedule).where(ShipmentSchedule.shipment_no == shipment_no)
        )
        .scalars()
        .first()
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="货件编号已存在",
        )

    row = ShipmentSchedule(
        project_id=project.id,
        country=normalize_country(payload.country),
        project_name_snapshot=project.project_name,
        shipment_no=shipment_no,
        tracking_no=normalize_text_value(payload.tracking_no, max_length=100),
        warehouse_code=normalize_text_value(payload.warehouse_code, max_length=100),
        forwarder_name=normalize_text_value(payload.forwarder_name, max_length=100),
        shipping_method=normalize_shipping_method(payload.shipping_method),
        created_date=parse_date(payload.created_date, "created_date"),
        etd_date=parse_date(payload.etd_date, "etd_date"),
        eta_date=parse_date(payload.eta_date, "eta_date"),
        actual_inbound_date=parse_date(payload.actual_inbound_date, "actual_inbound_date"),
        logistics_unit_price=normalize_non_negative_decimal(
            payload.logistics_unit_price, "logistics_unit_price", MONEY_QUANT
        ),
        include_in_history_shipping_calc=bool(payload.include_in_history_shipping_calc),
        remark=normalize_text_value(payload.remark),
        shipment_status=normalize_status(payload.shipment_status),
        shipment_batch=normalize_text_value(payload.shipment_batch, max_length=100),
        source_type="manual",
        source_file=normalize_text_value(payload.source_file, max_length=255),
        created_by=normalize_text_value(operator, max_length=255),
        updated_by=normalize_text_value(operator, max_length=255),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


# ============================================================
# 更新操作
# ============================================================

def update_shipment_schedule(
    db: Session,
    schedule_id: int,
    payload: ShipmentScheduleUpdate,
    *,
    operator: str | None = None,
) -> ShipmentSchedule:
    """更新发货计划"""
    row = _get_schedule_or_404(db, schedule_id)
    project = _get_project_or_404(db, payload.project_id)

    shipment_no = normalize_text_value(payload.shipment_no, max_length=100)
    if shipment_no is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

    # 检查重复（排除自身）
    duplicate = (
        db.execute(
            select(ShipmentSchedule).where(
                ShipmentSchedule.shipment_no == shipment_no,
                ShipmentSchedule.id != schedule_id,
            )
        )
        .scalars()
        .first()
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="货件编号已存在",
        )

    # 更新字段
    row.project_id = project.id
    row.country = normalize_country(payload.country)
    row.project_name_snapshot = project.project_name
    row.shipment_no = shipment_no
    row.tracking_no = normalize_text_value(payload.tracking_no, max_length=100)
    row.warehouse_code = normalize_text_value(payload.warehouse_code, max_length=100)
    row.forwarder_name = normalize_text_value(payload.forwarder_name, max_length=100)
    row.shipping_method = normalize_shipping_method(payload.shipping_method)
    row.created_date = parse_date(payload.created_date, "created_date")
    row.etd_date = parse_date(payload.etd_date, "etd_date")
    row.eta_date = parse_date(payload.eta_date, "eta_date")
    row.actual_inbound_date = parse_date(payload.actual_inbound_date, "actual_inbound_date")
    row.logistics_unit_price = normalize_non_negative_decimal(
        payload.logistics_unit_price, "logistics_unit_price", MONEY_QUANT
    )
    row.include_in_history_shipping_calc = bool(payload.include_in_history_shipping_calc)
    row.remark = normalize_text_value(payload.remark)
    row.shipment_status = normalize_status(payload.shipment_status)
    row.shipment_batch = normalize_text_value(payload.shipment_batch, max_length=100)
    row.updated_by = normalize_text_value(operator, max_length=255)

    # 处理 SKU 明细
    manual_items = normalize_manual_items(payload.items)
    if manual_items is None:
        row.source_file = normalize_text_value(payload.source_file, max_length=255)
    else:
        source_file = normalize_text_value(payload.source_file, max_length=255)
        if manual_items_match_existing(row, manual_items):
            row.source_type = "manual"
            row.source_file = source_file
        else:
            replace_shipment_schedule_items(
                db,
                row,
                manual_items,
                source_type="manual",
                source_file=source_file,
            )

    db.flush()
    refresh_shipment_sku_summary(db)
    sync_first_leg_cost_from_shipment_summary(db, project_id=row.project_id)
    db.refresh(row)
    return row


# ============================================================
# 删除操作
# ============================================================

def delete_shipment_schedule(db: Session, schedule_id: int) -> ShipmentSchedule:
    """删除发货计划"""
    row = _get_schedule_or_404(db, schedule_id)
    db.delete(row)
    db.flush()
    refresh_shipment_sku_summary(db)
    sync_first_leg_cost_from_shipment_summary(db, project_id=row.project_id)
    return row


# ============================================================
# 费用计算
# ============================================================

def calculate_shipment_schedule_costs(
    db: Session,
    schedule_id: int,
    *,
    logistics_unit_price: float | int | str,
) -> tuple[ShipmentSchedule, int, int]:
    """
    计算发货计划费用

    基于 SKU 尺寸和重量计算体积重和计费重，更新物流费用
    """
    row = _get_schedule_or_404(db, schedule_id)
    unit_price = normalize_non_negative_decimal(
        logistics_unit_price, "logistics_unit_price", MONEY_QUANT
    )

    if not row.items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先导入 SKU 明细，再执行核算",
        )

    # 获取 SKU 信息
    sku_values = sorted({item.sku for item in row.items})
    product_rows = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.project_name == row.project_name_snapshot,
                SkuRecord.sku.in_(sku_values),
                SkuRecord.country == row.country,
            )
        )
        .scalars()
        .all()
    )
    sku_info_map: dict[str, SkuRecord] = {product.sku: product for product in product_rows}

    # 检查缺失 SKU
    missing_skus = [item.sku for item in row.items if item.sku not in sku_info_map]
    if missing_skus:
        missing_preview = "、".join(missing_skus[:20])
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"以下 SKU 未找到可用的 SKU 信息：{missing_preview}",
        )

    # 计算费用（按单箱核算：实际重/体积重基于单箱尺寸与重量，乘以外箱数）
    total_volume = DECIMAL_ZERO
    total_chargeable_weight = DECIMAL_ZERO
    total_price = DECIMAL_ZERO

    for item in row.items:
        sku_info = sku_info_map[item.sku]
        quantity = Decimal(str(int(item.quantity)))
        units_per_carton = int(sku_info.units_per_carton or 0)

        # 1) 外箱数：整箱 + 尾箱向上取整（与 FBA 详情 outer_box_text 口径一致）
        if units_per_carton > 0:
            full_carton_count = int(quantity) // units_per_carton
            partial_carton_units = int(quantity) % units_per_carton
            carton_count = full_carton_count + (1 if partial_carton_units > 0 else 0)
        else:
            carton_count = 0

        # 2) 选择单箱尺寸（优先 carton_*，缺失则回退 package_*）
        has_carton_size = (
            float(sku_info.carton_length_cm or 0) > 0
            and float(sku_info.carton_width_cm or 0) > 0
            and float(sku_info.carton_height_cm or 0) > 0
        )
        use_carton_dims = has_carton_size and carton_count > 0
        if use_carton_dims:
            length_cm = Decimal(str(sku_info.carton_length_cm or 0))
            width_cm = Decimal(str(sku_info.carton_width_cm or 0))
            height_cm = Decimal(str(sku_info.carton_height_cm or 0))
        else:
            length_cm = Decimal(str(sku_info.package_length_cm or 0))
            width_cm = Decimal(str(sku_info.package_width_cm or 0))
            height_cm = Decimal(str(sku_info.package_height_cm or 0))
        # 体积重/实际重的乘数：按箱路径用 carton_count，否则回退 quantity（与原单品口径一致）
        weight_multiplier = Decimal(str(carton_count)) if use_carton_dims else quantity

        # 3) 体积 m³（按选定尺寸 × 乘数）
        unit_volume_m3 = length_cm * width_cm * height_cm / Decimal("1000000")
        volume_m3 = (unit_volume_m3 * weight_multiplier).quantize(
            VOLUME_QUANT, rounding=ROUND_HALF_UP
        )

        # 4) 实际重：优先 carton_weight_kg × carton_count，否则回退 weight_kg × quantity
        if (
            float(sku_info.carton_weight_kg or 0) > 0
            and carton_count > 0
        ):
            actual_weight_kg = (
                Decimal(str(sku_info.carton_weight_kg)) * Decimal(str(carton_count))
            ).quantize(WEIGHT_QUANT, rounding=ROUND_HALF_UP)
        else:
            actual_weight_kg = (Decimal(str(sku_info.weight_kg or 0)) * quantity).quantize(
                WEIGHT_QUANT, rounding=ROUND_HALF_UP
            )

        # 5) 体积重：尺寸 × /6000 × 乘数
        volumetric_weight_kg = (
            length_cm * width_cm * height_cm / Decimal("6000") * weight_multiplier
        ).quantize(WEIGHT_QUANT, rounding=ROUND_HALF_UP)
        chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg)

        # 6) 发货费用：计费重 × 单价
        estimated_logistics_cost = (chargeable_weight_kg * unit_price).quantize(
            MONEY_QUANT, rounding=ROUND_HALF_UP
        )

        # 更新明细（average_logistics_unit_price 留到循环外统一赋值，依赖全批次汇总）
        item.volume_m3 = volume_m3
        item.actual_weight_kg = actual_weight_kg
        item.volumetric_weight_kg = volumetric_weight_kg
        item.chargeable_weight_kg = chargeable_weight_kg
        item.estimated_logistics_cost = estimated_logistics_cost
        item.carton_count = carton_count

        # 累计
        total_volume += volume_m3
        total_chargeable_weight += chargeable_weight_kg
        total_price += estimated_logistics_cost

    # 7) 全批次平均单价 = 总发货费用 / 全批次总数量（所有 item 共享同一值）
    total_quantity_whole = sum(int(item.quantity) for item in row.items)
    total_quantity_decimal = Decimal(str(total_quantity_whole))
    if total_quantity_decimal > 0:
        avg_unit_price = (
            total_price.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)
            / total_quantity_decimal
        ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
    else:
        avg_unit_price = DECIMAL_ZERO
    for item in row.items:
        item.average_logistics_unit_price = avg_unit_price

    # 更新计划
    row.logistics_unit_price = unit_price
    row.total_volume_m3 = total_volume.quantize(VOLUME_QUANT, rounding=ROUND_HALF_UP)
    row.total_chargeable_weight_kg = total_chargeable_weight.quantize(
        WEIGHT_QUANT, rounding=ROUND_HALF_UP
    )
    row.logistics_total_price = total_price.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP)

    db.flush()
    refresh_shipment_sku_summary(db)
    sync_first_leg_cost_from_shipment_summary(db, project_id=row.project_id)
    db.refresh(row)
    row.items.sort(key=lambda item: (item.item_date or date.min, natural_sku_sort_key(item.sku), item.id))
    sku_count = len(row.items)
    total_quantity = total_quantity_whole
    return row, sku_count, total_quantity


# ============================================================
# FBA 货件详情
# ============================================================

def list_shipment_fba_box_details(
    db: Session,
    *,
    shipment_nos: str | list[str],
) -> tuple[list[ShipmentSchedule], list[dict[str, object]]]:
    """
    获取 FBA 货件箱详情

    用于生成 FBA 装箱标签
    """
    from app.services.shipment.validation import decimal_to_float

    normalized_shipment_nos = normalize_shipment_no_filters(shipment_nos)
    if not normalized_shipment_nos:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

    # 查询计划
    rows = (
        db.execute(
            select(ShipmentSchedule)
            .where(ShipmentSchedule.shipment_no.in_(normalized_shipment_nos))
            .options(selectinload(ShipmentSchedule.items))
        )
        .scalars()
        .all()
    )
    row_map = {str(row.shipment_no): row for row in rows}

    # 检查缺失
    missing_shipment_nos = [
        shipment_no for shipment_no in normalized_shipment_nos
        if shipment_no not in row_map
    ]
    if missing_shipment_nos:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"未找到对应的 FBA 货件编号: {'、'.join(missing_shipment_nos)}",
        )

    ordered_rows = [row_map[shipment_no] for shipment_no in normalized_shipment_nos]

    # 查询产品信息
    sku_values = sorted({item.sku for row in ordered_rows for item in row.items})
    product_rows = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.sku.in_(sku_values),
                SkuRecord.project_name.in_(
                    [str(row.project_name_snapshot) for row in ordered_rows]
                ),
                SkuRecord.country.in_([str(row.country) for row in ordered_rows]),
            )
        )
        .scalars()
        .all()
    )
    product_map: dict[tuple[str, str, str], SkuRecord] = {}
    for product in product_rows:
        key = (str(product.project_name), str(product.country), str(product.sku))
        product_map.setdefault(key, product)

    # 构建结果
    result: list[dict[str, object]] = []
    for row in ordered_rows:
        row.items.sort(key=lambda item: (item.item_date or date.min, natural_sku_sort_key(item.sku), item.id))
        for item in row.items:
            product = product_map.get(
                (str(row.project_name_snapshot), str(row.country), str(item.sku))
            )
            quantity = int(item.quantity)

            units_per_carton = (
                int(product.units_per_carton)
                if product and int(product.units_per_carton or 0) > 0
                else 0
            )
            full_carton_count = quantity // units_per_carton if units_per_carton > 0 else 0
            partial_carton_units = quantity % units_per_carton if units_per_carton > 0 else 0
            carton_count = full_carton_count + (1 if partial_carton_units > 0 else 0)

            # 计算尺寸
            has_carton_size = bool(
                product
                and float(product.carton_length_cm or 0) > 0
                and float(product.carton_width_cm or 0) > 0
                and float(product.carton_height_cm or 0) > 0
            )
            if has_carton_size:
                length_cm = Decimal(str(product.carton_length_cm or 0))
                width_cm = Decimal(str(product.carton_width_cm or 0))
                height_cm = Decimal(str(product.carton_height_cm or 0))
                volume_multiplier = Decimal(str(carton_count))
            else:
                length_cm = Decimal(str(product.package_length_cm or 0)) if product else DECIMAL_ZERO
                width_cm = Decimal(str(product.package_width_cm or 0)) if product else DECIMAL_ZERO
                height_cm = Decimal(str(product.package_height_cm or 0)) if product else DECIMAL_ZERO
                volume_multiplier = Decimal(str(quantity))

            # 重量
            if product and float(product.carton_weight_kg or 0) > 0 and carton_count > 0:
                total_weight_kg = Decimal(str(product.carton_weight_kg or 0)) * Decimal(str(carton_count))
            else:
                total_weight_kg = (
                    Decimal(str(product.weight_kg or 0)) * Decimal(str(quantity))
                    if product
                    else DECIMAL_ZERO
                )

            # 体积
            total_volume_m3 = (
                length_cm * width_cm * height_cm / Decimal("1000000") * volume_multiplier
            ).quantize(VOLUME_QUANT, rounding=ROUND_HALF_UP)

            # 箱型描述
            if product is None:
                outer_box_text = "未匹配 SKU 成本资料"
            elif units_per_carton <= 0:
                outer_box_text = "未维护装箱率"
            elif partial_carton_units > 0 and full_carton_count > 0:
                outer_box_text = f"{full_carton_count} 箱整箱 + 1 箱尾箱（{partial_carton_units} 件）"
            elif partial_carton_units > 0:
                outer_box_text = f"1 箱尾箱（{partial_carton_units} 件）"
            else:
                outer_box_text = f"{carton_count} 箱整箱"

            result.append(
                {
                    "project_id": int(row.project_id),
                    "project_name": str(row.project_name_snapshot),
                    "country": str(row.country),
                    "shipment_no": str(row.shipment_no),
                    "warehouse_code": row.warehouse_code,
                    "sku": item.sku,
                    "product_name": str(product.product_name) if product and product.product_name else None,
                    "asin": str(product.asin) if product and product.asin else None,
                    "fnsku": str(product.fnsku) if product and product.fnsku else None,
                    "package_length_cm": float(product.package_length_cm)
                    if product and product.package_length_cm
                    else None,
                    "package_width_cm": float(product.package_width_cm)
                    if product and product.package_width_cm
                    else None,
                    "package_height_cm": float(product.package_height_cm)
                    if product and product.package_height_cm
                    else None,
                    "weight_kg": float(product.weight_kg)
                    if product and product.weight_kg
                    else None,
                    "length_cm": decimal_to_float(length_cm, Decimal("0.01")),
                    "width_cm": decimal_to_float(width_cm, Decimal("0.01")),
                    "height_cm": decimal_to_float(height_cm, Decimal("0.01")),
                    "carton_weight_kg": float(product.carton_weight_kg)
                    if product and product.carton_weight_kg
                    else None,
                    "quantity": quantity,
                    "units_per_carton": units_per_carton,
                    "carton_count": carton_count,
                    "full_carton_count": full_carton_count,
                    "partial_carton_units": partial_carton_units,
                    "outer_box_text": outer_box_text,
                    "total_weight_kg": decimal_to_float(total_weight_kg, WEIGHT_QUANT),
                    "total_volume_m3": decimal_to_float(total_volume_m3, VOLUME_QUANT),
                    "fba_label_prefix": str(row.shipment_no),
                    "tracking_no": str(row.tracking_no) if row.tracking_no else None,
                    "product_image_thumbnail_r2_url": (
                        str(product.product_image_thumbnail_r2_url)
                        if product and product.product_image_thumbnail_r2_url
                        else None
                    ),
                    "product_image_r2_url": (
                        str(product.product_image_r2_url)
                        if product and product.product_image_r2_url
                        else None
                    ),
                }
            )

    return ordered_rows, result


# ============================================================
# CSV 导入
# ============================================================

def import_shipment_schedules_from_csv(
    db: Session,
    content: bytes,
    *,
    filename: str | None = None,
    operator: str | None = None,
) -> list[ShipmentSchedule]:
    """从 CSV 导入发货计划"""
    schedules = parse_shipment_schedules_csv(content)

    # 查询项目
    project_names = sorted({str(item["project_name"]) for item in schedules})
    projects = {
        str(project.project_name): project
        for project in db.execute(
            select(Project).where(Project.project_name.in_(project_names))
        )
        .scalars()
        .all()
    }
    missing_project_names = [name for name in project_names if name not in projects]
    if missing_project_names:
        missing_text = "、".join(missing_project_names[:20])
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"以下项目不存在，请先在项目管理中维护：{missing_text}",
        )

    # 检查重复
    shipment_nos = [str(item["shipment_no"]) for item in schedules]
    duplicated = (
        db.execute(
            select(ShipmentSchedule.shipment_no).where(
                ShipmentSchedule.shipment_no.in_(shipment_nos)
            )
        )
        .scalars()
        .all()
    )
    if duplicated:
        duplicated_text = "、".join(sorted({str(item) for item in duplicated})[:20])
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"以下货件编号已存在，不能重复导入：{duplicated_text}",
        )

    source_file = normalize_text_value(filename, max_length=255)
    created_rows: list[ShipmentSchedule] = []
    for item in schedules:
        project = projects[str(item["project_name"])]
        row = ShipmentSchedule(
            project_id=project.id,
            country=str(item["country"]),
            project_name_snapshot=project.project_name,
            shipment_no=str(item["shipment_no"]),
            tracking_no=item["tracking_no"],
            warehouse_code=item["warehouse_code"],
            forwarder_name=item["forwarder_name"],
            shipping_method=str(item["shipping_method"]),
            created_date=item["created_date"],
            etd_date=item["etd_date"],
            eta_date=item["eta_date"],
            actual_inbound_date=item["actual_inbound_date"],
            remark=item["remark"],
            shipment_status=str(item["shipment_status"]),
            source_type="csv_import",
            source_file=source_file,
            created_by=normalize_text_value(operator, max_length=255),
            updated_by=normalize_text_value(operator, max_length=255),
        )
        db.add(row)
        created_rows.append(row)

    db.flush()
    for row in created_rows:
        db.refresh(row)
    return created_rows