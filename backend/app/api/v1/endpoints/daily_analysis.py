from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.daily_analysis import (
    DailyAnalysisAllProjectsResponse,
    DailyAnalysisResponse,
)
from app.services import daily_analysis_service, project_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/daily-analysis", response_model=DailyAnalysisResponse)
def get_daily_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return daily_analysis_service.build_daily_analysis(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )


@router.get("/daily-analysis/all", response_model=DailyAnalysisAllProjectsResponse)
def get_daily_analysis_all(
    project_ids: Annotated[str, Query(description="comma-separated project IDs")],
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    try:
        ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_ids must be comma-separated integers",
        )
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one project_id is required",
        )

    normalized_operator = (operator or "").strip()
    for pid in ids:
        project_service.ensure_project_access(
            db,
            pid,
            operator=normalized_operator,
            is_admin=bool(is_admin),
        )

    return daily_analysis_service.build_daily_analysis_all_projects(
        db,
        project_ids=ids,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )
