"""Endpoints — placements (aggregate + raw) for a project.

* ``GET /external/projects/{project_id}/ad-placements``          — aggregated by business key
* ``GET /external/projects/{project_id}/ad-placements-raw``      — deep-diagnostic raw rows
"""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._aggregation import get_table_config
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.api.v1.endpoints.external._whitelist import parse_order_by
from app.models import AdUploadPlacementRow
from app.schemas.external.ad_raw import AdPlacementRawRow
from app.schemas.external.aggregate import RawResponse, RawSummary
from app.services.external import ad_rows_query, projects_query


router = APIRouter()

_CONFIG = get_table_config("ad-placements")


# ---------------------------------------------------------------------------
# Aggregate endpoint
# ---------------------------------------------------------------------------


@router.get(
    '/projects/{project_id}/ad-placements',
    response_model=_CONFIG["response_schema"],
)
def get_external_ad_placement_aggregate(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    db: Session = Depends(get_read_db_session),
):
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

    rows = _CONFIG["aggregate"](
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=period_info.start_date,
        date_to=period_info.end_date,
    )

    return _CONFIG["response_schema"](
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[_CONFIG["row_schema"].model_validate(r) for r in rows],
        summary=_CONFIG["summary"](rows),
    )


# ---------------------------------------------------------------------------
# Raw endpoint
# ---------------------------------------------------------------------------


@router.get(
    '/projects/{project_id}/ad-placements-raw',
    response_model=RawResponse[AdPlacementRawRow],
)
def get_external_ad_placement_raw(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default='report_end_date'),
    order_dir: str = Query(default='desc', pattern='^(asc|desc)$'),
    db: Session = Depends(get_read_db_session),
) -> RawResponse[AdPlacementRawRow]:
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

    try:
        order_column, direction = parse_order_by(
            order_by, order_dir, model=AdUploadPlacementRow,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        rows = ad_rows_query.query_placement_raw(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            order_column=order_column,
            order_dir=direction,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return RawResponse[AdPlacementRawRow](
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[AdPlacementRawRow.model_validate(r) for r in rows],
        summary=RawSummary(
            total_rows=len(rows),
            date_range=[
                period_info.start_date.isoformat(),
                period_info.end_date.isoformat(),
            ],
        ),
    )


# ---------------------------------------------------------------------------
# Alias route — singular-noun path (``ad-placement-raw``).
# Mirrors the plural ``ad-placements-raw`` route above.
# ---------------------------------------------------------------------------


@router.get(
    '/projects/{project_id}/ad-placement-raw',
    response_model=RawResponse[AdPlacementRawRow],
)
def get_external_ad_placement_raw_alias(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default='report_end_date'),
    order_dir: str = Query(default='desc', pattern='^(asc|desc)$'),
    db: Session = Depends(get_read_db_session),
) -> RawResponse[AdPlacementRawRow]:
    return get_external_ad_placement_raw(
        project_id=project_id, period=period, start_date=start_date,
        end_date=end_date, country=country, limit=limit, offset=offset,
        order_by=order_by, order_dir=order_dir, db=db,
    )
