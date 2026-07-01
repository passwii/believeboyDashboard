"""Business Summary endpoint for the external API.

GET /api/v1/external/projects/{project_id}/business-summary
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.schemas.external.business_summary import BusinessSummaryResponse
from app.services.external import business_summary, projects_query

router = APIRouter()


@router.get(
    '/projects/{project_id}/business-summary',
    response_model=BusinessSummaryResponse,
)
def get_external_business_summary(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    db: Session = Depends(get_read_db_session),
) -> BusinessSummaryResponse:
    today_minus_one = date.today() - timedelta(days=1)
    try:
        normalized_country = parse_country(country)
        period_info = parse_period_v2(
            period, start_date, end_date, today=today_minus_one,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f'project {project_id} not found')

    detail_rows = business_summary.aggregate_business_summary(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=period_info.start_date,
        date_to=period_info.end_date,
    )

    agg = business_summary.build_business_summary(detail_rows)

    return BusinessSummaryResponse(
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        detail=detail_rows,
        aggregate=agg,
        summary=agg,
    )