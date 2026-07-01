"""Endpoint #1 — list projects for the external API.

``GET /external/projects?status=active``
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.schemas.external.common import PeriodParseError
from app.schemas.external.projects import ProjectItem
from app.services.external import projects_query


router = APIRouter()


@router.get('/projects', response_model=list[ProjectItem])
def get_external_projects(
    status: str = Query(default='active'),
    db: Session = Depends(get_read_db_session),
) -> list[ProjectItem]:
    try:
        projects = projects_query.list_projects(db, status=status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return [
        ProjectItem(
            project_id=p.id,
            project_name=p.project_name,
        )
        for p in projects
    ]