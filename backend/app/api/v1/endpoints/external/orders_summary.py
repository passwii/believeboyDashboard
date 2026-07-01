"""Orders Summary endpoint for the external API.

GET /api/v1/external/projects/{project_id}/orders/summary
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.schemas.external.orders_summary import OrdersSummaryResponse
from app.services.external import orders_summary, projects_query

router = APIRouter()


@router.get(
    '/projects/{project_id}/orders/summary',
    response_model=OrdersSummaryResponse,
)
def get_external_orders_summary(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    include_cancelled: bool = Query(default=False),
    include_pending: bool = Query(default=True),
    aggregate: bool = Query(default=True),
    limit: int = Query(default=50000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> OrdersSummaryResponse:
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

    rows, agg = orders_summary.query_orders_summary(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=period_info.start_date,
        date_to=period_info.end_date,
        include_cancelled=include_cancelled,
        include_pending=include_pending,
        aggregate=aggregate,
        limit=limit,
        offset=offset,
    )

    return OrdersSummaryResponse(
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=rows,
        aggregate=agg if aggregate else None,
        summary=agg,
    )