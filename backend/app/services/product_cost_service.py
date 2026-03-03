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
DEFAULT_BLF_BASIC_INFO_PATH = Path(__file__).resolve().parents[3] / 'Docs' / 'ModelFiles' / 'BLF_Basic_Info.csv'


def list_projects(db: Session) -> list[dict[str, str]]:
    stmt = select(ProductCost.project_name).distinct().order_by(ProductCost.project_name.asc())
    names = [row[0] for row in db.execute(stmt).all()]
    return [{'name': name} for name in names]


def list_product_costs(
    db: Session,
    project_name: str | None,
    sku: str | None,
    asin: str | None,
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
    is_active: bool | None = None,
) -> list[ProductCost]:
    stmt: Select = select(ProductCost)

    if project_name:
        stmt = stmt.where(ProductCost.project_name.ilike(f'%{project_name}%'))
    if sku:
        stmt = stmt.where(ProductCost.sku.ilike(f'%{sku}%'))
    if asin:
        stmt = stmt.where(ProductCost.asin.ilike(f'%{asin}%'))
    if isinstance(is_active, bool):
        stmt = stmt.where(ProductCost.is_active.is_(is_active))

    return db.execute(stmt.order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())).scalars().all()


def _normalize_text(value: str | None, field_name: str) -> str:
    normalized = (value or '').strip()
    if not normalized:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f'{field_name} is required')
    return normalized


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


def _normalize_item(item: ProductCostCreate, source_file: str | None = None) -> dict[str, str | Decimal | bool | int | None]:
    return {
        'project_name': _normalize_text(item.project_name, 'project_name'),
        'sku': _normalize_text(item.sku, 'sku'),
        'asin': _normalize_text(item.asin, 'asin'),
        'first_leg_unit_cost': _normalize_cost(item.first_leg_unit_cost, 'first_leg_unit_cost'),
        'fob_unit_cost': _normalize_cost(item.fob_unit_cost, 'fob_unit_cost'),
        'currency': _normalize_text(item.currency or 'USD', 'currency'),
        'sort_order': _normalize_sort_order(item.sort_order),
        'is_active': bool(item.is_active),
        'source_file': (source_file or item.source_file or '').strip() or None,
    }


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
            )
        )
        .scalars()
        .first()
    )

    action = 'updated'
    if existing:
        existing.first_leg_unit_cost = normalized['first_leg_unit_cost']
        existing.fob_unit_cost = normalized['fob_unit_cost']
        existing.currency = normalized['currency']
        if normalized['sort_order'] is not None:
            existing.sort_order = int(normalized['sort_order'])
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
        row = ProductCost(**normalized)
        db.add(row)
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
    asin = _normalize_text(payload.asin, 'asin')
    first_leg_unit_cost = _normalize_cost(payload.first_leg_unit_cost, 'first_leg_unit_cost')
    fob_unit_cost = _normalize_cost(payload.fob_unit_cost, 'fob_unit_cost')
    currency = _normalize_text(payload.currency or 'USD', 'currency')
    sort_order = _normalize_sort_order(payload.sort_order)
    normalized_source_file = (source_file or payload.source_file or '').strip() or None

    duplicate = (
        db.execute(
            select(ProductCost).where(
                ProductCost.project_name == row.project_name,
                ProductCost.sku == sku,
                ProductCost.asin == asin,
                ProductCost.id != product_cost_id,
            )
        )
        .scalars()
        .first()
    )
    if duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail='更新后与现有记录重复（project_name + sku + asin）',
        )

    row.sku = sku
    row.asin = asin
    row.first_leg_unit_cost = first_leg_unit_cost
    row.fob_unit_cost = fob_unit_cost
    row.currency = currency
    if sort_order is not None:
        row.sort_order = sort_order
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
    required_headers = {'project_name', 'SKU', 'ASIN', '头程单价', 'FOB单价'}
    if not reader.fieldnames:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 缺少表头')

    available_headers = {name.strip() for name in reader.fieldnames if name}
    if not required_headers.issubset(available_headers):
        missing = ', '.join(sorted(required_headers - available_headers))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'CSV 缺少字段: {missing}')

    items: list[ProductCostCreate] = []
    for row in reader:
        normalized_row = {(key or '').strip(): value for key, value in row.items()}
        items.append(
            ProductCostCreate(
                project_name=(normalized_row.get('project_name') or '').strip(),
                sku=(normalized_row.get('SKU') or '').strip(),
                asin=(normalized_row.get('ASIN') or '').strip(),
                first_leg_unit_cost=(normalized_row.get('头程单价') or '').strip() or 0,
                fob_unit_cost=(normalized_row.get('FOB单价') or '').strip() or 0,
                currency='USD',
            )
        )

    valid_items = [item for item in items if item.project_name and item.sku and item.asin]
    if not valid_items:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 没有可导入的有效数据')

    return valid_items
