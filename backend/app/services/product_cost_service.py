from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import StringIO
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models import ProductCost
from app.schemas.product_cost import ProductCostCreate

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

    rows = db.execute(
        stmt.order_by(ProductCost.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
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
) -> list[ProductCost]:
    stmt: Select = select(ProductCost)

    if project_name:
        stmt = stmt.where(ProductCost.project_name.ilike(f'%{project_name}%'))
    if sku:
        stmt = stmt.where(ProductCost.sku.ilike(f'%{sku}%'))
    if asin:
        stmt = stmt.where(ProductCost.asin.ilike(f'%{asin}%'))

    return db.execute(stmt.order_by(ProductCost.id.desc())).scalars().all()


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


def _normalize_item(item: ProductCostCreate, source_file: str | None = None) -> dict[str, str | Decimal]:
    return {
        'project_name': _normalize_text(item.project_name, 'project_name'),
        'sku': _normalize_text(item.sku, 'sku'),
        'asin': _normalize_text(item.asin, 'asin'),
        'first_leg_unit_cost': _normalize_cost(item.first_leg_unit_cost, 'first_leg_unit_cost'),
        'fob_unit_cost': _normalize_cost(item.fob_unit_cost, 'fob_unit_cost'),
        'currency': _normalize_text(item.currency or 'USD', 'currency'),
        'source_file': (source_file or item.source_file or '').strip() or None,
    }


def upsert_product_cost(db: Session, item: ProductCostCreate, source_file: str | None = None) -> tuple[ProductCost, str]:
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
        existing.source_file = normalized['source_file']
        row = existing
    else:
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


def bulk_upsert_product_costs(
    db: Session, items: list[ProductCostCreate], source_file: str | None = None
) -> tuple[list[ProductCost], int, int]:
    inserted = 0
    updated = 0
    rows: list[ProductCost] = []
    for item in items:
        row, action = upsert_product_cost(db, item, source_file)
        rows.append(row)
        if action == 'inserted':
            inserted += 1
        else:
            updated += 1
    return rows, inserted, updated


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
