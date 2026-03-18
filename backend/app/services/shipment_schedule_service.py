from __future__ import annotations

import csv
from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP
from io import StringIO

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.models import Project
from app.models.product_cost import ProductCost
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.models.shipment_sku_summary import ShipmentSkuSummary
from app.schemas.shipment_schedule import (
    ShipmentScheduleCreate,
    ShipmentScheduleItemInput,
    ShipmentScheduleUpdate,
)

ALLOWED_SHIPMENT_STATUS = {
    "draft",
    "in_transit",
    "completed",
}
ALLOWED_SHIPPING_METHOD = {"sea", "air", "express", "truck", "rail", "other"}
DECIMAL_ZERO = Decimal("0")
MONEY_QUANT = Decimal("0.01")
WEIGHT_QUANT = Decimal("0.001")
VOLUME_QUANT = Decimal("0.0001")


def _decode_csv_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="CSV 编码必须为 UTF-8 或 GBK/ANSI（Excel 常见编码）",
    )


def _normalize_text(value: str | None, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if max_length is not None:
        return normalized[:max_length]
    return normalized


def _parse_date(value: str | None, field_name: str) -> date | None:
    normalized = _normalize_text(value)
    if normalized is None:
        return None
    candidates = [normalized]

    # Excel 导出 CSV 时常带时间部分或使用不同分隔符。
    if " " in normalized:
        candidates.append(normalized.split(" ", 1)[0].strip())
    if "T" in normalized:
        candidates.append(normalized.split("T", 1)[0].strip())

    seen: set[str] = set()
    formats = (
        "%Y-%m-%d",
        "%Y/%m/%d",
        "%Y.%m.%d",
        "%Y年%m月%d日",
        "%m/%d/%Y",
        "%m-%d-%Y",
        "%m.%d.%Y",
    )
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        try:
            return date.fromisoformat(candidate)
        except ValueError:
            pass
        for fmt in formats:
            try:
                return datetime.strptime(candidate, fmt).date()
            except ValueError:
                continue

    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail=f"{field_name} 必须是 YYYY-MM-DD，或 Excel 常见日期格式（如 2026/03/08、03/08/2026）",
    )


def _normalize_status(value: str) -> str:
    normalized = (value or "").strip()
    if normalized not in ALLOWED_SHIPMENT_STATUS:
        allowed = ", ".join(sorted(ALLOWED_SHIPMENT_STATUS))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"shipment_status 必须是: {allowed}",
        )
    return normalized


def _normalize_status_filters(value: str | None) -> list[str]:
    normalized = _normalize_text(value)
    if normalized is None:
        return []
    return [_normalize_status(part.strip()) for part in normalized.split(",") if part.strip()]


def _normalize_shipping_method(value: str) -> str:
    normalized = (value or "").strip()
    if normalized not in ALLOWED_SHIPPING_METHOD:
        allowed = ", ".join(sorted(ALLOWED_SHIPPING_METHOD))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"shipping_method 必须是: {allowed}",
        )
    return normalized


def _decimal_to_float(value: Decimal | int | float | None, quant: Decimal) -> float:
    if value is None:
        return float(DECIMAL_ZERO.quantize(quant))
    return float(Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP))


def _normalize_non_negative_decimal(
    value: Decimal | float | int | str, field_name: str, quant: Decimal
) -> Decimal:
    try:
        normalized = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    except Exception as exc:  # pragma: no cover - safety net
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} 必须是数字",
        ) from exc
    if normalized < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} 必须大于等于 0",
        )
    return normalized


def refresh_shipment_sku_summary(db: Session) -> None:
    db.execute(delete(ShipmentSkuSummary))
    summary_rows = db.execute(
        select(
            ShipmentSchedule.project_id.label("project_id"),
            ShipmentSchedule.project_name_snapshot.label("project_name"),
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


def _header_value(row: dict[str, str | None], key: str) -> str | None:
    for candidate in (key, key.lower(), key.upper()):
        if candidate in row:
            return row.get(candidate)
    return None


def _get_project_or_404(db: Session, project_id: int) -> Project:
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row


def _normalize_manual_items(
    items: list[ShipmentScheduleItemInput] | None,
) -> list[dict[str, object]] | None:
    if items is None:
        return None

    normalized_items: list[dict[str, object]] = []
    seen_skus: set[str] = set()
    for index, item in enumerate(items, start=1):
        sku = _normalize_text(item.sku, max_length=100)
        if sku is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"第 {index} 行 SKU 不能为空",
            )
        if sku in seen_skus:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"SKU 明细中存在重复 SKU: {sku}",
            )
        seen_skus.add(sku)
        normalized_items.append(
            {
                "row_no": index,
                "project_name": None,
                "shipment_no": None,
                "item_date": _parse_date(item.item_date, f"第 {index} 行 item_date"),
                "sku": sku,
                "quantity": int(item.quantity),
                "remark": _normalize_text(item.remark),
            }
        )
    return normalized_items


def _get_schedule_or_404(db: Session, schedule_id: int) -> ShipmentSchedule:
    stmt = (
        select(ShipmentSchedule)
        .where(ShipmentSchedule.id == schedule_id)
        .options(selectinload(ShipmentSchedule.items))
    )
    row = db.execute(stmt).scalars().first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="船期记录不存在"
        )
    return row


def list_shipment_schedules(
    db: Session,
    *,
    project_id: int | None,
    project_ids: list[int] | None = None,
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
    if shipment_status:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_status == _normalize_status(shipment_status)
        )
    if shipping_method:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipping_method
            == _normalize_shipping_method(shipping_method)
        )
    if shipment_no:
        filter_stmt = filter_stmt.where(
            ShipmentSchedule.shipment_no.ilike(f"%{shipment_no.strip()}%")
        )

    created_from_date = _parse_date(created_date_from, "created_date_from")
    created_to_date = _parse_date(created_date_to, "created_date_to")
    etd_from_date = _parse_date(etd_from, "etd_from")
    etd_to_date = _parse_date(etd_to, "etd_to")
    eta_from_date = _parse_date(eta_from, "eta_from")
    eta_to_date = _parse_date(eta_to, "eta_to")
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


def summarize_shipment_schedule_costs(
    db: Session,
    *,
    project_id: int | None,
    project_ids: list[int] | None = None,
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_no: str | None,
    created_date_from: str | None,
    created_date_to: str | None,
) -> dict[str, object]:
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
            func.coalesce(func.sum(item_agg.c.total_quantity), 0).label("total_quantity"),
            func.coalesce(func.sum(ShipmentSchedule.total_chargeable_weight_kg), 0).label(
                "total_chargeable_weight_kg"
            ),
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
    if shipment_status:
        stmt = stmt.where(
            ShipmentSchedule.shipment_status == _normalize_status(shipment_status)
        )
    if shipping_method:
        stmt = stmt.where(
            ShipmentSchedule.shipping_method == _normalize_shipping_method(shipping_method)
        )
    if shipment_no:
        stmt = stmt.where(
            ShipmentSchedule.shipment_no.ilike(f"%{shipment_no.strip()}%")
        )

    created_from_date = _parse_date(created_date_from, "created_date_from")
    created_to_date = _parse_date(created_date_to, "created_date_to")
    if created_from_date is not None:
        stmt = stmt.where(ShipmentSchedule.created_date >= created_from_date)
    if created_to_date is not None:
        stmt = stmt.where(ShipmentSchedule.created_date <= created_to_date)

    row = db.execute(stmt).one()
    return {
        "shipment_count": int(row.shipment_count or 0),
        "total_sku": int(row.total_sku or 0),
        "total_quantity": int(row.total_quantity or 0),
        "total_chargeable_weight_kg": _decimal_to_float(
            row.total_chargeable_weight_kg, WEIGHT_QUANT
        ),
        "total_logistics_cost": _decimal_to_float(
            row.total_logistics_cost, MONEY_QUANT
        ),
    }


def get_shipment_schedule_detail(
    db: Session, schedule_id: int
) -> tuple[ShipmentSchedule, int, int]:
    row = _get_schedule_or_404(db, schedule_id)
    sku_count = len(row.items)
    total_quantity = sum(int(item.quantity) for item in row.items)
    row.items.sort(key=lambda item: (item.item_date or date.min, item.sku, item.id))
    return row, sku_count, total_quantity


def list_shipment_sku_summary(
    db: Session,
    *,
    project_id: int | None,
    project_ids: list[int] | None = None,
    include_only_history_calc: bool = True,
    shipment_status: str | None = "completed",
) -> list[dict[str, object]]:
    shipment_statuses = _normalize_status_filters(shipment_status)
    use_completed_cache = shipment_statuses == ["completed"]

    if include_only_history_calc and use_completed_cache:
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

        stmt = select(ShipmentSkuSummary).order_by(
            ShipmentSkuSummary.project_name_snapshot.asc(),
            ShipmentSkuSummary.sku.asc(),
        )
        if project_ids is not None:
            stmt = stmt.where(ShipmentSkuSummary.project_id.in_(project_ids))
        if project_id is not None:
            stmt = stmt.where(ShipmentSkuSummary.project_id == project_id)
        rows = db.execute(stmt).scalars().all()
        return [
            {
                "project_id": int(row.project_id),
                "project_name": str(row.project_name_snapshot),
                "sku": str(row.sku),
                "shipment_count": int(row.shipment_count),
                "total_quantity": int(row.total_quantity),
                "total_chargeable_weight_kg": _decimal_to_float(
                    row.total_chargeable_weight_kg, WEIGHT_QUANT
                ),
                "total_logistics_cost": _decimal_to_float(
                    row.total_logistics_cost, MONEY_QUANT
                ),
                "average_logistics_unit_price": _decimal_to_float(
                    row.average_logistics_unit_price, Decimal("0.0001")
                ),
            }
            for row in rows
        ]

    stmt = (
        select(
            ShipmentSchedule.project_id.label("project_id"),
            ShipmentSchedule.project_name_snapshot.label("project_name"),
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
    if include_only_history_calc:
        stmt = stmt.where(ShipmentSchedule.include_in_history_shipping_calc.is_(True))
    if shipment_statuses:
        stmt = stmt.where(ShipmentSchedule.shipment_status.in_(shipment_statuses))
    rows = db.execute(stmt).all()
    summary_items: list[dict[str, object]] = []
    for row in rows:
        total_quantity = int(row.total_quantity or 0)
        total_logistics_cost = _decimal_to_float(row.total_logistics_cost, MONEY_QUANT)
        average_unit_price = (
            round(total_logistics_cost / total_quantity, 4)
            if total_quantity > 0
            else 0.0
        )
        summary_items.append(
            {
                "project_id": int(row.project_id),
                "project_name": str(row.project_name),
                "sku": str(row.sku),
                "shipment_count": int(row.shipment_count or 0),
                "total_quantity": total_quantity,
                "total_chargeable_weight_kg": _decimal_to_float(
                    row.total_chargeable_weight_kg, WEIGHT_QUANT
                ),
                "total_logistics_cost": total_logistics_cost,
                "average_logistics_unit_price": average_unit_price,
            }
        )
    return summary_items


def list_shipment_fba_box_details(
    db: Session,
    *,
    shipment_no: str,
) -> tuple[ShipmentSchedule, list[dict[str, object]]]:
    normalized_shipment_no = _normalize_text(shipment_no, max_length=100)
    if normalized_shipment_no is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

    row = (
        db.execute(
            select(ShipmentSchedule)
            .where(ShipmentSchedule.shipment_no == normalized_shipment_no)
            .options(selectinload(ShipmentSchedule.items))
        )
        .scalars()
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="未找到对应的 FBA 货件编号",
        )

    row.items.sort(key=lambda item: (item.item_date or date.min, item.sku, item.id))
    sku_values = sorted({item.sku for item in row.items})
    product_rows = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == row.project_name_snapshot,
                ProductCost.sku.in_(sku_values),
            )
        )
        .scalars()
        .all()
        if sku_values
        else []
    )
    product_map: dict[str, ProductCost] = {}
    for product in product_rows:
        product_map.setdefault(product.sku, product)

    result: list[dict[str, object]] = []
    for item in row.items:
        product = product_map.get(item.sku)
        quantity = int(item.quantity)
        units_per_carton = (
            int(product.units_per_carton)
            if product and int(product.units_per_carton or 0) > 0
            else 0
        )
        full_carton_count = quantity // units_per_carton if units_per_carton > 0 else 0
        partial_carton_units = (
            quantity % units_per_carton if units_per_carton > 0 else 0
        )
        carton_count = full_carton_count + (1 if partial_carton_units > 0 else 0)

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
            length_cm = (
                Decimal(str(product.package_length_cm or 0))
                if product
                else DECIMAL_ZERO
            )
            width_cm = (
                Decimal(str(product.package_width_cm or 0)) if product else DECIMAL_ZERO
            )
            height_cm = (
                Decimal(str(product.package_height_cm or 0))
                if product
                else DECIMAL_ZERO
            )
            volume_multiplier = Decimal(str(quantity))

        if product and float(product.carton_weight_kg or 0) > 0 and carton_count > 0:
            total_weight_kg = Decimal(str(product.carton_weight_kg or 0)) * Decimal(
                str(carton_count)
            )
        else:
            total_weight_kg = (
                Decimal(str(product.weight_kg or 0)) * Decimal(str(quantity))
                if product
                else DECIMAL_ZERO
            )

        total_volume_m3 = (
            length_cm * width_cm * height_cm / Decimal("1000000") * volume_multiplier
        ).quantize(VOLUME_QUANT, rounding=ROUND_HALF_UP)

        if product is None:
            outer_box_text = "未匹配 SKU 成本资料"
        elif units_per_carton <= 0:
            outer_box_text = "未维护装箱率"
        elif partial_carton_units > 0 and full_carton_count > 0:
            outer_box_text = (
                f"{full_carton_count} 箱整箱 + 1 箱尾箱（{partial_carton_units} 件）"
            )
        elif partial_carton_units > 0:
            outer_box_text = f"1 箱尾箱（{partial_carton_units} 件）"
        else:
            outer_box_text = f"{carton_count} 箱整箱"

        result.append(
            {
                "warehouse_code": row.warehouse_code,
                "sku": item.sku,
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
                "length_cm": _decimal_to_float(length_cm, Decimal("0.01")),
                "width_cm": _decimal_to_float(width_cm, Decimal("0.01")),
                "height_cm": _decimal_to_float(height_cm, Decimal("0.01")),
                "carton_weight_kg": float(product.carton_weight_kg)
                if product and product.carton_weight_kg
                else None,
                "quantity": quantity,
                "units_per_carton": units_per_carton,
                "carton_count": carton_count,
                "full_carton_count": full_carton_count,
                "partial_carton_units": partial_carton_units,
                "outer_box_text": outer_box_text,
                "total_weight_kg": _decimal_to_float(total_weight_kg, WEIGHT_QUANT),
                "total_volume_m3": _decimal_to_float(total_volume_m3, VOLUME_QUANT),
            }
        )

    return row, result


def calculate_shipment_schedule_costs(
    db: Session,
    schedule_id: int,
    *,
    logistics_unit_price: float | int | str,
) -> tuple[ShipmentSchedule, int, int]:
    row = _get_schedule_or_404(db, schedule_id)
    unit_price = _normalize_non_negative_decimal(
        logistics_unit_price, "logistics_unit_price", MONEY_QUANT
    )

    if not row.items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="请先导入 SKU 明细，再执行核算",
        )

    sku_values = sorted({item.sku for item in row.items})
    product_rows = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == row.project_name_snapshot,
                ProductCost.sku.in_(sku_values),
            )
        )
        .scalars()
        .all()
    )
    sku_info_map: dict[str, ProductCost] = {}
    for product in product_rows:
        sku_info_map.setdefault(product.sku, product)

    missing_skus = [item.sku for item in row.items if item.sku not in sku_info_map]
    if missing_skus:
        missing_preview = "、".join(missing_skus[:20])
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"以下 SKU 未找到可用的 SKU 信息：{missing_preview}",
        )

    total_volume = DECIMAL_ZERO
    total_chargeable_weight = DECIMAL_ZERO
    total_price = DECIMAL_ZERO

    for item in row.items:
        sku_info = sku_info_map[item.sku]
        quantity = Decimal(str(int(item.quantity)))
        package_length = Decimal(str(sku_info.package_length_cm or 0))
        package_width = Decimal(str(sku_info.package_width_cm or 0))
        package_height = Decimal(str(sku_info.package_height_cm or 0))
        unit_weight = Decimal(str(sku_info.weight_kg or 0))

        unit_volume_m3 = (
            package_length * package_width * package_height / Decimal("1000000")
        )
        volume_m3 = (unit_volume_m3 * quantity).quantize(
            VOLUME_QUANT, rounding=ROUND_HALF_UP
        )
        actual_weight_kg = (unit_weight * quantity).quantize(
            WEIGHT_QUANT, rounding=ROUND_HALF_UP
        )
        volumetric_weight_kg = (
            package_length * package_width * package_height / Decimal("6000") * quantity
        ).quantize(WEIGHT_QUANT, rounding=ROUND_HALF_UP)
        chargeable_weight_kg = max(actual_weight_kg, volumetric_weight_kg)
        estimated_logistics_cost = (chargeable_weight_kg * unit_price).quantize(
            MONEY_QUANT, rounding=ROUND_HALF_UP
        )
        average_logistics_unit_price = (estimated_logistics_cost / quantity).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP
        )

        item.volume_m3 = volume_m3
        item.actual_weight_kg = actual_weight_kg
        item.volumetric_weight_kg = volumetric_weight_kg
        item.chargeable_weight_kg = chargeable_weight_kg
        item.estimated_logistics_cost = estimated_logistics_cost
        item.average_logistics_unit_price = average_logistics_unit_price

        total_volume += volume_m3
        total_chargeable_weight += chargeable_weight_kg
        total_price += estimated_logistics_cost

    row.logistics_unit_price = unit_price
    row.total_volume_m3 = total_volume.quantize(VOLUME_QUANT, rounding=ROUND_HALF_UP)
    row.total_chargeable_weight_kg = total_chargeable_weight.quantize(
        WEIGHT_QUANT, rounding=ROUND_HALF_UP
    )
    row.logistics_total_price = total_price.quantize(
        MONEY_QUANT, rounding=ROUND_HALF_UP
    )
    db.flush()
    refresh_shipment_sku_summary(db)
    db.refresh(row)
    row.items.sort(key=lambda item: (item.item_date or date.min, item.sku, item.id))
    sku_count = len(row.items)
    total_quantity = sum(int(item.quantity) for item in row.items)
    return row, sku_count, total_quantity


def create_shipment_schedule(
    db: Session,
    payload: ShipmentScheduleCreate,
    *,
    operator: str | None = None,
) -> ShipmentSchedule:
    project = _get_project_or_404(db, payload.project_id)
    shipment_no = _normalize_text(payload.shipment_no, max_length=100)
    if shipment_no is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

    duplicate = (
        db.execute(
            select(ShipmentSchedule).where(ShipmentSchedule.shipment_no == shipment_no)
        )
        .scalars()
        .first()
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="货件编号已存在"
        )

    row = ShipmentSchedule(
        project_id=project.id,
        project_name_snapshot=project.project_name,
        shipment_no=shipment_no,
        tracking_no=_normalize_text(payload.tracking_no, max_length=100),
        warehouse_code=_normalize_text(payload.warehouse_code, max_length=100),
        forwarder_name=_normalize_text(payload.forwarder_name, max_length=100),
        shipping_method=_normalize_shipping_method(payload.shipping_method),
        created_date=_parse_date(payload.created_date, "created_date"),
        etd_date=_parse_date(payload.etd_date, "etd_date"),
        eta_date=_parse_date(payload.eta_date, "eta_date"),
        actual_inbound_date=_parse_date(
            payload.actual_inbound_date, "actual_inbound_date"
        ),
        logistics_unit_price=_normalize_non_negative_decimal(
            payload.logistics_unit_price, "logistics_unit_price", MONEY_QUANT
        ),
        include_in_history_shipping_calc=bool(payload.include_in_history_shipping_calc),
        remark=_normalize_text(payload.remark),
        shipment_status=_normalize_status(payload.shipment_status),
        source_type="manual",
        source_file=_normalize_text(payload.source_file, max_length=255),
        created_by=_normalize_text(operator, max_length=255),
        updated_by=_normalize_text(operator, max_length=255),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def update_shipment_schedule(
    db: Session,
    schedule_id: int,
    payload: ShipmentScheduleUpdate,
    *,
    operator: str | None = None,
) -> ShipmentSchedule:
    row = _get_schedule_or_404(db, schedule_id)
    project = _get_project_or_404(db, payload.project_id)
    shipment_no = _normalize_text(payload.shipment_no, max_length=100)
    if shipment_no is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="shipment_no 不能为空",
        )

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
            status_code=status.HTTP_409_CONFLICT, detail="货件编号已存在"
        )

    row.project_id = project.id
    row.project_name_snapshot = project.project_name
    row.shipment_no = shipment_no
    row.tracking_no = _normalize_text(payload.tracking_no, max_length=100)
    row.warehouse_code = _normalize_text(payload.warehouse_code, max_length=100)
    row.forwarder_name = _normalize_text(payload.forwarder_name, max_length=100)
    row.shipping_method = _normalize_shipping_method(payload.shipping_method)
    row.created_date = _parse_date(payload.created_date, "created_date")
    row.etd_date = _parse_date(payload.etd_date, "etd_date")
    row.eta_date = _parse_date(payload.eta_date, "eta_date")
    row.actual_inbound_date = _parse_date(
        payload.actual_inbound_date, "actual_inbound_date"
    )
    row.logistics_unit_price = _normalize_non_negative_decimal(
        payload.logistics_unit_price, "logistics_unit_price", MONEY_QUANT
    )
    row.include_in_history_shipping_calc = bool(
        payload.include_in_history_shipping_calc
    )
    row.remark = _normalize_text(payload.remark)
    row.shipment_status = _normalize_status(payload.shipment_status)
    row.updated_by = _normalize_text(operator, max_length=255)

    manual_items = _normalize_manual_items(payload.items)
    if manual_items is None:
        row.source_file = _normalize_text(payload.source_file, max_length=255)
    else:
        _replace_shipment_schedule_items(
            db,
            row,
            manual_items,
            source_type="manual",
            source_file=_normalize_text(payload.source_file, max_length=255),
        )

    db.flush()
    refresh_shipment_sku_summary(db)
    db.refresh(row)
    return row


def delete_shipment_schedule(
    db: Session,
    schedule_id: int,
) -> ShipmentSchedule:
    row = _get_schedule_or_404(db, schedule_id)
    db.delete(row)
    db.flush()
    refresh_shipment_sku_summary(db)
    return row


def parse_shipment_items_csv(content: bytes) -> list[dict[str, object]]:
    text = _decode_csv_text(content)

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 缺少表头"
        )

    available_headers = {str(name).strip() for name in reader.fieldnames if name}
    required_headers = {"project_name", "shipment_no", "SKU", "quantity"}
    if not required_headers.issubset(available_headers):
        missing = ", ".join(sorted(required_headers - available_headers))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"CSV 缺少字段: {missing}"
        )

    items: list[dict[str, object]] = []
    for index, row in enumerate(reader, start=2):
        normalized = {(key or "").strip(): value for key, value in row.items()}
        sku = _normalize_text(normalized.get("SKU"), max_length=100)
        shipment_no = _normalize_text(normalized.get("shipment_no"), max_length=100)
        project_name = _normalize_text(normalized.get("project_name"), max_length=255)
        if sku is None or shipment_no is None or project_name is None:
            continue

        quantity_text = _normalize_text(normalized.get("quantity"))
        if quantity_text is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 quantity 不能为空",
            )
        try:
            quantity = int(quantity_text)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 quantity 必须是整数",
            )
        if quantity <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 quantity 必须大于 0",
            )

        items.append(
            {
                "row_no": index,
                "project_name": project_name,
                "shipment_no": shipment_no,
                "item_date": _parse_date(normalized.get("date"), f"第 {index} 行 date"),
                "sku": sku,
                "quantity": quantity,
                "remark": _normalize_text(normalized.get("remark")),
            }
        )

    if not items:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 没有可导入的有效数据"
        )
    return items


def _validate_items_against_product_costs(
    db: Session,
    schedule: ShipmentSchedule,
    items: list[dict[str, object]],
) -> None:
    sku_values = sorted({str(item["sku"]) for item in items})
    if not sku_values:
        return

    matched_skus = {
        str(row[0])
        for row in db.execute(
            select(ProductCost.sku).where(
                ProductCost.project_name == schedule.project_name_snapshot,
                ProductCost.sku.in_(sku_values),
            )
        ).all()
    }

    missing = [item for item in items if str(item["sku"]) not in matched_skus]
    if not missing:
        return

    detail_lines = [
        f"第 {int(item['row_no'])} 行 SKU: {item['sku']}" for item in missing[:20]
    ]
    remaining = len(missing) - len(detail_lines)
    if remaining > 0:
        detail_lines.append(f"其余 {remaining} 行未展开")

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"以下 SKU 未在 SKU 信息中找到记录（项目: {schedule.project_name_snapshot}），请先在 SKU 信息页面维护后再导入："
            + "；".join(detail_lines)
        ),
    )


def _replace_shipment_schedule_items(
    db: Session,
    schedule: ShipmentSchedule,
    items: list[dict[str, object]],
    *,
    source_type: str,
    source_file: str | None = None,
) -> int:
    _validate_items_against_product_costs(db, schedule, items)

    db.execute(
        delete(ShipmentScheduleItem).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule.id
        )
    )

    total_quantity = 0
    for item in items:
        total_quantity += int(item["quantity"])
        db.add(
            ShipmentScheduleItem(
                shipment_schedule_id=schedule.id,
                project_id=schedule.project_id,
                shipment_no=schedule.shipment_no,
                item_date=item["item_date"],
                sku=str(item["sku"]),
                quantity=int(item["quantity"]),
                remark=item["remark"],
                source_type=source_type,
                source_file=source_file,
                average_logistics_unit_price=DECIMAL_ZERO,
            )
        )

    schedule.source_type = source_type
    schedule.source_file = source_file
    schedule.total_volume_m3 = DECIMAL_ZERO
    schedule.total_chargeable_weight_kg = DECIMAL_ZERO
    schedule.logistics_total_price = DECIMAL_ZERO
    return total_quantity


def replace_shipment_schedule_items_from_csv(
    db: Session,
    schedule_id: int,
    content: bytes,
    *,
    filename: str | None = None,
) -> tuple[ShipmentSchedule, int, int, int]:
    schedule = _get_schedule_or_404(db, schedule_id)
    items = parse_shipment_items_csv(content)

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

    replaced = db.execute(
        select(func.count(ShipmentScheduleItem.id)).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule_id
        )
    ).scalar_one()
    source_file = _normalize_text(filename, max_length=255)
    total_quantity = _replace_shipment_schedule_items(
        db,
        schedule,
        items,
        source_type="csv_import",
        source_file=source_file,
    )
    db.flush()
    refresh_shipment_sku_summary(db)
    db.refresh(schedule)
    return schedule, len(items), int(replaced), total_quantity


def parse_shipment_schedules_csv(content: bytes) -> list[dict[str, object]]:
    text = _decode_csv_text(content)

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 缺少表头"
        )

    available_headers = {str(name).strip() for name in reader.fieldnames if name}
    required_headers = {
        "project_name",
        "shipment_no",
        "shipping_method",
        "shipment_status",
    }
    if not required_headers.issubset(available_headers):
        missing = ", ".join(sorted(required_headers - available_headers))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"CSV 缺少字段: {missing}"
        )

    schedules: list[dict[str, object]] = []
    shipment_nos_seen: set[str] = set()
    for index, row in enumerate(reader, start=2):
        normalized = {(key or "").strip(): value for key, value in row.items()}
        project_name = _normalize_text(
            _header_value(normalized, "project_name"), max_length=255
        )
        shipment_no = _normalize_text(
            _header_value(normalized, "shipment_no"), max_length=100
        )
        if project_name is None and shipment_no is None:
            continue
        if project_name is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 project_name 不能为空",
            )
        if shipment_no is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"第 {index} 行 shipment_no 不能为空",
            )
        if shipment_no in shipment_nos_seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"CSV 中存在重复 shipment_no: {shipment_no}",
            )
        shipment_nos_seen.add(shipment_no)

        schedules.append(
            {
                "row_no": index,
                "project_name": project_name,
                "shipment_no": shipment_no,
                "tracking_no": _normalize_text(
                    _header_value(normalized, "tracking_no"), max_length=100
                ),
                "warehouse_code": _normalize_text(
                    _header_value(normalized, "warehouse_code"), max_length=100
                ),
                "forwarder_name": _normalize_text(
                    _header_value(normalized, "forwarder_name"), max_length=100
                ),
                "shipping_method": _normalize_shipping_method(
                    str(_header_value(normalized, "shipping_method") or "")
                ),
                "created_date": _parse_date(
                    _header_value(normalized, "created_date"),
                    f"第 {index} 行 created_date",
                ),
                "etd_date": _parse_date(
                    _header_value(normalized, "etd_date"), f"第 {index} 行 etd_date"
                ),
                "eta_date": _parse_date(
                    _header_value(normalized, "eta_date"), f"第 {index} 行 eta_date"
                ),
                "actual_inbound_date": _parse_date(
                    _header_value(normalized, "actual_inbound_date"),
                    f"第 {index} 行 actual_inbound_date",
                ),
                "remark": _normalize_text(_header_value(normalized, "remark")),
                "shipment_status": _normalize_status(
                    str(_header_value(normalized, "shipment_status") or "")
                ),
            }
        )

    if not schedules:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 没有可导入的有效数据"
        )
    return schedules


def import_shipment_schedules_from_csv(
    db: Session,
    content: bytes,
    *,
    filename: str | None = None,
    operator: str | None = None,
) -> list[ShipmentSchedule]:
    schedules = parse_shipment_schedules_csv(content)

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

    source_file = _normalize_text(filename, max_length=255)
    created_rows: list[ShipmentSchedule] = []
    for item in schedules:
        project = projects[str(item["project_name"])]
        row = ShipmentSchedule(
            project_id=project.id,
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
            created_by=_normalize_text(operator, max_length=255),
            updated_by=_normalize_text(operator, max_length=255),
        )
        db.add(row)
        created_rows.append(row)

    db.flush()
    for row in created_rows:
        db.refresh(row)
    return created_rows
