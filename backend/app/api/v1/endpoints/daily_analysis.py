from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.daily_analysis import DailyAnalysisResponse
from app.services import daily_analysis_service, project_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/daily-analysis', response_model=DailyAnalysisResponse)
def get_daily_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = 'US',
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
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
    )
