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
        db.execute(
            select(Project.id).where(Project.project_name == project_name.strip())
        )
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


def invalidate_sku_financial_cache(project_id: int) -> None:
    """失效指定项目 PT4 财务汇总月度序列缓存（BLF-579 S2 D7）。

    fob_unit_cost / first_leg_cost_rmb 喂 PT4 财务汇总（``report/pt4.py``），
    is_active 参与补货/报表过滤——Agent W1/W2/W3 写后必须与内部端点同样失效。
    下沉到服务层供 agent 路由复用（spec §2.4/§3 D7）。
    """
    from app.services.infra import invalidate_financial_series_cache

    invalidate_financial_series_cache(project_id)


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
    include_inactive: bool = False,
) -> dict[str, list[str]]:
    """Match a set of SKU/ASIN identifiers to project names.

    Args:
        db: Database session.
        identifiers: SKU or ASIN values to look up.
        match_by: ``"sku"`` or ``"asin"``.
        country: Country filter (defaults to ``"US"``).
        include_inactive: When ``True`` (default for A-table report matching),
            inactive SKU/ASIN records and inactive projects are still considered.
            When ``False`` (default for B-table ad report matching), only active
            SKU/ASIN records under active projects are returned.

            Background: A-table reports (business/payment/sales/inventory/return)
            may legitimately include SKU/ASIN that have been delisted but still
            belong to a project. AutoReportUpload's ``_build_project_match_legacy``
            and the HTTP entry ``data.upload.project_match._build_project_match``
            both pass ``include_inactive=True`` to keep project matching
            consistent across both code paths.
    """
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

    from sqlalchemy import func

    stmt = (
        select(Project.project_name, column)
        .join(SkuRecord, SkuRecord.project_id == Project.id)
        .where(func.upper(column).in_(normalized_values))
        .where(SkuRecord.country == normalized_country)
    )
    if not include_inactive:
        stmt = stmt.where(SkuRecord.is_active.is_(True))
        stmt = stmt.where(
            Project.project_name.in_(
                select(Project.project_name).where(Project.is_active.is_(True))
            )
        )

    matched: dict[str, set[str]] = {value: set() for value in normalized_values}
    for project_name, identifier in db.execute(stmt).all():
        key = (identifier or "").strip().upper()
        if key:
            matched.setdefault(key, set()).add(str(project_name))

    return {key: sorted(values) for key, values in matched.items()}
