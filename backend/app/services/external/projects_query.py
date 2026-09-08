"""Project query helpers for the shared read-query layer.

Thin wrappers around ``app.models.Project`` so the shared layer can:
  * list projects (filterable by archive status),
  * check existence (404 handling in endpoints).

原 external 命名空间的共享查询服务（external 机制已退役删除，BLF-583），
供 agent 原生域与 internal 端点复用。
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project, ProjectShop


def list_projects(db: Session, *, status: str = 'active') -> list[Project]:
    """Return projects filtered by archive status.

    ``status`` accepts:
      * ``'active'``   — only non-archived projects (default).
      * ``'archived'`` — only archived projects.
      * ``'all'``      — every project.

    Unknown values raise ``ValueError`` (caller → 400).
    """
    if status not in {'active', 'archived', 'all'}:
        raise ValueError(
            f"status must be one of ['active', 'archived', 'all'], got {status!r}"
        )

    stmt = select(Project).order_by(Project.project_name.asc())
    if status == 'active':
        stmt = stmt.where(Project.is_active.is_(True))
    elif status == 'archived':
        stmt = stmt.where(Project.is_active.is_(False))
    # status == 'all' → no extra filter

    return list(db.execute(stmt).scalars().all())


def list_project_shops(
    db: Session, project_ids: list[int]
) -> dict[int, list[ProjectShop]]:
    """Return persisted shop mappings grouped by project ID.

    The empty-input fast path avoids issuing a broad query when the caller's
    project list is empty. Rows are ordered for deterministic API output.
    """
    if not project_ids:
        return {}

    stmt = (
        select(ProjectShop)
        .where(ProjectShop.project_id.in_(project_ids))
        .order_by(ProjectShop.project_id.asc(), ProjectShop.country.asc())
    )
    grouped: dict[int, list[ProjectShop]] = {}
    for shop in db.execute(stmt).scalars().all():
        grouped.setdefault(shop.project_id, []).append(shop)
    return grouped


def project_exists(db: Session, project_id: int) -> bool:
    """Return True iff a project with ``project_id`` exists.

    Used by shared endpoints to translate a missing project into HTTP 404
    (vs. an empty result list when the project exists but has no matching
    rows in the requested window).
    """
    project = db.get(Project, project_id)
    return project is not None