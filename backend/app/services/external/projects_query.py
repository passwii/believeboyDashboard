"""Project query helpers for the external API.

Thin wrappers around ``app.models.Project`` so the external endpoints can:
  * list projects (filterable by archive status),
  * check existence (404 handling in endpoints).

P0 has no auth/permission checks — those land in P1. For now, the helpers
return data for any caller.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project


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


def project_exists(db: Session, project_id: int) -> bool:
    """Return True iff a project with ``project_id`` exists.

    Used by external endpoints to translate a missing project into HTTP 404
    (vs. an empty result list when the project exists but has no matching
    rows in the requested window).
    """
    project = db.get(Project, project_id)
    return project is not None