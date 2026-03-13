from __future__ import annotations

import csv
from datetime import date, datetime
from io import StringIO

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from app.models import Project
from app.models.product_cost import ProductCost
from app.models.shipment_schedule import ShipmentSchedule, ShipmentScheduleItem
from app.schemas.shipment_schedule import ShipmentScheduleCreate, ShipmentScheduleUpdate

ALLOWED_SHIPMENT_STATUS = {
    "draft",
    "in_transit",
    "completed",
}
ALLOWED_SHIPPING_METHOD = {"sea", "air", "express", "truck", "rail", "other"}


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


def _normalize_shipping_method(value: str) -> str:
    normalized = (value or "").strip()
    if normalized not in ALLOWED_SHIPPING_METHOD:
        allowed = ", ".join(sorted(ALLOWED_SHIPPING_METHOD))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"shipping_method 必须是: {allowed}",
        )
    return normalized


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
    shipment_status: str | None,
    shipping_method: str | None,
    shipment_no: str | None,
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

    etd_from_date = _parse_date(etd_from, "etd_from")
    etd_to_date = _parse_date(etd_to, "etd_to")
    eta_from_date = _parse_date(eta_from, "eta_from")
    eta_to_date = _parse_date(eta_to, "eta_to")
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
    row = _get_schedule_or_404(db, schedule_id)
    sku_count = len(row.items)
    total_quantity = sum(int(item.quantity) for item in row.items)
    row.items.sort(key=lambda item: (item.item_date or date.min, item.sku, item.id))
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

    row.project_id = project.id
    row.project_name_snapshot = project.project_name
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
    row.remark = _normalize_text(payload.remark)
    row.shipment_status = _normalize_status(payload.shipment_status)
    row.source_file = _normalize_text(payload.source_file, max_length=255)
    row.updated_by = _normalize_text(operator, max_length=255)
    db.flush()
    db.refresh(row)
    return row


def delete_shipment_schedule(
    db: Session,
    schedule_id: int,
) -> ShipmentSchedule:
    row = _get_schedule_or_404(db, schedule_id)
    db.delete(row)
    db.flush()
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
                ProductCost.is_active.is_(True),
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
            f"以下 SKU 未在 SKU 信息中找到启用记录（项目: {schedule.project_name_snapshot}），请先在 SKU 信息页面维护后再导入："
            + "；".join(detail_lines)
        ),
    )


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

    _validate_items_against_product_costs(db, schedule, items)

    replaced = db.execute(
        select(func.count(ShipmentScheduleItem.id)).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule_id
        )
    ).scalar_one()
    db.execute(
        delete(ShipmentScheduleItem).where(
            ShipmentScheduleItem.shipment_schedule_id == schedule_id
        )
    )

    total_quantity = 0
    source_file = _normalize_text(filename, max_length=255)
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
                source_type="csv_import",
                source_file=source_file,
            )
        )

    schedule.source_type = "csv_import"
    schedule.source_file = source_file
    db.flush()
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
