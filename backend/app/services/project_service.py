from __future__ import annotations

import csv
from io import StringIO
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import ProductCost, Project

DEFAULT_PROJECTS_CSV_PATH = Path(__file__).resolve().parents[3] / 'Docs' / 'ModelFiles' / 'projects.csv'
PROJECT_NAME_HEADER = '项目名称'


def _normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def read_projects_csv_file(csv_path: Path | None = None) -> tuple[list[str], str, int, int]:
    target = csv_path or DEFAULT_PROJECTS_CSV_PATH
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f'CSV 文件不存在: {target}')

    try:
        content = target.read_bytes()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f'读取 CSV 文件失败: {exc}',
        ) from exc

    project_names, skipped, total = parse_projects_csv(content)
    return project_names, target.name, skipped, total


def parse_projects_csv(content: bytes) -> tuple[list[str], int, int]:
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 编码必须为 UTF-8') from None

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 缺少表头')

    available_headers = {name.strip() for name in reader.fieldnames if name}
    if PROJECT_NAME_HEADER not in available_headers:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'CSV 缺少字段: {PROJECT_NAME_HEADER}')

    seen_names: set[str] = set()
    project_names: list[str] = []
    skipped = 0
    total = 0
    for row in reader:
        total += 1
        normalized_row = {(key or '').strip(): value for key, value in row.items()}
        project_name = (normalized_row.get(PROJECT_NAME_HEADER) or '').strip()
        if not project_name or project_name in seen_names:
            skipped += 1
            continue

        seen_names.add(project_name)
        project_names.append(project_name)

    if not project_names:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='CSV 没有可导入的有效数据')

    return project_names, skipped, total


def bulk_upsert_projects(
    db: Session, project_names: list[str], source_file: str | None = None
) -> tuple[list[Project], int, int]:
    inserted = 0
    updated = 0
    rows: list[Project] = []

    max_sort_order = db.execute(select(func.coalesce(func.max(Project.sort_order), -1))).scalar_one()
    next_sort_order = int(max_sort_order) + 1

    for name in project_names:
        existing = db.execute(select(Project).where(Project.project_name == name)).scalars().first()
        if existing:
            existing.source_file = (source_file or '').strip() or None
            rows.append(existing)
            updated += 1
            continue

        row = Project(
            project_name=name,
            sort_order=next_sort_order,
            source_file=(source_file or '').strip() or None,
        )
        db.add(row)
        rows.append(row)
        inserted += 1
        next_sort_order += 1

    db.flush()
    return rows, inserted, updated


def list_project_items(db: Session) -> list[Project]:
    stmt = select(Project).order_by(Project.sort_order.asc(), Project.id.asc())
    return db.execute(stmt).scalars().all()


def list_project_options(db: Session) -> list[dict[str, str]]:
    rows = list_project_items(db)
    if rows:
        return [{'name': row.project_name} for row in rows]

    # Backward-compatible fallback: if projects table is empty, use product_costs distinct project names.
    fallback_stmt = select(ProductCost.project_name).distinct().order_by(ProductCost.project_name.asc())
    try:
        names = [row[0] for row in db.execute(fallback_stmt).all()]
    except SQLAlchemyError:
        return []
    return [{'name': name} for name in names]


def create_single_project(
    db: Session,
    name: str,
    brand_name: str | None = None,
    store_address: str | None = None,
    source_file: str | None = None,
) -> Project:
    project_name = name.strip()
    if not project_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='name is required')

    existing = db.execute(select(Project).where(Project.project_name == project_name)).scalars().first()
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='项目已存在')

    max_sort_order = db.execute(select(func.coalesce(func.max(Project.sort_order), -1))).scalar_one()
    row = Project(
        project_name=project_name,
        brand_name=_normalize_optional_text(brand_name),
        store_address=_normalize_optional_text(store_address),
        sort_order=int(max_sort_order) + 1,
        source_file=(source_file or '').strip() or 'manual_single_add',
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def update_project(
    db: Session,
    project_id: int,
    name: str,
    brand_name: str | None = None,
    store_address: str | None = None,
) -> Project:
    project_name = name.strip()
    if not project_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='name is required')

    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='项目不存在')

    duplicate = db.execute(select(Project).where(Project.project_name == project_name, Project.id != project_id)).scalars().first()
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='项目名称已存在')

    row.project_name = project_name
    row.brand_name = _normalize_optional_text(brand_name)
    row.store_address = _normalize_optional_text(store_address)
    db.flush()
    db.refresh(row)
    return row
