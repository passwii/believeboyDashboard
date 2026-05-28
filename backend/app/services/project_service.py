from __future__ import annotations

import csv
import hashlib
import re
from decimal import Decimal, InvalidOperation
from io import StringIO
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import SkuRecord, Project
from app.services.infra import (
    cache_delete,
    cache_delete_pattern,
    cache_get,
    cache_set,
    _make_cache_key,
)
from app.utils.constants import ALLOWED_COMMISSION_BASIS
from typing import Any

DEFAULT_PROJECTS_CSV_PATH = (
    Path(__file__).resolve().parents[3] / "Docs" / "ModelFiles" / "projects.csv"
)
PROJECT_NAME_HEADER = "项目名称"
MULTI_NAME_SPLIT_RE = re.compile(r"[、,，;\n]+")


def _normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _split_multi_names(value: str | None) -> list[str]:
    normalized = _normalize_optional_text(value)
    if normalized is None:
        return []
    return [
        item.strip() for item in MULTI_NAME_SPLIT_RE.split(normalized) if item.strip()
    ]


def _normalize_multi_name_text(value: str | None) -> str | None:
    names = _split_multi_names(value)
    if not names:
        return None

    deduped: list[str] = []
    seen: set[str] = set()
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        deduped.append(name)
    return "、".join(deduped)


def _text_contains_name(value: str | None, target: str | None) -> bool:
    normalized_target = _normalize_optional_text(target)
    if normalized_target is None:
        return False
    return normalized_target in _split_multi_names(value)


def _normalize_commission_basis(value: str | None) -> str | None:
    normalized = _normalize_optional_text(value)
    if normalized is None:
        return None
    if normalized not in ALLOWED_COMMISSION_BASIS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="commission_basis must be one of sales_amount, cash_received, profit_margin",
        )
    return normalized


def _normalize_commission_rate(value: float | Decimal | None) -> Decimal | None:
    if value is None:
        return None
    try:
        rate = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="commission_rate must be numeric",
        )
    if rate < 0 or rate > 100:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="commission_rate must be between 0 and 100 (points) or 0 and 1 (ratio)",
        )
    # Backward-compatible input:
    # - 0~1: ratio (e.g. 0.05 == 5%)
    # - 1~100: points/percent value (e.g. 5 == 5%)
    if rate > 1:
        rate = rate / Decimal("100")
    return rate


ALLOWED_PROJECT_TIERS = {"T1", "T2", "T3", "T4"}


def _normalize_project_tier(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().upper()
    if not normalized:
        return None
    if normalized not in ALLOWED_PROJECT_TIERS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"project_tier must be one of {', '.join(sorted(ALLOWED_PROJECT_TIERS))}",
        )
    return normalized


def _sync_projects_id_sequence(db: Session) -> None:
    if db.bind is None or db.bind.dialect.name != "postgresql":
        return

    db.execute(
        text(
            """
            with target_sequences as (
              select distinct s.relname as sequence_name
              from pg_class c
              join pg_attribute a
                on a.attrelid = c.oid
               and a.attname = 'id'
              join pg_depend d
                on d.refobjid = c.oid
               and d.refobjsubid = a.attnum
               and d.deptype in ('a', 'i')
              join pg_class s
                on s.oid = d.objid
               and s.relkind = 'S'
              where c.oid = 'public.projects'::regclass
            )
            select setval(
              format('public.%I', sequence_name),
              coalesce((select max(id) from public.projects), 1),
              coalesce((select max(id) is not null from public.projects), false)
            )
            from target_sequences
            """
        )
    )


def _is_projects_primary_key_conflict(exc: IntegrityError) -> bool:
    message = str(getattr(exc, "orig", exc))
    return "projects_pkey" in message and "Key (id)=" in message


def read_projects_csv_file(
    csv_path: Path | None = None,
) -> tuple[list[str], str, int, int]:
    target = csv_path or DEFAULT_PROJECTS_CSV_PATH
    if not target.exists() or not target.is_file():
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"CSV 文件不存在: {target}",
        )

    try:
        content = target.read_bytes()
    except OSError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"读取 CSV 文件失败: {exc}",
        ) from exc

    project_names, skipped, total = parse_projects_csv(content)
    return project_names, target.name, skipped, total


def parse_projects_csv(content: bytes) -> tuple[list[str], int, int]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 编码必须为 UTF-8"
        ) from None

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 缺少表头"
        )

    available_headers = {name.strip() for name in reader.fieldnames if name}
    if PROJECT_NAME_HEADER not in available_headers:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CSV 缺少字段: {PROJECT_NAME_HEADER}",
        )

    seen_names: set[str] = set()
    project_names: list[str] = []
    skipped = 0
    total = 0
    for row in reader:
        total += 1
        normalized_row = {(key or "").strip(): value for key, value in row.items()}
        project_name = (normalized_row.get(PROJECT_NAME_HEADER) or "").strip()
        if not project_name or project_name in seen_names:
            skipped += 1
            continue

        seen_names.add(project_name)
        project_names.append(project_name)

    if not project_names:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="CSV 没有可导入的有效数据"
        )

    return project_names, skipped, total


def bulk_upsert_projects(
    db: Session, project_names: list[str], source_file: str | None = None
) -> tuple[list[Project], int, int]:
    inserted = 0
    updated = 0
    rows: list[Project] = []

    max_sort_order = db.execute(
        select(func.coalesce(func.max(Project.sort_order), -1))
    ).scalar_one()
    next_sort_order = int(max_sort_order) + 1

    for name in project_names:
        existing = (
            db.execute(select(Project).where(Project.project_name == name))
            .scalars()
            .first()
        )
        if existing:
            existing.source_file = (source_file or "").strip() or None
            rows.append(existing)
            updated += 1
            continue

        row = Project(
            project_name=name,
            sort_order=next_sort_order,
            source_file=(source_file or "").strip() or None,
        )
        db.add(row)
        rows.append(row)
        inserted += 1
        next_sort_order += 1

    db.flush()
    invalidate_projects_cache()
    return rows, inserted, updated


PROJECTS_CACHE_KEY_PREFIX = "projects:manage"


def _projects_cache_key(*, operator: str | None, is_admin: bool, include_inactive: bool = False) -> str:
    op = (operator or "").strip() or "none"
    return _make_cache_key(PROJECTS_CACHE_KEY_PREFIX, f"admin:{is_admin}", f"op:{op}", f"inactive:{include_inactive}")


def _serialize_project_for_cache(row: Project) -> dict:
    return {
        "id": row.id,
        "project_name": row.project_name,
        "brand_name": row.brand_name,
        "store_address": row.store_address,
        "project_operator": row.project_operator,
        "assistant_operator": row.assistant_operator,
        "commission_basis": row.commission_basis,
        "commission_rate": str(row.commission_rate)
        if row.commission_rate is not None
        else None,
        "sort_order": row.sort_order,
        "is_active": row.is_active,
        "source_file": row.source_file,
        "has_context": bool(row.project_context or row.sku_context),
        "project_tier": row.project_tier,
    }


def invalidate_projects_cache() -> int:
    return cache_delete_pattern(f"{_make_cache_key(PROJECTS_CACHE_KEY_PREFIX)}*")


def list_project_items(
    db: Session,
    *,
    operator: str | None = None,
    is_admin: bool = True,
    include_inactive: bool = False,
) -> list[Project]:
    normalized_operator = (operator or "").strip()
    if not is_admin:
        if not normalized_operator:
            return []

    cache_key = _projects_cache_key(operator=normalized_operator, is_admin=is_admin, include_inactive=include_inactive)
    cached = cache_get(cache_key)
    if cached is not None:
        project_ids = [item["id"] for item in cached]
        if project_ids:
            rows = (
                db.execute(select(Project).where(Project.id.in_(project_ids)))
                .scalars()
                .all()
            )
            id_to_row = {row.id: row for row in rows}
            if len(id_to_row) == len(project_ids):
                ordered_rows = [id_to_row[id] for id in project_ids if id in id_to_row]
                if is_admin:
                    total_projects = db.execute(
                        select(func.count(Project.id))
                    ).scalar_one()
                    if len(ordered_rows) == int(total_projects):
                        return ordered_rows
                else:
                    return ordered_rows
            # Cache can become stale across DB resets (e.g. tests). Fallback to DB source.
            cache_delete(cache_key)
        else:
            return []

    stmt = select(Project)
    if not include_inactive:
        stmt = stmt.where(Project.is_active == True)  # noqa: E712
    stmt = stmt.order_by(Project.sort_order.asc(), Project.id.asc())
    rows = db.execute(stmt).scalars().all()

    if is_admin:
        result = rows
    else:
        result = [
            row
            for row in rows
            if _text_contains_name(row.project_operator, normalized_operator)
            or _text_contains_name(row.assistant_operator, normalized_operator)
        ]

    cache_set(cache_key, [_serialize_project_for_cache(r) for r in result])
    return result


def list_accessible_project_ids(
    db: Session,
    *,
    operator: str | None = None,
    is_admin: bool = True,
) -> list[int] | None:
    if is_admin:
        return None
    return [
        int(row.id)
        for row in list_project_items(db, operator=operator, is_admin=is_admin)
    ]


def ensure_project_access(
    db: Session,
    project_id: int,
    *,
    operator: str | None = None,
    is_admin: bool = True,
) -> Project:
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    if is_admin:
        return row

    normalized_operator = (operator or "").strip()
    if not normalized_operator:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
        )

    if _text_contains_name(
        row.project_operator, normalized_operator
    ) or _text_contains_name(row.assistant_operator, normalized_operator):
        return row

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
    )


def ensure_project_creation_allowed(
    operator: str | None,
    *,
    is_admin: bool,
    project_operator: str | None,
    assistant_operator: str | None,
) -> None:
    if is_admin:
        return

    normalized_operator = (operator or "").strip()
    if not normalized_operator:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="无权限创建项目"
        )

    normalized_project_operator = _normalize_multi_name_text(project_operator)
    normalized_assistant_operator = _normalize_multi_name_text(assistant_operator)
    if _text_contains_name(
        normalized_project_operator, normalized_operator
    ) or _text_contains_name(normalized_assistant_operator, normalized_operator):
        return

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="无权限创建项目")


def list_project_options(db: Session) -> list[dict[str, str | int | None]]:
    rows = list_project_items(db)
    if rows:
        return [{"id": row.id, "name": row.project_name} for row in rows]

    # Backward-compatible fallback: if projects table is empty, use sku_records distinct project names.
    fallback_stmt = (
        select(SkuRecord.project_name)
        .distinct()
        .order_by(SkuRecord.project_name.asc())
    )
    try:
        names = [row[0] for row in db.execute(fallback_stmt).all()]
    except SQLAlchemyError:
        return []
    return [{"id": None, "name": name} for name in names]


def list_project_operator_options(db: Session) -> list[str]:
    rows = db.execute(
        text(
            """
            select distinct
              coalesce(nullif(trim(operator_name_zh), ''), nullif(trim(full_name), '')) as operator_name
            from public.user_accounts
            where coalesce(nullif(trim(operator_name_zh), ''), nullif(trim(full_name), '')) is not null
            order by operator_name asc
            """
        )
    ).all()
    return [str(row[0]) for row in rows if row and row[0] is not None]


def create_single_project(
    db: Session,
    name: str,
    brand_name: str | None = None,
    store_address: str | None = None,
    project_operator: str | None = None,
    assistant_operator: str | None = None,
    commission_basis: str | None = None,
    commission_rate: float | Decimal | None = None,
    source_file: str | None = None,
    project_tier: str | None = None,
) -> Project:
    project_name = name.strip()
    if not project_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name is required"
        )

    # 使用 PostgreSQL advisory lock 消除并发创建同名项目的竞争窗口
    # 对项目名取 hash 作为锁 ID，确保同名项目必然获得相同锁
    name_hash = int(hashlib.md5(project_name.encode()).hexdigest()[:16], 16)
    db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": name_hash})

    existing = (
        db.execute(select(Project).where(Project.project_name == project_name))
        .scalars()
        .first()
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="项目已存在")

    normalized_brand_name = _normalize_optional_text(brand_name)
    normalized_store_address = _normalize_optional_text(store_address)
    normalized_project_operator = _normalize_multi_name_text(project_operator)
    normalized_assistant_operator = _normalize_multi_name_text(assistant_operator)
    normalized_commission_basis = _normalize_commission_basis(commission_basis)
    normalized_commission_rate = _normalize_commission_rate(commission_rate)
    normalized_source_file = (source_file or "").strip() or "manual_single_add"
    normalized_project_tier = _normalize_project_tier(project_tier)

    def _build_row() -> Project:
        max_sort_order = db.execute(
            select(func.coalesce(func.max(Project.sort_order), -1))
        ).scalar_one()
        return Project(
            project_name=project_name,
            brand_name=normalized_brand_name,
            store_address=normalized_store_address,
            project_operator=normalized_project_operator,
            assistant_operator=normalized_assistant_operator,
            commission_basis=normalized_commission_basis,
            commission_rate=normalized_commission_rate,
            sort_order=int(max_sort_order) + 1,
            source_file=normalized_source_file,
            project_tier=normalized_project_tier,
        )

    row = _build_row()
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        if _is_projects_primary_key_conflict(exc):
            db.rollback()

            duplicate = (
                db.execute(select(Project).where(Project.project_name == project_name))
                .scalars()
                .first()
            )
            if duplicate:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT, detail="项目已存在"
                ) from exc

            _sync_projects_id_sequence(db)
            row = _build_row()
            db.add(row)
            db.flush()
        else:
            raise

    db.refresh(row)
    invalidate_projects_cache()
    return row


def update_project(
    db: Session,
    project_id: int,
    name: str,
    brand_name: str | None = None,
    store_address: str | None = None,
    project_operator: str | None = None,
    assistant_operator: str | None = None,
    commission_basis: str | None = None,
    commission_rate: float | Decimal | None = None,
    is_active: bool | None = True,
    project_tier: str | None = None,
) -> Project:
    project_name = name.strip()
    if not project_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name is required"
        )

    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    duplicate = (
        db.execute(
            select(Project).where(
                Project.project_name == project_name, Project.id != project_id
            )
        )
        .scalars()
        .first()
    )
    if duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="项目名称已存在"
        )

    row.project_name = project_name
    row.brand_name = _normalize_optional_text(brand_name)
    row.store_address = _normalize_optional_text(store_address)
    row.project_operator = _normalize_multi_name_text(project_operator)
    row.assistant_operator = _normalize_multi_name_text(assistant_operator)
    row.commission_basis = _normalize_commission_basis(commission_basis)
    row.commission_rate = _normalize_commission_rate(commission_rate)
    row.is_active = is_active if is_active is not None else True
    row.project_tier = _normalize_project_tier(project_tier)
    db.flush()
    db.refresh(row)
    invalidate_projects_cache()
    return row


def reorder_project(db: Session, project_id: int, direction: str) -> Project:
    """Move a project up or down in sort order.

    Args:
        db: Database session
        project_id: ID of the project to move
        direction: 'up' or 'down'

    Returns:
        The moved project row
    """
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    current_order = row.sort_order

    if direction == 'up':
        # Find the project with the next lower sort_order
        neighbor = (
            db.execute(
                select(Project)
                .where(Project.sort_order < current_order)
                .order_by(Project.sort_order.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        if not neighbor:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="已在最顶部")
    elif direction == 'down':
        # Find the project with the next higher sort_order
        neighbor = (
            db.execute(
                select(Project)
                .where(Project.sort_order > current_order)
                .order_by(Project.sort_order.asc())
                .limit(1)
            )
            .scalars()
            .first()
        )
        if not neighbor:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="已在最底部")
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="direction must be 'up' or 'down'")

    # Swap sort_order values
    row.sort_order, neighbor.sort_order = neighbor.sort_order, row.sort_order
    db.flush()
    db.refresh(row)
    invalidate_projects_cache()
    return row


def get_project_context(db: Session, project_id: int) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Get the project context and SKU context for a project.

    Args:
        db: Database session
        project_id: The project ID

    Returns:
        A tuple of (project_context, sku_context). Both can be None if not set.

    Raises:
        HTTPException: If the project does not exist
    """
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row.project_context, row.sku_context


def _deep_merge(base: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge update into base, with update values taking precedence.

    Nested dictionaries are merged recursively. All other values are replaced.
    """
    result = dict(base)
    for key, value in update.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def update_project_context(
    db: Session,
    project_id: int,
    project_context: dict[str, Any] | None = None,
    sku_context: dict[str, Any] | None = None,
    operator: str | None = None,
) -> Project:
    """Update project context using JSON Merge Patch semantics.

    Nested objects are deep-merged: only the keys present in the update
    will be replaced; other keys within the same nested object are preserved.

    Args:
        db: Database session
        project_id: The project ID
        project_context: Partial project context to merge (deep merge at nested level)
        sku_context: Partial SKU context to merge (shallow merge for SKU-level overrides)
        operator: Optional operator name for logging

    Returns:
        The updated Project row

    Raises:
        HTTPException: If the project does not exist
    """
    row = db.execute(select(Project).where(Project.id == project_id)).scalars().first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    if project_context is not None:
        existing = row.project_context or {}
        row.project_context = _deep_merge(existing, project_context)

    if sku_context is not None:
        existing = row.sku_context or {}
        existing.update(sku_context)
        row.sku_context = existing

    db.flush()
    db.refresh(row)
    invalidate_projects_cache()
    return row
