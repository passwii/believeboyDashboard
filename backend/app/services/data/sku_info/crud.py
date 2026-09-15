from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import Project, SkuRecord
from app.schemas.sku_info import LISTING_COPY_FIELDS, SkuRecordCreate, SkuRecordUpdate
from app.services.data.sku_info.cache import _resolve_project_id
from app.utils.country import normalize_country

DECIMAL_ZERO = Decimal("0")
COST_DECIMAL_QUANT = Decimal("0.01")
WEIGHT_DECIMAL_QUANT = Decimal("0.001")
RMB_CURRENCY = "CNY"


def _normalize_text(value: str | None, field_name: str) -> str:
    normalized = (value or "").strip()
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} is required",
        )
    return normalized


def _normalize_optional_text(value: str | None) -> str | None:
    normalized = (value or "").strip()
    return normalized or None


def _normalize_cost(value: float | str | Decimal | None, field_name: str) -> Decimal:
    if value is None or value == "":
        return DECIMAL_ZERO
    try:
        dec = Decimal(str(value)).quantize(COST_DECIMAL_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be numeric",
        ) from None
    if dec < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be >= 0",
        )
    return dec


def _normalize_decimal_value(
    value: float | str | Decimal | None, field_name: str, quant: Decimal
) -> Decimal:
    if value is None or value == "":
        return Decimal("0").quantize(quant)
    try:
        dec = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be numeric",
        ) from None
    if dec < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be >= 0",
        )
    return dec


def _normalize_sort_order(value: int | str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="sort_order must be integer",
        ) from None
    if parsed < 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="sort_order must be >= 1",
        )
    return parsed


def _normalize_int(value: int | str | None, field_name: str) -> int:
    if value is None or value == "":
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be integer",
        ) from None
    if parsed < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must be >= 0",
        )
    return parsed


def _next_sort_order_for_project(db: Session, project_id: int) -> int:
    value = db.execute(
        select(func.coalesce(func.max(SkuRecord.sort_order), 0)).where(
            SkuRecord.project_id == project_id
        )
    ).scalar_one()
    return int(value or 0) + 1


def _resolve_insert_sort_order(
    db: Session,
    *,
    project_id: int,
    requested_sort_order: int | None,
    next_sort_order_cache: dict[str, int] | None,
) -> int:
    if requested_sort_order is not None:
        return requested_sort_order

    cache_key = str(project_id)
    if next_sort_order_cache is not None and cache_key in next_sort_order_cache:
        resolved = next_sort_order_cache[cache_key]
        next_sort_order_cache[cache_key] = resolved + 1
        return resolved

    next_order = _next_sort_order_for_project(db, project_id)
    if next_sort_order_cache is not None:
        next_sort_order_cache[cache_key] = next_order + 1
    return next_order


def _resequence_project_sort_orders(
    db: Session,
    *,
    project_id: int,
    project_name: str | None = None,
    prioritized_row: SkuRecord | None = None,
    requested_sort_order: int | None = None,
) -> None:
    rows = (
        db.execute(
            select(SkuRecord)
            .where(SkuRecord.project_id == project_id)
            .order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
        )
        .scalars()
        .all()
    )
    if not rows:
        return

    ordered_rows = list(rows)
    if prioritized_row is not None and requested_sort_order is not None:
        ordered_rows = [row for row in ordered_rows if row.id != prioritized_row.id]
        insert_at = min(max(requested_sort_order, 1), len(ordered_rows) + 1) - 1
        ordered_rows.insert(insert_at, prioritized_row)

    for index, current in enumerate(ordered_rows, start=1):
        current.sort_order = index

    db.flush()


def _listing_copy_values(
    item: SkuRecordCreate | SkuRecordUpdate,
) -> dict[str, str | None]:
    """收集**显式提供**的文案字段（BLF-1080 P1 修复）。

    与通用 CRUD 既有语义一致：只有出现在 ``model_fields_set`` 里的字段才进入
    结果——未提供 = 保持原值，显式 ``null`` / 空串 = 清空（归一成 ``None``）。
    返回空 dict 表示本次调用完全没碰文案字段。
    """
    return {
        field: _normalize_optional_text(getattr(item, field))
        for field in LISTING_COPY_FIELDS
        if field in item.model_fields_set
    }


def _apply_listing_copy_fields(
    row: SkuRecord,
    values: dict[str, str | None],
    *,
    operator: str | None = None,
    now: datetime | None = None,
) -> bool:
    """把已判定为「显式提供」的文案字段写到 ORM 行，并刷新溯源列。

    调用方负责用 ``model_fields_set`` 判定显式提供（见 ``_listing_copy_values``）
    —— 本函数只接收判定后的 ``values``；任一字段被提供即刷新
    ``listing_copy_updated_at`` / ``listing_copy_updated_by``（对齐
    ``batch_update_listing_copy`` 与 ``sku_factory_info_updated_{at,by}`` 先例）。

    Returns:
        是否发生了文案写入（用于调用方判断是否要顺带失效缓存等）。
    """
    if not values:
        return False
    for field, value in values.items():
        setattr(row, field, value)
    row.listing_copy_updated_at = now or datetime.now(timezone.utc)
    row.listing_copy_updated_by = operator
    return True


def _normalize_item(
    item: SkuRecordCreate, source_file: str | None = None
) -> dict[str, str | Decimal | bool | int | None]:
    provided_fields = set(item.model_fields_set)

    def optional_cost(
        field_name: str, value: float | str | Decimal | None
    ) -> Decimal | None:
        return (
            _normalize_cost(value, field_name)
            if field_name in provided_fields
            else None
        )

    def optional_weight(
        field_name: str, value: float | str | Decimal | None
    ) -> Decimal | None:
        return (
            _normalize_decimal_value(value, field_name, WEIGHT_DECIMAL_QUANT)
            if field_name in provided_fields
            else None
        )

    def optional_int(field_name: str, value: int | str | None) -> int | None:
        return (
            _normalize_int(value, field_name) if field_name in provided_fields else None
        )

    return {
        "project_name": _normalize_text(item.project_name, "project_name"),
        "sku": _normalize_text(item.sku, "sku"),
        "asin": _normalize_optional_text(item.asin) or "",
        "fnsku": ((item.fnsku or "").strip() or None)
        if "fnsku" in provided_fields
        else None,
        "product_name": _normalize_optional_text(item.product_name)
        if "product_name" in provided_fields
        else None,
        "fob_unit_cost": optional_cost("fob_unit_cost", item.fob_unit_cost),
        "first_leg_cost_rmb": optional_cost(
            "first_leg_cost_rmb", item.first_leg_cost_rmb
        ),
        "package_length_cm": optional_cost("package_length_cm", item.package_length_cm),
        "package_width_cm": optional_cost("package_width_cm", item.package_width_cm),
        "package_height_cm": optional_cost("package_height_cm", item.package_height_cm),
        "weight_kg": optional_weight("weight_kg", item.weight_kg),
        "carton_length_cm": optional_cost("carton_length_cm", item.carton_length_cm),
        "carton_width_cm": optional_cost("carton_width_cm", item.carton_width_cm),
        "carton_height_cm": optional_cost("carton_height_cm", item.carton_height_cm),
        "carton_weight_kg": optional_weight("carton_weight_kg", item.carton_weight_kg),
        "units_per_carton": optional_int("units_per_carton", item.units_per_carton),
        "currency": RMB_CURRENCY,
        "country": normalize_country(item.country),
        "sort_order": _normalize_sort_order(item.sort_order),
        "is_active": bool(item.is_active) if "is_active" in provided_fields else None,
        "source_file": (source_file or item.source_file or "").strip() or None,
        "sku_factory_info": item.sku_factory_info
        if "sku_factory_info" in provided_fields
        else None,
    }


def list_sku_records(
    db: Session,
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None,
    page: int,
    page_size: int,
    include_total: bool = False,
    managed_project_ids: list[int] | None = None,
):
    stmt: Select = select(SkuRecord)

    # Non-admin users: always filter by managed_project_ids unless project_name is set
    if managed_project_ids is not None and not project_name:
        stmt = stmt.where(SkuRecord.project_id.in_(managed_project_ids))

    if project_name:
        stmt = stmt.join(Project).where(Project.project_name.ilike(f"%{project_name}%"))

    if sku:
        stmt = stmt.where(SkuRecord.sku.ilike(f"%{sku}%"))
    if asin:
        stmt = stmt.where(SkuRecord.asin.ilike(f"%{asin}%"))
    if country:
        stmt = stmt.where(SkuRecord.country == normalize_country(country))
    if isinstance(is_active, bool):
        stmt = stmt.where(SkuRecord.is_active.is_(is_active))

    rows = (
        db.execute(
            stmt.order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size + 1)
        )
        .scalars()
        .all()
    )

    has_next = len(rows) > page_size
    rows = rows[:page_size]

    total = None
    if include_total:
        total_stmt = select(func.count()).select_from(stmt.subquery())
        total = db.execute(total_stmt).scalar_one()

    return rows, total, has_next


def list_sku_records_all(
    db: Session,
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None = None,
    managed_project_ids: list[int] | None = None,
) -> list[SkuRecord]:
    stmt: Select = select(SkuRecord)

    # Non-admin users: always filter by managed_project_ids unless project_name is set
    if managed_project_ids is not None and not project_name:
        stmt = stmt.where(SkuRecord.project_id.in_(managed_project_ids))

    if project_name:
        stmt = stmt.join(Project).where(Project.project_name.ilike(f"%{project_name}%"))

    if sku:
        stmt = stmt.where(SkuRecord.sku.ilike(f"%{sku}%"))
    if asin:
        stmt = stmt.where(SkuRecord.asin.ilike(f"%{asin}%"))
    if country:
        stmt = stmt.where(SkuRecord.country == normalize_country(country))
    if isinstance(is_active, bool):
        stmt = stmt.where(SkuRecord.is_active.is_(is_active))

    return (
        db.execute(stmt.order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc()))
        .scalars()
        .all()
    )


def upsert_sku_record(
    db: Session,
    item: SkuRecordCreate,
    source_file: str | None = None,
    *,
    next_sort_order_cache: dict[str, int] | None = None,
    operator: str | None = None,
) -> tuple[SkuRecord, str]:
    normalized = _normalize_item(item, source_file)
    listing_values = _listing_copy_values(item)
    project_name = str(normalized["project_name"])
    project_id = _resolve_project_id(db, project_name)

    existing = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.project_id == project_id,
                SkuRecord.sku == normalized["sku"],
                SkuRecord.asin == normalized["asin"],
                SkuRecord.country == normalized["country"],
            )
        )
        .scalars()
        .first()
    )

    action = "updated"
    if existing:
        if "fnsku" in item.model_fields_set:
            existing.fnsku = normalized["fnsku"]
        if "product_name" in item.model_fields_set:
            existing.product_name = normalized["product_name"]
        if normalized["fob_unit_cost"] is not None:
            existing.fob_unit_cost = normalized["fob_unit_cost"]
        if normalized["first_leg_cost_rmb"] is not None:
            existing.first_leg_cost_rmb = normalized["first_leg_cost_rmb"]
        if normalized["package_length_cm"] is not None:
            existing.package_length_cm = normalized["package_length_cm"]
        if normalized["package_width_cm"] is not None:
            existing.package_width_cm = normalized["package_width_cm"]
        if normalized["package_height_cm"] is not None:
            existing.package_height_cm = normalized["package_height_cm"]
        if normalized["weight_kg"] is not None:
            existing.weight_kg = normalized["weight_kg"]
        if normalized["carton_length_cm"] is not None:
            existing.carton_length_cm = normalized["carton_length_cm"]
        if normalized["carton_width_cm"] is not None:
            existing.carton_width_cm = normalized["carton_width_cm"]
        if normalized["carton_height_cm"] is not None:
            existing.carton_height_cm = normalized["carton_height_cm"]
        if normalized["carton_weight_kg"] is not None:
            existing.carton_weight_kg = normalized["carton_weight_kg"]
        if normalized["units_per_carton"] is not None:
            existing.units_per_carton = normalized["units_per_carton"]
        existing.currency = normalized["currency"]
        existing.country = str(normalized["country"])
        if normalized["sort_order"] is not None:
            existing.sort_order = int(normalized["sort_order"])
        if normalized["is_active"] is not None:
            existing.is_active = bool(normalized["is_active"])
        existing.source_file = normalized["source_file"]
        if "sku_factory_info" in item.model_fields_set:
            existing.sku_factory_info = normalized["sku_factory_info"]
        # 产品文案：只写显式提供字段（未提供保持原值，显式 null/空串清空），
        # 显式提供即刷新 listing_copy_updated_{at,by}。
        _apply_listing_copy_fields(existing, listing_values, operator=operator)
        row = existing
    else:
        normalized["sort_order"] = _resolve_insert_sort_order(
            db,
            project_id=project_id,
            requested_sort_order=normalized["sort_order"]
            if isinstance(normalized["sort_order"], int)
            else None,
            next_sort_order_cache=next_sort_order_cache,
        )
        for key in (
            "fob_unit_cost",
            "first_leg_cost_rmb",
            "package_length_cm",
            "package_width_cm",
            "package_height_cm",
            "weight_kg",
            "carton_length_cm",
            "carton_width_cm",
            "carton_height_cm",
            "carton_weight_kg",
            "units_per_carton",
        ):
            if normalized[key] is None:
                normalized[key] = 0
        if normalized["is_active"] is None:
            normalized["is_active"] = True
        normalized["project_id"] = project_id
        row = SkuRecord(**normalized)
        db.add(row)
        db.flush()
        # 新建时若有文案写入（显式提供任一文案字段）才盖溯源列；
        # 未提供的字段保持 NULL —— 「未录入文案」语义。
        _apply_listing_copy_fields(row, listing_values, operator=operator)
        if isinstance(normalized["sort_order"], int):
            _resequence_project_sort_orders(
                db,
                project_id=project_id,
                project_name=project_name,
                prioritized_row=row,
                requested_sort_order=int(normalized["sort_order"]),
            )
        action = "inserted"

    db.flush()
    db.refresh(row)
    return row, action


def update_sku_record_by_id(
    db: Session,
    sku_record_id: int,
    payload: SkuRecordUpdate,
    source_file: str | None = None,
    operator: str | None = None,
) -> SkuRecord:
    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="SKU 成本记录不存在"
        )

    sku = _normalize_text(payload.sku, "sku") if payload.sku is not None else row.sku
    asin = _normalize_optional_text(payload.asin) or ""
    fnsku = (
        ((payload.fnsku or "").strip() or None)
        if "fnsku" in payload.model_fields_set
        else row.fnsku
    )
    product_name = (
        _normalize_optional_text(payload.product_name)
        if "product_name" in payload.model_fields_set
        else row.product_name
    )
    fob_unit_cost = (
        _normalize_cost(payload.fob_unit_cost, "fob_unit_cost")
        if payload.fob_unit_cost is not None
        else row.fob_unit_cost
    )
    first_leg_cost_rmb = (
        _normalize_cost(payload.first_leg_cost_rmb, "first_leg_cost_rmb")
        if payload.first_leg_cost_rmb is not None
        else row.first_leg_cost_rmb
    )
    package_length_cm = (
        _normalize_cost(payload.package_length_cm, "package_length_cm")
        if payload.package_length_cm is not None
        else row.package_length_cm
    )
    package_width_cm = (
        _normalize_cost(payload.package_width_cm, "package_width_cm")
        if payload.package_width_cm is not None
        else row.package_width_cm
    )
    package_height_cm = (
        _normalize_cost(payload.package_height_cm, "package_height_cm")
        if payload.package_height_cm is not None
        else row.package_height_cm
    )
    weight_kg = (
        _normalize_decimal_value(payload.weight_kg, "weight_kg", WEIGHT_DECIMAL_QUANT)
        if payload.weight_kg is not None
        else row.weight_kg
    )
    carton_length_cm = (
        _normalize_cost(payload.carton_length_cm, "carton_length_cm")
        if payload.carton_length_cm is not None
        else row.carton_length_cm
    )
    carton_width_cm = (
        _normalize_cost(payload.carton_width_cm, "carton_width_cm")
        if payload.carton_width_cm is not None
        else row.carton_width_cm
    )
    carton_height_cm = (
        _normalize_cost(payload.carton_height_cm, "carton_height_cm")
        if payload.carton_height_cm is not None
        else row.carton_height_cm
    )
    carton_weight_kg = (
        _normalize_decimal_value(
            payload.carton_weight_kg, "carton_weight_kg", WEIGHT_DECIMAL_QUANT
        )
        if payload.carton_weight_kg is not None
        else row.carton_weight_kg
    )
    units_per_carton = (
        _normalize_int(payload.units_per_carton, "units_per_carton")
        if payload.units_per_carton is not None
        else row.units_per_carton
    )
    country = normalize_country(payload.country)
    sort_order = _normalize_sort_order(payload.sort_order)
    normalized_source_file = (source_file or payload.source_file or "").strip() or None

    duplicate = (
        db.execute(
            select(SkuRecord).where(
                SkuRecord.project_id == row.project_id,
                SkuRecord.sku == sku,
                SkuRecord.asin == asin,
                SkuRecord.country == country,
                SkuRecord.id != sku_record_id,
            )
        )
        .scalars()
        .first()
    )
    if duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="更新后与现有记录重复（project_id + sku + asin + country）",
        )

    row.sku = sku
    row.asin = asin
    row.fnsku = fnsku
    row.product_name = product_name
    row.fob_unit_cost = fob_unit_cost
    row.first_leg_cost_rmb = first_leg_cost_rmb
    row.package_length_cm = package_length_cm
    row.package_width_cm = package_width_cm
    row.package_height_cm = package_height_cm
    row.weight_kg = weight_kg
    row.carton_length_cm = carton_length_cm
    row.carton_width_cm = carton_width_cm
    row.carton_height_cm = carton_height_cm
    row.carton_weight_kg = carton_weight_kg
    row.units_per_carton = units_per_carton
    row.currency = RMB_CURRENCY
    row.country = country
    if sort_order is not None:
        row.sort_order = sort_order
        _resequence_project_sort_orders(
            db,
            project_id=row.project_id,
            prioritized_row=row,
            requested_sort_order=sort_order,
        )
    row.is_active = bool(payload.is_active)
    row.source_file = normalized_source_file

    if "sku_factory_info" in payload.model_fields_set:
        row.sku_factory_info = payload.sku_factory_info
        row.sku_factory_info_updated_at = datetime.now(timezone.utc)
        row.sku_factory_info_updated_by = operator

    # 产品文案（BLF-1080 P1）：与 sku_factory_info 同构——只写显式提供字段，
    # 显式提供即刷新 listing_copy_updated_{at,by}。
    _apply_listing_copy_fields(row, _listing_copy_values(payload), operator=operator)

    db.flush()
    db.refresh(row)
    return row


def delete_sku_record(db: Session, sku_record_id: int) -> SkuRecord:
    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="SKU 成本记录不存在"
        )
    db.delete(row)
    db.flush()
    return row


def bulk_upsert_sku_records(
    db: Session,
    items: list[SkuRecordCreate],
    source_file: str | None = None,
    *,
    operator: str | None = None,
) -> tuple[list[SkuRecord], int, int]:
    inserted = 0
    updated = 0
    rows: list[SkuRecord] = []
    next_sort_order_cache: dict[str, int] = {}
    for item in items:
        row, action = upsert_sku_record(
            db,
            item,
            source_file,
            next_sort_order_cache=next_sort_order_cache,
            operator=operator,
        )
        rows.append(row)
        if action == "inserted":
            inserted += 1
        else:
            updated += 1
    return rows, inserted, updated


def move_sku_record_sort_order(
    db: Session, sku_record_id: int, direction: str
) -> SkuRecord:
    normalized_direction = direction.strip().lower()
    if normalized_direction not in {"up", "down"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="direction must be up or down",
        )

    row = (
        db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id))
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="SKU 成本记录不存在"
        )

    if normalized_direction == "up":
        target = (
            db.execute(
                select(SkuRecord)
                .where(
                    SkuRecord.project_id == row.project_id,
                    SkuRecord.id != row.id,
                    or_(
                        SkuRecord.sort_order < row.sort_order,
                        and_(
                            SkuRecord.sort_order == row.sort_order,
                            SkuRecord.id < row.id,
                        ),
                    ),
                )
                .order_by(SkuRecord.sort_order.desc(), SkuRecord.id.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
    else:
        target = (
            db.execute(
                select(SkuRecord)
                .where(
                    SkuRecord.project_id == row.project_id,
                    SkuRecord.id != row.id,
                    or_(
                        SkuRecord.sort_order > row.sort_order,
                        and_(
                            SkuRecord.sort_order == row.sort_order,
                            SkuRecord.id > row.id,
                        ),
                    ),
                )
                .order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
                .limit(1)
            )
            .scalars()
            .first()
        )

    if target is None:
        db.refresh(row)
        return row

    row_sort_order = int(row.sort_order)
    row.sort_order = int(target.sort_order)
    target.sort_order = row_sort_order
    db.flush()
    db.refresh(row)
    return row
