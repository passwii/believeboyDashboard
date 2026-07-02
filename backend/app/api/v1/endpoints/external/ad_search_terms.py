"""Endpoints — search terms (aggregate + raw) for a project.

* ``GET /external/projects/{project_id}/ad-search-terms``          — aggregated by business key
* ``GET /external/projects/{project_id}/ad-search-terms-raw``      — deep-diagnostic raw rows
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
from app.models import AdUploadSearchTermRow
from app.schemas.external.ad_raw import AdSearchTermRawRow
from app.schemas.external.aggregate import RawResponse, RawSummary
from app.services.external import ad_rows_query, ad_targeting, projects_query


router = APIRouter()

_CONFIG = get_table_config("ad-search-terms")


# ---------------------------------------------------------------------------
# Aggregate endpoint
# ---------------------------------------------------------------------------


@router.get(
    '/projects/{project_id}/ad-search-terms',
    response_model=_CONFIG["response_schema"],
)
def get_external_ad_search_term_aggregate(
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
    '/projects/{project_id}/ad-search-terms-raw',
    response_model=RawResponse[AdSearchTermRawRow],
)
def get_external_ad_search_term_raw(
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
) -> RawResponse[AdSearchTermRawRow]:
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
            order_by, order_dir, model=AdUploadSearchTermRow,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        rows = ad_rows_query.query_search_term_raw(
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

    # Enrich each ORM row with ``targeting_type`` computed from
    # (window-scoped campaign targeting_type) + raw_row JSON.  Spec §3.
    #
    # ``AdUploadSearchTermRow`` has no ``targeting_type`` column — this
    # handler writes the value as a transient Python attribute so
    # ``AdSearchTermRawRow.model_validate(r)`` picks it up via
    # ``from_attributes=True``.  Do not bypass this enrichment when
    # reading ``AdUploadSearchTermRow`` directly (you'll lose the field).
    campaign_targeting_map = ad_targeting.build_campaign_targeting_cache(
        db, project_id=project_id, country=normalized_country,
        date_from=period_info.start_date, date_to=period_info.end_date,
    )
    for r in rows:
        r.targeting_type = ad_targeting.resolve_targeting_type(  # type: ignore[attr-defined]
            campaign_name=r.campaign_name,
            country=normalized_country,
            raw_row=r.raw_row or {},
            campaign_targeting_map=campaign_targeting_map,
        )

    return RawResponse[AdSearchTermRawRow](
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[AdSearchTermRawRow.model_validate(r) for r in rows],
        summary=RawSummary(
            total_rows=len(rows),
            date_range=[
                period_info.start_date.isoformat(),
                period_info.end_date.isoformat(),
            ],
        ),
    )


# ---------------------------------------------------------------------------
# Alias route — singular-noun path (``ad-search-term-raw``).
# Mirrors the plural ``ad-search-terms-raw`` route above. Kept so BI tools following
# the spec-mandated singular form don't 404.
# ---------------------------------------------------------------------------


@router.get(
    '/projects/{project_id}/ad-search-term-raw',
    response_model=RawResponse[AdSearchTermRawRow],
)
def get_external_ad_search_term_raw_alias(
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
) -> RawResponse[AdSearchTermRawRow]:
    return get_external_ad_search_term_raw(
        project_id=project_id, period=period, start_date=start_date,
        end_date=end_date, country=country, limit=limit, offset=offset,
        order_by=order_by, order_dir=order_dir, db=db,
    )
