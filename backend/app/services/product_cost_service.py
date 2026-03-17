from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import StringIO
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import ProductCost
from app.schemas.product_cost import ProductCostCreate, ProductCostUpdate

DECIMAL_ZERO = Decimal('0')
COST_DECIMAL_QUANT = Decimal('0.01')
WEIGHT_DECIMAL_QUANT = Decimal('0.001')
RMB_CURRENCY = 'CNY'
DEFAULT_BLF_BASIC_INFO_PATH = Path(__file__).resolve().parents[3] / 'Docs' / 'ModelFiles' / 'BLF_Basic_Info.csv'
COUNTRY_ALIASES = {
    'US': 'US',
    'USA': 'US',
    '美国': 'US',
    '美国站': 'US',
    'DE': 'DE',
    'GERMANY': 'DE',
    '德国': 'DE',
    '德国站': 'DE',
    'UK': 'UK',
    'GB': 'UK',
    'UNITED KINGDOM': 'UK',
    '英国': 'UK',
    '英国站': 'UK',
}
ALLOWED_COUNTRIES = {'US', 'DE', 'UK'}


def list_projects(db: Session) -> list[dict[str, str]]:
    stmt = select(ProductCost.project_name).distinct().order_by(ProductCost.project_name.asc())
    names = [row[0] for row in db.execute(stmt).all()]
    return [{'name': name} for name in names]


def list_product_costs(
    db: Session,
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None,
    page: int,
    page_size: int,
    include_total: bool = False,
):
    stmt: Select = select(ProductCost)

    if project_name:
        stmt = stmt.where(ProductCost.project_name.ilike(f'%{project_name}%'))
    if sku:
        stmt = stmt.where(ProductCost.sku.ilike(f'%{sku}%'))
    if asin:
        stmt = stmt.where(ProductCost.asin.ilike(f'%{asin}%'))
    if country:
        stmt = stmt.where(ProductCost.country == _normalize_country(country))
    if isinstance(is_active, bool):
        stmt = stmt.where(ProductCost.is_active.is_(is_active))

    rows = db.execute(
        stmt.order_by(ProductCost.sort_order.asc(), ProductCost.id.asc()).offset((page - 1) * page_size).limit(page_size + 1)
    ).scalars().all()

    has_next = len(rows) > page_size
    rows = rows[:page_size]

    total = None
    if include_total:
        total_stmt = select(func.count()).select_from(stmt.subquery())
        total = db.execute(total_stmt).scalar_one()

    return rows, total, has_next


def list_product_costs_all(
    db: Session,
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None = None,
) -> list[ProductCost]:
    stmt: Select = select(ProductCost)

    if project_name:
        stmt = stmt.where(ProductCost.project_name.ilike(f'%{project_name}%'))
    if sku:
        stmt = stmt.where(ProductCost.sku.ilike(f'%{sku}%'))
    if asin:
        stmt = stmt.where(ProductCost.asin.ilike(f'%{asin}%'))
    if country:
        stmt = stmt.where(ProductCost.country == _normalize_country(country))
    if isinstance(is_active, bool):
        stmt = stmt.where(ProductCost.is_active.is_(is_active))

    return db.execute(stmt.order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())).scalars().all()


def _normalize_text(value: str | None, field_name: str) -> str:
    normalized = (value or '').strip()
    if not normalized:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} is required')
    return normalized


def _normalize_optional_text(value: str | None) -> str | None:
    normalized = (value or '').strip()
    return normalized or None


def _normalize_cost(value: float | str | Decimal | None, field_name: str) -> Decimal:
    if value is None or value == '':
        return DECIMAL_ZERO
    try:
        dec = Decimal(str(value)).quantize(COST_DECIMAL_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be numeric') from None
    if dec < 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be >= 0')
    return dec


def _normalize_decimal_value(value: float | str | Decimal | None, field_name: str, quant: Decimal) -> Decimal:
    if value is None or value == '':
        return Decimal('0').quantize(quant)
    try:
        dec = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be numeric') from None
    if dec < 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be >= 0')
    return dec


def _normalize_sort_order(value: int | str | None) -> int | None:
    if value is None or value == '':
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='sort_order must be integer') from None
    if parsed < 1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='sort_order must be >= 1')
    return parsed


def _normalize_int(value: int | str | None, field_name: str) -> int:
    if value is None or value == '':
        return 0
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be integer') from None
    if parsed < 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} must be >= 0')
    return parsed


def _normalize_country(value: str | None) -> str:
    normalized = (value or '').strip().upper()
    if not normalized:
        return 'US'
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in ALLOWED_COUNTRIES:
        allowed = ', '.join(sorted(ALLOWED_COUNTRIES))
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'country must be one of: {allowed}')
    return mapped


def _next_sort_order_for_project(db: Session, project_name: str) -> int:
    value = db.execute(
        select(func.coalesce(func.max(ProductCost.sort_order), 0)).where(ProductCost.project_name == project_name)
    ).scalar_one()
    return int(value or 0) + 1


def _resolve_insert_sort_order(
    db: Session,
    *,
    project_name: str,
    requested_sort_order: int | None,
    next_sort_order_cache: dict[str, int] | None,
) -> int:
    if requested_sort_order is not None:
        return requested_sort_order

    if next_sort_order_cache is not None and project_name in next_sort_order_cache:
        resolved = next_sort_order_cache[project_name]
        next_sort_order_cache[project_name] = resolved + 1
        return resolved

    next_order = _next_sort_order_for_project(db, project_name)
    if next_sort_order_cache is not None:
        next_sort_order_cache[project_name] = next_order + 1
    return next_order


def _resequence_project_sort_orders(
    db: Session,
    *,
    project_name: str,
    prioritized_row: ProductCost | None = None,
    requested_sort_order: int | None = None,
) -> None:
    rows = (
        db.execute(
            select(ProductCost)
            .where(ProductCost.project_name == project_name)
            .order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())
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


def _normalize_item(item: ProductCostCreate, source_file: str | None = None) -> dict[str, str | Decimal | bool | int | None]:
    provided_fields = set(item.model_fields_set)

    def optional_cost(field_name: str, value: float | str | Decimal | None) -> Decimal | None:
        return _normalize_cost(value, field_name) if field_name in provided_fields else None

    def optional_weight(field_name: str, value: float | str | Decimal | None) -> Decimal | None:
        return _normalize_decimal_value(value, field_name, WEIGHT_DECIMAL_QUANT) if field_name in provided_fields else None

    def optional_int(field_name: str, value: int | str | None) -> int | None:
        return _normalize_int(value, field_name) if field_name in provided_fields else None

    return {
        'project_name': _normalize_text(item.project_name, 'project_name'),
        'sku': _normalize_text(item.sku, 'sku'),
        'asin': _normalize_optional_text(item.asin) or '',
        'fnsku': ((item.fnsku or '').strip() or None) if 'fnsku' in provided_fields else None,
        'fob_unit_cost': optional_cost('fob_unit_cost', item.fob_unit_cost),
        'first_leg_cost_rmb': optional_cost('first_leg_cost_rmb', item.first_leg_cost_rmb),
        'package_length_cm': optional_cost('package_length_cm', item.package_length_cm),
        'package_width_cm': optional_cost('package_width_cm', item.package_width_cm),
        'package_height_cm': optional_cost('package_height_cm', item.package_height_cm),
        'weight_kg': optional_weight('weight_kg', item.weight_kg),
        'carton_length_cm': optional_cost('carton_length_cm', item.carton_length_cm),
        'carton_width_cm': optional_cost('carton_width_cm', item.carton_width_cm),
        'carton_height_cm': optional_cost('carton_height_cm', item.carton_height_cm),
        'carton_weight_kg': optional_weight('carton_weight_kg', item.carton_weight_kg),
        'units_per_carton': optional_int('units_per_carton', item.units_per_carton),
        'currency': RMB_CURRENCY,
        'country': _normalize_country(item.country),
        'sort_order': _normalize_sort_order(item.sort_order),
        'is_active': bool(item.is_active) if 'is_active' in provided_fields else None,
        'source_file': (source_file or item.source_file or '').strip() or None,
    }


def _normalize_item_for_import(
    item: ProductCostCreate,
    source_file: str | None = None,
) -> dict[str, str | Decimal | bool | int | None]:
    provided_fields = set(item.model_fields_set)

    def optional_cost(field_name: str, value: float | str | Decimal | None) -> Decimal | None:
        return _normalize_cost(value, field_name) if field_name in provided_fields and value not in (None, '') else None

    def optional_weight(field_name: str, value: float | str | Decimal | None) -> Decimal | None:
        return _normalize_decimal_value(value, field_name, WEIGHT_DECIMAL_QUANT) if field_name in provided_fields and value not in (None, '') else None

    def optional_int(field_name: str, value: int | str | None) -> int | None:
        return _normalize_int(value, field_name) if field_name in provided_fields and value not in (None, '') else None

    return {
        'project_name': _normalize_text(item.project_name, 'project_name'),
        'sku': _normalize_text(item.sku, 'sku'),
        'asin': _normalize_optional_text(item.asin) or '',
        'fnsku': _normalize_optional_text(item.fnsku) if 'fnsku' in provided_fields else None,
        'fob_unit_cost': optional_cost('fob_unit_cost', item.fob_unit_cost),
        'first_leg_cost_rmb': optional_cost('first_leg_cost_rmb', item.first_leg_cost_rmb),
        'package_length_cm': optional_cost('package_length_cm', item.package_length_cm),
        'package_width_cm': optional_cost('package_width_cm', item.package_width_cm),
        'package_height_cm': optional_cost('package_height_cm', item.package_height_cm),
        'weight_kg': optional_weight('weight_kg', item.weight_kg),
        'carton_length_cm': optional_cost('carton_length_cm', item.carton_length_cm),
        'carton_width_cm': optional_cost('carton_width_cm', item.carton_width_cm),
        'carton_height_cm': optional_cost('carton_height_cm', item.carton_height_cm),
        'carton_weight_kg': optional_weight('carton_weight_kg', item.carton_weight_kg),
        'units_per_carton': optional_int('units_per_carton', item.units_per_carton),
        'currency': RMB_CURRENCY,
        'country': _normalize_country(item.country),
        'sort_order': _normalize_sort_order(item.sort_order),
        'is_active': bool(item.is_active) if 'is_active' in provided_fields else None,
        'source_file': (source_file or item.source_file or '').strip() or None,
    }


def _find_existing_for_import(
    db: Session,
    normalized: dict[str, str | Decimal | bool | int | None],
    *,
    allow_multiple_matches: bool = False,
) -> ProductCost | None:
    project_name = str(normalized['project_name'])
    sku = str(normalized['sku'])
    country = str(normalized['country'])

    matches = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == project_name,
                ProductCost.sku == sku,
                ProductCost.country == country,
            )
        )
        .scalars()
        .all()
    )
    if len(matches) > 1 and not allow_multiple_matches:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f'存在多条同 project_name + SKU + 国家 的记录，请补充 ASIN 后再导入: {project_name} / {sku} / {country}',
        )
    return matches[0] if matches else None


def _csv_value(normalized_row: dict[str, str | None], *headers: str) -> tuple[str, bool]:
    for header in headers:
        if header in normalized_row:
            return (normalized_row.get(header) or '').strip(), True
    return '', False


def upsert_product_cost(
    db: Session,
    item: ProductCostCreate,
    source_file: str | None = None,
    *,
    next_sort_order_cache: dict[str, int] | None = None,
) -> tuple[ProductCost, str]:
    normalized = _normalize_item(item, source_file)
    existing = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == normalized['project_name'],
                ProductCost.sku == normalized['sku'],
                ProductCost.asin == normalized['asin'],
                ProductCost.country == normalized['country'],
            )
        )
        .scalars()
        .first()
    )

    action = 'updated'
    if existing:
        if 'fnsku' in item.model_fields_set:
            existing.fnsku = normalized['fnsku']
        if normalized['fob_unit_cost'] is not None:
            existing.fob_unit_cost = normalized['fob_unit_cost']
        if normalized['first_leg_cost_rmb'] is not None:
            existing.first_leg_cost_rmb = normalized['first_leg_cost_rmb']
        if normalized['package_length_cm'] is not None:
            existing.package_length_cm = normalized['package_length_cm']
        if normalized['package_width_cm'] is not None:
            existing.package_width_cm = normalized['package_width_cm']
        if normalized['package_height_cm'] is not None:
            existing.package_height_cm = normalized['package_height_cm']
        if normalized['weight_kg'] is not None:
            existing.weight_kg = normalized['weight_kg']
        if normalized['carton_length_cm'] is not None:
            existing.carton_length_cm = normalized['carton_length_cm']
        if normalized['carton_width_cm'] is not None:
            existing.carton_width_cm = normalized['carton_width_cm']
        if normalized['carton_height_cm'] is not None:
            existing.carton_height_cm = normalized['carton_height_cm']
        if normalized['carton_weight_kg'] is not None:
            existing.carton_weight_kg = normalized['carton_weight_kg']
        if normalized['units_per_carton'] is not None:
            existing.units_per_carton = normalized['units_per_carton']
        existing.currency = normalized['currency']
        existing.country = str(normalized['country'])
        if normalized['sort_order'] is not None:
            existing.sort_order = int(normalized['sort_order'])
        if normalized['is_active'] is not None:
            existing.is_active = bool(normalized['is_active'])
        existing.source_file = normalized['source_file']
        row = existing
    else:
        normalized['sort_order'] = _resolve_insert_sort_order(
            db,
            project_name=str(normalized['project_name']),
            requested_sort_order=normalized['sort_order'] if isinstance(normalized['sort_order'], int) else None,
            next_sort_order_cache=next_sort_order_cache,
        )
        if db.bind and db.bind.dialect.name == 'sqlite':
            # Compatibility fallback for legacy sqlite schema without auto-increment id.
            next_id = db.execute(select(func.coalesce(func.max(ProductCost.id), 0) + 1)).scalar_one()
            normalized['id'] = int(next_id)
        for key in (
            'fob_unit_cost',
            'first_leg_cost_rmb',
            'package_length_cm',
            'package_width_cm',
            'package_height_cm',
            'weight_kg',
            'carton_length_cm',
            'carton_width_cm',
            'carton_height_cm',
            'carton_weight_kg',
            'units_per_carton',
        ):
            if normalized[key] is None:
                normalized[key] = 0
        if normalized['is_active'] is None:
            normalized['is_active'] = True
        row = ProductCost(**normalized)
        db.add(row)
        db.flush()
        if isinstance(normalized['sort_order'], int):
            _resequence_project_sort_orders(
                db,
                project_name=str(normalized['project_name']),
                prioritized_row=row,
                requested_sort_order=int(normalized['sort_order']),
            )
        action = 'inserted'

    db.flush()
    db.refresh(row)
    return row, action


def update_product_cost_by_id(
    db: Session, product_cost_id: int, payload: ProductCostUpdate, source_file: str | None = None
) -> ProductCost:
    row = db.execute(select(ProductCost).where(ProductCost.id == product_cost_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='SKU 成本记录不存在')

    sku = _normalize_text(payload.sku, 'sku')
    asin = _normalize_optional_text(payload.asin) or ''
    fnsku = ((payload.fnsku or '').strip() or None) if 'fnsku' in payload.model_fields_set else row.fnsku
    fob_unit_cost = _normalize_cost(payload.fob_unit_cost, 'fob_unit_cost') if payload.fob_unit_cost is not None else row.fob_unit_cost
    first_leg_cost_rmb = _normalize_cost(payload.first_leg_cost_rmb, 'first_leg_cost_rmb') if payload.first_leg_cost_rmb is not None else row.first_leg_cost_rmb
    package_length_cm = _normalize_cost(payload.package_length_cm, 'package_length_cm') if payload.package_length_cm is not None else row.package_length_cm
    package_width_cm = _normalize_cost(payload.package_width_cm, 'package_width_cm') if payload.package_width_cm is not None else row.package_width_cm
    package_height_cm = _normalize_cost(payload.package_height_cm, 'package_height_cm') if payload.package_height_cm is not None else row.package_height_cm
    weight_kg = _normalize_decimal_value(payload.weight_kg, 'weight_kg', WEIGHT_DECIMAL_QUANT) if payload.weight_kg is not None else row.weight_kg
    carton_length_cm = _normalize_cost(payload.carton_length_cm, 'carton_length_cm') if payload.carton_length_cm is not None else row.carton_length_cm
    carton_width_cm = _normalize_cost(payload.carton_width_cm, 'carton_width_cm') if payload.carton_width_cm is not None else row.carton_width_cm
    carton_height_cm = _normalize_cost(payload.carton_height_cm, 'carton_height_cm') if payload.carton_height_cm is not None else row.carton_height_cm
    carton_weight_kg = _normalize_decimal_value(payload.carton_weight_kg, 'carton_weight_kg', WEIGHT_DECIMAL_QUANT) if payload.carton_weight_kg is not None else row.carton_weight_kg
    units_per_carton = _normalize_int(payload.units_per_carton, 'units_per_carton') if payload.units_per_carton is not None else row.units_per_carton
    country = _normalize_country(payload.country)
    sort_order = _normalize_sort_order(payload.sort_order)
    normalized_source_file = (source_file or payload.source_file or '').strip() or None

    duplicate = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == row.project_name,
                ProductCost.sku == sku,
                ProductCost.asin == asin,
                ProductCost.country == country,
                ProductCost.id != product_cost_id,
            )
        )
        .scalars()
        .first()
    )
    if duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='更新后与现有记录重复（project_name + sku + asin + country）',
        )

    row.sku = sku
    row.asin = asin
    row.fnsku = fnsku
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
            project_name=row.project_name,
            prioritized_row=row,
            requested_sort_order=sort_order,
        )
    row.is_active = bool(payload.is_active)
    row.source_file = normalized_source_file

    db.flush()
    db.refresh(row)
    return row


def bulk_upsert_product_costs(
    db: Session, items: list[ProductCostCreate], source_file: str | None = None
) -> tuple[list[ProductCost], int, int]:
    inserted = 0
    updated = 0
    rows: list[ProductCost] = []
    next_sort_order_cache: dict[str, int] = {}
    for item in items:
        row, action = upsert_product_cost(db, item, source_file, next_sort_order_cache=next_sort_order_cache)
        rows.append(row)
        if action == 'inserted':
            inserted += 1
        else:
            updated += 1
    return rows, inserted, updated


def import_product_costs(
    db: Session,
    items: list[ProductCostCreate],
    *,
    import_mode: str,
    source_file: str | None = None,
) -> tuple[list[ProductCost], int, int, int]:
    normalized_mode = import_mode.strip().lower()
    if normalized_mode not in {'create', 'update'}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='import_mode must be create or update')

    inserted = 0
    updated = 0
    skipped = 0
    rows: list[ProductCost] = []
    next_sort_order_cache: dict[str, int] = {}

    for item in items:
        normalized = _normalize_item_for_import(item, source_file)
        existing = _find_existing_for_import(
            db,
            normalized,
            allow_multiple_matches=normalized_mode == 'create',
        )

        if normalized_mode == 'create':
            if existing is not None:
                skipped += 1
                continue

            create_item = ProductCostCreate(
                project_name=str(normalized['project_name']),
                sku=str(normalized['sku']),
                asin=str(normalized['asin']),
                fnsku=normalized['fnsku'],
                fob_unit_cost=float(normalized['fob_unit_cost']) if normalized['fob_unit_cost'] is not None else None,
                first_leg_cost_rmb=float(normalized['first_leg_cost_rmb']) if normalized['first_leg_cost_rmb'] is not None else None,
                package_length_cm=float(normalized['package_length_cm']) if normalized['package_length_cm'] is not None else None,
                package_width_cm=float(normalized['package_width_cm']) if normalized['package_width_cm'] is not None else None,
                package_height_cm=float(normalized['package_height_cm']) if normalized['package_height_cm'] is not None else None,
                weight_kg=float(normalized['weight_kg']) if normalized['weight_kg'] is not None else None,
                carton_length_cm=float(normalized['carton_length_cm']) if normalized['carton_length_cm'] is not None else None,
                carton_width_cm=float(normalized['carton_width_cm']) if normalized['carton_width_cm'] is not None else None,
                carton_height_cm=float(normalized['carton_height_cm']) if normalized['carton_height_cm'] is not None else None,
                carton_weight_kg=float(normalized['carton_weight_kg']) if normalized['carton_weight_kg'] is not None else None,
                units_per_carton=int(normalized['units_per_carton']) if normalized['units_per_carton'] is not None else None,
                country=str(normalized['country']),
                sort_order=int(normalized['sort_order']) if normalized['sort_order'] is not None else None,
                is_active=bool(normalized['is_active']) if normalized['is_active'] is not None else True,
                source_file=str(normalized['source_file']) if normalized['source_file'] is not None else None,
            )
            row, _ = upsert_product_cost(db, create_item, source_file, next_sort_order_cache=next_sort_order_cache)
            rows.append(row)
            inserted += 1
            continue

        if existing is None:
            skipped += 1
            continue

        # In update mode, the import key is project_name + SKU + country.
        # All other provided columns should overwrite the existing row, including blanks.
        if 'asin' in item.model_fields_set and str(normalized['asin']) != existing.asin:
            duplicate = (
                db.execute(
                    select(ProductCost).where(
                        ProductCost.project_name == existing.project_name,
                        ProductCost.sku == existing.sku,
                        ProductCost.country == existing.country,
                        ProductCost.asin == str(normalized['asin']),
                        ProductCost.id != existing.id,
                    )
                )
                .scalars()
                .first()
            )
            if duplicate:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f'更新 ASIN 后与现有记录重复: {existing.project_name} / {existing.sku} / {existing.country} / {normalized["asin"]}',
                )
            existing.asin = str(normalized['asin'])
        if 'fnsku' in item.model_fields_set:
            existing.fnsku = str(normalized['fnsku']) if normalized['fnsku'] is not None else None
        if normalized['fob_unit_cost'] is not None:
            existing.fob_unit_cost = normalized['fob_unit_cost']
        if normalized['first_leg_cost_rmb'] is not None:
            existing.first_leg_cost_rmb = normalized['first_leg_cost_rmb']
        if normalized['package_length_cm'] is not None:
            existing.package_length_cm = normalized['package_length_cm']
        if normalized['package_width_cm'] is not None:
            existing.package_width_cm = normalized['package_width_cm']
        if normalized['package_height_cm'] is not None:
            existing.package_height_cm = normalized['package_height_cm']
        if normalized['weight_kg'] is not None:
            existing.weight_kg = normalized['weight_kg']
        if normalized['carton_length_cm'] is not None:
            existing.carton_length_cm = normalized['carton_length_cm']
        if normalized['carton_width_cm'] is not None:
            existing.carton_width_cm = normalized['carton_width_cm']
        if normalized['carton_height_cm'] is not None:
            existing.carton_height_cm = normalized['carton_height_cm']
        if normalized['carton_weight_kg'] is not None:
            existing.carton_weight_kg = normalized['carton_weight_kg']
        if normalized['units_per_carton'] is not None:
            existing.units_per_carton = int(normalized['units_per_carton'])
        if normalized['sort_order'] is not None:
            existing.sort_order = int(normalized['sort_order'])
            _resequence_project_sort_orders(
                db,
                project_name=existing.project_name,
                prioritized_row=existing,
                requested_sort_order=int(normalized['sort_order']),
            )
        if normalized['is_active'] is not None:
            existing.is_active = bool(normalized['is_active'])
        existing.currency = RMB_CURRENCY
        existing.source_file = str(normalized['source_file']) if normalized['source_file'] is not None else existing.source_file
        db.flush()
        db.refresh(existing)
        rows.append(existing)
        updated += 1

    return rows, inserted, updated, skipped


def move_product_cost_sort_order(db: Session, product_cost_id: int, direction: str) -> ProductCost:
    normalized_direction = direction.strip().lower()
    if normalized_direction not in {'up', 'down'}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='direction must be up or down')

    row = db.execute(select(ProductCost).where(ProductCost.id == product_cost_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='SKU 成本记录不存在')

    if normalized_direction == 'up':
        target = (
            db.execute(
                select(ProductCost)
                .where(
                    ProductCost.project_name == row.project_name,
                    ProductCost.id != row.id,
                    or_(
                        ProductCost.sort_order < row.sort_order,
                        and_(ProductCost.sort_order == row.sort_order, ProductCost.id < row.id),
                    ),
                )
                .order_by(ProductCost.sort_order.desc(), ProductCost.id.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
    else:
        target = (
            db.execute(
                select(ProductCost)
                .where(
                    ProductCost.project_name == row.project_name,
                    ProductCost.id != row.id,
                    or_(
                        ProductCost.sort_order > row.sort_order,
                        and_(ProductCost.sort_order == row.sort_order, ProductCost.id > row.id),
                    ),
                )
                .order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())
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


def read_product_cost_csv_file(csv_path: Path | None = None) -> tuple[list[ProductCostCreate], str]:
    target = csv_path or DEFAULT_BLF_BASIC_INFO_PATH
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f'CSV 文件不存在: {target}')

    try:
        content = target.read_bytes()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f'读取 CSV 文件失败: {exc}',
        ) from exc

    items = parse_product_cost_csv(content)
    return items, target.name


def parse_product_cost_csv(content: bytes) -> list[ProductCostCreate]:
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 编码必须为 UTF-8') from None

    reader = csv.DictReader(StringIO(text))
    required_headers = {'project_name', 'SKU'}
    if not reader.fieldnames:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 缺少表头')

    available_headers = {name.strip() for name in reader.fieldnames if name}
    if not required_headers.issubset(available_headers):
        missing = ', '.join(sorted(required_headers - available_headers))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'CSV 缺少字段: {missing}')

    items: list[ProductCostCreate] = []
    for row in reader:
        normalized_row = {(key or '').strip(): value for key, value in row.items()}
        asin_value, asin_present = _csv_value(normalized_row, 'ASIN', 'ASIN(可留空)', 'asin')
        fnsku_value, fnsku_present = _csv_value(normalized_row, 'FNSKU', 'FNSKU(可留空)', 'fnsku')
        first_leg_value, first_leg_present = _csv_value(normalized_row, '头程成本(RMB)', '头程成本')
        fob_value, fob_present = _csv_value(normalized_row, 'FOB单价', 'FOB单价(RMB)')
        package_length_value, package_length_present = _csv_value(normalized_row, '单品长(cm)')
        package_width_value, package_width_present = _csv_value(normalized_row, '单品宽(cm)')
        package_height_value, package_height_present = _csv_value(normalized_row, '单品高(cm)')
        weight_value, weight_present = _csv_value(normalized_row, '单品重量(kg)')
        carton_length_value, carton_length_present = _csv_value(normalized_row, '外箱长(cm)')
        carton_width_value, carton_width_present = _csv_value(normalized_row, '外箱宽(cm)')
        carton_height_value, carton_height_present = _csv_value(normalized_row, '外箱高(cm)')
        carton_weight_value, carton_weight_present = _csv_value(normalized_row, '外箱重量(kg)')
        units_value, units_present = _csv_value(normalized_row, '装箱数量')
        items.append(
            ProductCostCreate(
                project_name=(normalized_row.get('project_name') or '').strip(),
                sku=(normalized_row.get('SKU') or '').strip(),
                asin=asin_value if asin_present else '',
                fnsku=fnsku_value or None if fnsku_present else None,
                **({'first_leg_cost_rmb': first_leg_value or 0} if first_leg_present else {}),
                **({'fob_unit_cost': fob_value or 0} if fob_present else {}),
                **({'package_length_cm': package_length_value or 0} if package_length_present else {}),
                **({'package_width_cm': package_width_value or 0} if package_width_present else {}),
                **({'package_height_cm': package_height_value or 0} if package_height_present else {}),
                **({'weight_kg': weight_value or 0} if weight_present else {}),
                **({'carton_length_cm': carton_length_value or 0} if carton_length_present else {}),
                **({'carton_width_cm': carton_width_value or 0} if carton_width_present else {}),
                **({'carton_height_cm': carton_height_value or 0} if carton_height_present else {}),
                **({'carton_weight_kg': carton_weight_value or 0} if carton_weight_present else {}),
                **({'units_per_carton': units_value or 0} if units_present else {}),
                currency=RMB_CURRENCY,
                country=(normalized_row.get('国家') or normalized_row.get('country') or 'US').strip() or 'US',
            )
        )

    valid_items = [item for item in items if item.project_name and item.sku]
    if not valid_items:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 没有可导入的有效数据')

    return valid_items


def recalculate_first_leg_costs(
    db: Session,
    *,
    project_name: str,
    unit_price_per_kg_rmb: float,
    sku: str | None = None,
    asin: str | None = None,
    country: str | None = None,
    is_active: bool | None = None,
) -> int:
    unit_price = _normalize_cost(unit_price_per_kg_rmb, 'unit_price_per_kg_rmb')
    rows = list_product_costs_all(
        db,
        project_name=project_name,
        sku=sku,
        asin=asin,
        country=country,
        is_active=is_active,
    )
    updated = 0
    for row in rows:
        volume_weight = (
            Decimal(str(row.package_length_cm or 0))
            * Decimal(str(row.package_width_cm or 0))
            * Decimal(str(row.package_height_cm or 0))
        ) / Decimal('6000')
        actual_weight = Decimal(str(row.weight_kg or 0))
        chargeable_weight = max(actual_weight, volume_weight)
        row.first_leg_cost_rmb = (chargeable_weight * unit_price).quantize(COST_DECIMAL_QUANT, rounding=ROUND_HALF_UP)
        updated += 1
    db.flush()
    return updated
