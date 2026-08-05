"""External API — inventory ledger endpoints.

No auth (network isolation at gateway). project_id in path.

Period input contract (BEL-370 P1 #4):
  Every call MUST supply ``?period=<value>``. See
  ``backend/docs/inventory-ledger-api.md`` for the full grammar.
"""

from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.inventory_ledger_common import (
    resolve_period_inputs,
)
from app.schemas.inventory_ledger import (
    ConsistencyCheckResult,
    EventsResponse,
    IngestBatchesResponse,
    IntegrityCheckResult,
    LedgerDetailResponse,
    MonthlySnapshotResponse,
    MonthsResponse,
    ReceiptClustersResponse,
    TrendResponse,
)
from app.services.inventory.ledger import (
    check_ledger_consistency,
    check_ledger_integrity,
    get_available_months,
    get_ledger_detail_rows,
    get_month_disposition_summary,
    get_receipt_clusters,
    get_sku_month_eom,
    get_sku_month_events,
    get_trend,
    list_ingest_batches,
)

router = APIRouter(
    prefix="/projects/{project_id}/inventory-ledger", tags=["external-inventory-ledger"]
)


def _prev_period(report_month: date) -> tuple[date, date]:
    if report_month.month == 1:
        prev = date(report_month.year - 1, 12, 1)
    else:
        prev = date(report_month.year, report_month.month - 1, 1)
    last_day = calendar.monthrange(prev.year, prev.month)[1]
    return prev, date(prev.year, prev.month, last_day)


@router.get(
    "/months",
    response_model=MonthsResponse,
    summary="List months with ledger data",
    description=(
        "Returns YYYY-MM-DD strings (always the 1st of the month) for every "
        "month that has any rows in the project's inventory_ledger_raw table."
    ),
)
def ext_list_months(
    project_id: int,
    db: Session = Depends(get_read_db_session),
) -> MonthsResponse:
    months = get_available_months(db, project_id)
    return MonthsResponse(project_id=project_id, months=months)


@router.get(
    "/snapshot",
    response_model=MonthlySnapshotResponse,
    summary="Monthly snapshot — SKU EOM, disposition summary, integrity",
    description=(
        "Returns the end-of-period inventory snapshot for a project. Runs "
        "the cross-month integrity check when the resolved period is a full "
        "calendar month; partial windows skip it.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def ext_snapshot(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Period selector — see ``backend/docs/inventory-ledger-api.md``."
        ),
    ),
    start_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    end_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    db: Session = Depends(get_read_db_session),
) -> MonthlySnapshotResponse:
    start, end, report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    prev_start: date | None = None
    prev_end: date | None = None
    if report_month:
        prev_start, prev_end = _prev_period(report_month)

    skus = get_sku_month_eom(db, project_id, start, end, prev_start, prev_end)
    disposition_summary = get_month_disposition_summary(db, project_id, start, end)

    integrity = None
    if report_month:
        integrity = check_ledger_integrity(db, project_id, report_month)

    total_qty = sum(s.qty_eom for s in skus)
    return MonthlySnapshotResponse(
        report_month=start,
        sku_count=len(skus),
        total_qty=total_qty,
        disposition_summary=disposition_summary,
        skus=skus,
        integrity=integrity,
    )


@router.get(
    "/events",
    response_model=EventsResponse,
    summary="SKU event flow for the period",
    description=(
        "Returns per-SKU totals of every ledger event column summed across "
        "the resolved period window.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def ext_events(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Period selector — see ``backend/docs/inventory-ledger-api.md``."
        ),
    ),
    start_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    end_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    db: Session = Depends(get_read_db_session),
) -> EventsResponse:
    start, end, _report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    skus = get_sku_month_events(db, project_id, start, end)
    return EventsResponse(report_month=start, skus=skus)


@router.get(
    "/receipt-clusters",
    response_model=ReceiptClustersResponse,
    summary="Receipt clusters for the period",
    description=(
        "Groups inventory receipts by (date, warehouse) — useful for "
        "spotting shipments that arrived together.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def ext_receipt_clusters(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Period selector — see ``backend/docs/inventory-ledger-api.md``."
        ),
    ),
    start_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    end_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    db: Session = Depends(get_read_db_session),
) -> ReceiptClustersResponse:
    start, end, _report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    clusters = get_receipt_clusters(db, project_id, start, end)
    return ReceiptClustersResponse(report_month=start, clusters=clusters)


@router.get(
    "/integrity",
    response_model=IntegrityCheckResult,
    summary="Cross-month integrity check",
    description=(
        "Returns the cross-month continuity check (last month's ending "
        "balance vs. this month's starting balance, per SKU × location × "
        "disposition). Status is one of ``OK``, ``MISMATCH``, or "
        "``PENDING`` (no prior month data available).\n\n"
        "Only full-calendar-month period values make sense here "
        "(``last_month``, ``this_month``, ``ytd`` cross-year, "
        "``YYYY-MM``, ``YYYY-MM-DD``). Partial windows (7d/30d/custom "
        "spanning multiple months) return 400 — use ``last_month`` for "
        "the typical 'reconcile last full month' flow."
    ),
)
def ext_integrity(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Must resolve to a full calendar month (last_month, "
            "this_month, ytd, YYYY-MM, YYYY-MM-DD). See "
            "``backend/docs/inventory-ledger-api.md``."
        ),
    ),
    db: Session = Depends(get_read_db_session),
) -> IntegrityCheckResult:
    """Cross-month integrity check for a full calendar month."""
    start, end, report_month_date = resolve_period_inputs(
        period,
        None,
        None,
    )
    if report_month_date is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"period={period!r} does not resolve to a full calendar "
                "month; integrity check requires a complete ledger "
                "partition (use last_month, this_month, ytd, YYYY-MM, or "
                "YYYY-MM-DD)"
            ),
        )
    return check_ledger_integrity(db, project_id, report_month_date)


@router.get(
    "/trend",
    response_model=TrendResponse,
    summary="Multi-month trend",
    description=(
        "Aggregates the last N months (default 6, max 24) into a single "
        "trend series. Independent of the ``?period=`` convention "
        "(driven by ``?months=N``)."
    ),
)
def ext_trend(
    project_id: int,
    months: int = Query(6, ge=1, le=24, description="Number of recent months"),
    db: Session = Depends(get_read_db_session),
) -> TrendResponse:
    """Multi-month aggregated trend."""
    items = get_trend(db, project_id, months=months)
    return TrendResponse(project_id=project_id, months=items)


@router.get(
    "/detail",
    response_model=LedgerDetailResponse,
    summary="Event-level detail rows (Detailed view)",
    description=(
        "Returns event-level rows from the Amazon Detailed view for the "
        "resolved period. Optional filters: ``msku``, ``fulfillment_center``, "
        "``event_type``.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def ext_detail(
    project_id: int,
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Period selector — see ``backend/docs/inventory-ledger-api.md``."
        ),
    ),
    start_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    end_date: date | None = Query(
        default=None,
        description="Companion for ``period=custom`` only.",
    ),
    msku: str | None = Query(default=None, description="Optional SKU filter"),
    fulfillment_center: str | None = Query(
        default=None, description="Optional FBA warehouse code filter"
    ),
    event_type: str | None = Query(
        default=None, description="Optional event type filter"
    ),
    db: Session = Depends(get_read_db_session),
) -> LedgerDetailResponse:
    start, end, _report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )
    rows = get_ledger_detail_rows(
        db,
        project_id,
        start,
        end,
        msku=msku,
        fulfillment_center=fulfillment_center,
        event_type=event_type,
    )
    return LedgerDetailResponse(report_month=start, rows=rows)


@router.get(
    "/batches",
    response_model=IngestBatchesResponse,
    summary="List CSV ingest batches (traceability)",
    description=(
        "Returns the upload history for this project — one row per CSV ingest "
        "run with file identity (filename + sha256), row counts, status and "
        "the cross-table consistency result."
    ),
)
def ext_batches(
    project_id: int,
    limit: int = Query(100, ge=1, le=500, description="Max batches to return"),
    db: Session = Depends(get_read_db_session),
) -> IngestBatchesResponse:
    batches = list_ingest_batches(db, project_id, limit=limit)
    return IngestBatchesResponse(project_id=project_id, batches=batches)


@router.get(
    "/consistency",
    response_model=ConsistencyCheckResult,
    summary="Cross-table consistency check (detail vs summary)",
    description=(
        "Reconciles the Detailed view against the Summary truth table for a "
        "full calendar month. Status is ``OK``, ``MISMATCH``, or ``PENDING``.\n\n"
        "Only full-calendar-month period values make sense here."
    ),
)
def ext_consistency(
    project_id: int,
    period: str = Query(
        ...,
        description=("REQUIRED. Must resolve to a full calendar month."),
    ),
    db: Session = Depends(get_read_db_session),
) -> ConsistencyCheckResult:
    _start, _end, report_month = resolve_period_inputs(period, None, None)
    if report_month is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"period={period!r} does not resolve to a full calendar month; "
                "consistency check requires a complete ledger partition"
            ),
        )
    return check_ledger_consistency(db, project_id, report_month)
