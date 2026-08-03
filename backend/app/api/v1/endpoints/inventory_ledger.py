"""Inventory Ledger internal API — /api/v1/inventory-ledger/*.

Requires authentication (Depends(protected)).

Period input contract (BEL-370 P1 #4):
  Every call MUST supply ``?period=<value>``. There is exactly one input
  convention — agents should not see ``?report_month=`` or standalone
  ``?start_date=&end_date=`` and conclude they have multiple options.

  See ``backend/docs/inventory-ledger-api.md`` for the full calling
  convention (period values, examples, integrity-check behaviour).
"""

from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.api.v1.endpoints.inventory_ledger_common import (
    resolve_period_inputs,
)
from app.schemas.inventory_ledger import (
    EventsResponse,
    LocationDetailResponse,
    MonthlySnapshotResponse,
    MonthsResponse,
    ReceiptClustersResponse,
    TrendResponse,
)
from app.services.inventory.ledger import (
    check_ledger_integrity,
    get_available_months,
    get_month_disposition_summary,
    get_receipt_clusters,
    get_sku_location_eom,
    get_sku_month_eom,
    get_sku_month_events,
    get_trend,
)

router = APIRouter(dependencies=[Depends(protected)])


def _prev_period(report_month: date) -> tuple[date, date]:
    """Compute previous month's (start, end) for MoM comparison."""
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
        "month that has any rows in the project's inventory_ledger_raw table. "
        "Use these values directly as the ``period`` query parameter for the "
        "other endpoints — e.g. ``period=2026-01-01`` means 'January 2026'."
    ),
)
def list_months(
    project_id: int = Query(...),
    db: Session = Depends(get_db_session),
) -> MonthsResponse:
    months = get_available_months(db, project_id)
    return MonthsResponse(project_id=project_id, months=months)


@router.get(
    "/snapshot",
    response_model=MonthlySnapshotResponse,
    summary="Monthly snapshot — SKU EOM, disposition summary, integrity",
    description=(
        "Returns the end-of-period inventory snapshot for a project: one row "
        "per SKU with totals broken down by disposition (SELLABLE / "
        "CUSTOMER_DAMAGED / etc.). Runs the cross-month integrity check when "
        "the resolved ``period`` is a full calendar month (e.g. "
        "``last_month``, ``2026-01``); partial windows (7d/30d/custom) skip "
        "the integrity check since it's meaningless without a complete ledger "
        "partition.\n\n"
        "Period values: 7d / 14d / 28d / 30d / 60d / 90d / this_month / "
        "last_month / ytd / custom / YYYY-MM / YYYY-MM-DD. See "
        "``backend/docs/inventory-ledger-api.md`` for the full grammar."
    ),
)
def get_snapshot(
    project_id: int = Query(...),
    period: str = Query(
        ...,
        description=(
            "REQUIRED. Period selector — see "
            "``backend/docs/inventory-ledger-api.md``. Examples: "
            "``last_month``, ``30d``, ``2026-01``."
        ),
    ),
    start_date: date | None = Query(
        default=None,
        description=(
            "Companion for ``period=custom`` only. Ignored (→ 400) for any "
            "other period value."
        ),
    ),
    end_date: date | None = Query(
        default=None,
        description=(
            "Companion for ``period=custom`` only. Ignored (→ 400) for any "
            "other period value."
        ),
    ),
    db: Session = Depends(get_db_session),
) -> MonthlySnapshotResponse:
    start, end, report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    # MoM comparison only for full-month periods
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
        "Returns per-SKU totals of every ledger event column (receipts, "
        "shipments, returns, damaged, lost, disposed, found, vendor_returns, "
        "transfer, other) summed across the resolved period window.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def get_events(
    project_id: int = Query(...),
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
    db: Session = Depends(get_db_session),
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
        "spotting shipments that arrived together (same day, same "
        "location).\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def get_clusters(
    project_id: int = Query(...),
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
    db: Session = Depends(get_db_session),
) -> ReceiptClustersResponse:
    start, end, _report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    clusters = get_receipt_clusters(db, project_id, start, end)
    return ReceiptClustersResponse(report_month=start, clusters=clusters)


@router.get(
    "/location-detail",
    response_model=LocationDetailResponse,
    summary="Warehouse-level detail (SKU × Location × Disposition)",
    description=(
        "Returns the end-of-period SKU × warehouse × disposition "
        "breakdown — useful for investigating WHERE inventory sits. "
        "Optionally filtered by a single ``msku``.\n\n"
        "Period values: see ``backend/docs/inventory-ledger-api.md``."
    ),
)
def get_location_detail(
    project_id: int = Query(...),
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
    msku: str | None = Query(
        default=None,
        description="Optional SKU filter — returns rows for this MSKU only.",
    ),
    db: Session = Depends(get_db_session),
) -> LocationDetailResponse:
    start, end, _report_month = resolve_period_inputs(
        period,
        start_date,
        end_date,
    )

    rows = get_sku_location_eom(db, project_id, start, end, msku=msku)
    return LocationDetailResponse(report_month=start, rows=rows)


@router.get(
    "/trend",
    response_model=TrendResponse,
    summary="Multi-month trend (EOM qty, events, damaged %)",
    description=(
        "Aggregates the last N months (default 6, max 24) into a single "
        "trend series — one row per month with EOM qty, event totals, and "
        "damaged-qty percentage. Independent of the ``?period=`` convention "
        "(driven by its own ``?months=N`` count parameter)."
    ),
)
def get_trend_endpoint(
    project_id: int = Query(...),
    months: int = Query(6, ge=1, le=24, description="Number of recent months"),
    db: Session = Depends(get_db_session),
) -> TrendResponse:
    """Multi-month aggregated trend: EOM qty, events, damaged pct per month."""
    items = get_trend(db, project_id, months=months)
    return TrendResponse(project_id=project_id, months=items)
