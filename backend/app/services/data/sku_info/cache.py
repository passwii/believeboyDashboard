from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project
from app.utils.country import normalize_country

_project_id_cache: dict[str, int] = {}


def _resolve_project_id(db: Session, project_name: str) -> int:
    if project_name in _project_id_cache:
        return _project_id_cache[project_name]
    row = (
        db.execute(select(Project.id).where(Project.project_name == project_name.strip()))
        .scalars()
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"项目不存在: {project_name}",
        )
    _project_id_cache[project_name] = row
    return row


def _clear_project_id_cache() -> None:
    _project_id_cache.clear()


def list_projects(db: Session) -> list[dict[str, str]]:
    rows = (
        db.execute(
            select(Project.project_name)
            .where(Project.is_active.is_(True))
            .order_by(Project.sort_order.asc(), Project.project_name.asc())
        )
        .scalars()
        .all()
    )
    return [{"name": name} for name in rows]


def match_projects_by_identifiers(
    db: Session,
    *,
    identifiers: list[str],
    match_by: str,
    country: str = "US",
) -> dict[str, list[str]]:
    from app.models.sku_info import SkuRecord

    normalized_values = sorted(
        {value.strip().upper() for value in identifiers if (value or "").strip()}
    )
    if not normalized_values:
        return {}

    normalized_country = normalize_country(country)
    if match_by == "sku":
        column = SkuRecord.sku
    elif match_by == "asin":
        column = SkuRecord.asin
    else:
        raise ValueError(f"Unsupported match_by: {match_by}")

    stmt = (
        select(Project.project_name, column)
        .join(SkuRecord, SkuRecord.project_id == Project.id)
        .where(Project.project_name.in_(
            select(Project.project_name).where(Project.is_active.is_(True))
        ))
        .where(SkuRecord.country == normalized_country)
        .where(SkuRecord.is_active.is_(True))
    )
    from sqlalchemy import func

    stmt = (
        select(Project.project_name, column)
        .join(SkuRecord, SkuRecord.project_id == Project.id)
        .where(func.upper(column).in_(normalized_values))
        .where(SkuRecord.country == normalized_country)
        .where(SkuRecord.is_active.is_(True))
    )

    matched: dict[str, set[str]] = {value: set() for value in normalized_values}
    for project_name, identifier in db.execute(stmt).all():
        key = (identifier or "").strip().upper()
        if key:
            matched.setdefault(key, set()).add(str(project_name))

    return {key: sorted(values) for key, values in matched.items()}
