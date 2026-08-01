"""External Return Analysis endpoints — BEL-374.

Two GET routes mounted under ``/external/projects/{project_id}``:

* ``/return-analysis``      — per-SKU rollup, served from the
  ``analysis_return_aggregates`` snapshot (Wilson 95% lower-bound
  risk_level already precomputed by Celery). See
  ``backend/docs/external-api.md §7`` for the full contract.
* ``/return-analysis-raw``  — raw ``analysis_return_rows`` events
  with sensitive fields (customer_comments / raw_row) stripped by
  the Pydantic schema.

P0 contract (no auth, no rate limiting). Network isolation is enforced
at the gateway layer per
``docs/deployment/external-api-network-isolation.md``.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.api.v1.endpoints.external._whitelist import (
    parse_aggregate_order_by,
    parse_order_by,
)
from app.models import AnalysisReturnAggregate, AnalysisReturnRow
from app.schemas.external.return_analysis import (
    ReturnAnalysisAggregateResponse,
    ReturnAnalysisAggregateRow,
    ReturnAnalysisAggregateSummary,
    ReturnAnalysisRawResponse,
    ReturnAnalysisRawRow,
)
from app.services.external import projects_query
from app.services.external.return_analysis_query import (
    build_aggregate_summary,
    query_return_analysis_aggregate,
    query_return_analysis_raw,
)


router = APIRouter()


# Risk level whitelist — used to validate the ``?risk_level=`` query
# param so an unknown value returns 400 (defense-in-depth alongside
# the snapshot table's enum-like column).
_VALID_RISK_LEVELS = frozenset({"critical", "warning", "normal", "no_data"})


# ---------------------------------------------------------------------------
# Aggregate endpoint
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/return-analysis",
    response_model=ReturnAnalysisAggregateResponse,
    summary="Return Analysis aggregate (per-SKU rollup from snapshot)",
    description=(
        "Per-SKU rollup of return metrics within the requested window.\n"
        "Reads from the ``analysis_return_aggregates`` snapshot, so the\n"
        "``risk_level`` and ``wilson_lower`` values reflect the Celery\n"
        "nightly pre-aggregation (not live computation).\n\n"
        "Each row carries 12 fields:\n"
        "  - **Counts**: return_count, return_quantity, sales_quantity\n"
        "  - **Rates**: return_rate (%), wilson_lower (%)\n"
        "  - **Cycle**: cycle_avg_days / cycle_min_days / cycle_max_days\n"
        "  - **Top reasons**: reason_top1, disposition_top1, dominant_fc_id\n"
        "  - **Risk**: risk_level (critical / warning / normal / no_data)\n\n"
        "Use ``?risk_level=critical`` to surface at-risk SKUs only.\n"
        "Use ``?min_return_rate=5.0`` to set a rate threshold.\n"
        "Use ``?sku=SKU-001`` for substring match.\n"
    ),
)
def get_external_return_analysis_aggregate(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    sku: str | None = Query(
        default=None,
        description="Optional SKU substring filter (case-insensitive)",
    ),
    min_return_rate: float | None = Query(
        default=None,
        ge=0.0,
        le=100.0,
        description="Filter: return_rate >= value (percent)",
    ),
    risk_level: str | None = Query(
        default=None,
        description="Filter: critical / warning / normal / no_data",
    ),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="return_quantity"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> ReturnAnalysisAggregateResponse:
    today_minus_one = date.today() - timedelta(days=1)
    try:
        normalized_country = parse_country(country)
        period_info = parse_period_v2(
            period,
            start_date,
            end_date,
            today=today_minus_one,
        )
        # AGG_SORT_KEYS is keyed by AnalysisReturnAggregate (the table
        # that backs the per-SKU rollup). parse_aggregate_order_by
        # validates against that whitelist.
        sort_key, direction = parse_aggregate_order_by(
            order_by,
            order_dir,
            model=AnalysisReturnAggregate,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if risk_level and risk_level not in _VALID_RISK_LEVELS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"risk_level must be one of {sorted(_VALID_RISK_LEVELS)}, "
                f"got {risk_level!r}"
            ),
        )

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    rows, total = query_return_analysis_aggregate(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=period_info.start_date,
        date_to=period_info.end_date,
        order_column=sort_key,
        order_dir=direction,
        limit=limit,
        offset=offset,
        sku_substring=sku,
        min_return_rate=min_return_rate,
        risk_level=risk_level,
    )

    summary = build_aggregate_summary(rows)

    return ReturnAnalysisAggregateResponse(
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[ReturnAnalysisAggregateRow.model_validate(r) for r in rows],
        summary=ReturnAnalysisAggregateSummary(**summary),
    )


# ---------------------------------------------------------------------------
# Raw endpoint
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/return-analysis-raw",
    response_model=ReturnAnalysisRawResponse,
    summary="Return Analysis raw events (Pydantic-stripped of sensitive fields)",
    description=(
        "Raw ``analysis_return_rows`` events within the requested window.\n"
        "Sensitive fields are **never** returned:\n"
        "  - ``customer_comments`` — PII / free-form complaint text\n"
        "  - ``raw_row``           — debug-only JSON blob\n"
        "  - ``fnsku``             — internal Amazon LPN\n"
        "  - ``license_plate_number`` — internal LPN\n\n"
        "Use ``?order_by=`` to sort by any of the 12 whitelisted columns.\n"
    ),
)
def get_external_return_analysis_raw(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="return_date"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> ReturnAnalysisRawResponse:
    today_minus_one = date.today() - timedelta(days=1)
    try:
        normalized_country = parse_country(country)
        period_info = parse_period_v2(
            period,
            start_date,
            end_date,
            today=today_minus_one,
        )
        order_column, direction = parse_order_by(
            order_by,
            order_dir,
            model=AnalysisReturnRow,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    rows, min_d, max_d = query_return_analysis_raw(
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

    return ReturnAnalysisRawResponse(
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[ReturnAnalysisRawRow.model_validate(r) for r in rows],
        summary={
            "total_rows": len(rows),
            "date_range": [min_d.isoformat(), max_d.isoformat()],
        },
    )
