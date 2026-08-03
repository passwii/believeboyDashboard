"""External API — inventory ledger endpoints.

No auth (network isolation at gateway). project_id in path.
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
    EventsResponse,
    IntegrityCheckResult,
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
    get_sku_month_eom,
    get_sku_month_events,
    get_trend,
    parse_report_month,
    resolve_period,
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


@router.get("/months", response_model=MonthsResponse)
def ext_list_months(
    project_id: int,
    db: Session = Depends(get_read_db_session),
) -> MonthsResponse:
    """List months with ledger data."""
    months = get_available_months(db, project_id)
    return MonthsResponse(project_id=project_id, months=months)


@router.get("/snapshot", response_model=MonthlySnapshotResponse)
def ext_snapshot(
    project_id: int,
    report_month: str | None = Query(None, description="YYYY-MM or YYYY-MM-DD"),
    period: str | None = Query(
        default=None,
        description=(
            "Convenience period alias: 7d/14d/28d/30d/60d/90d/this_month/"
            "last_month/ytd/custom. Mutually exclusive with report_month "
            "and start_date/end_date."
        ),
    ),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> MonthlySnapshotResponse:
    """Monthly/period snapshot."""
    start, end, report_month = resolve_period_inputs(
        report_month,
        start_date,
        end_date,
        period,
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


@router.get("/events", response_model=EventsResponse)
def ext_events(
    project_id: int,
    report_month: str | None = Query(None, description="YYYY-MM or YYYY-MM-DD"),
    period: str | None = Query(
        default=None,
        description=(
            "Convenience period alias: 7d/14d/28d/30d/60d/90d/this_month/"
            "last_month/ytd/custom. Mutually exclusive with report_month "
            "and start_date/end_date."
        ),
    ),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> EventsResponse:
    """SKU event flow."""
    start, end, _report_month = resolve_period_inputs(
        report_month,
        start_date,
        end_date,
        period,
    )

    skus = get_sku_month_events(db, project_id, start, end)
    return EventsResponse(report_month=start, skus=skus)


@router.get("/receipt-clusters", response_model=ReceiptClustersResponse)
def ext_receipt_clusters(
    project_id: int,
    report_month: str | None = Query(None, description="YYYY-MM or YYYY-MM-DD"),
    period: str | None = Query(
        default=None,
        description=(
            "Convenience period alias: 7d/14d/28d/30d/60d/90d/this_month/"
            "last_month/ytd/custom. Mutually exclusive with report_month "
            "and start_date/end_date."
        ),
    ),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> ReceiptClustersResponse:
    """Receipt clusters."""
    start, end, _report_month = resolve_period_inputs(
        report_month,
        start_date,
        end_date,
        period,
    )

    clusters = get_receipt_clusters(db, project_id, start, end)
    return ReceiptClustersResponse(report_month=start, clusters=clusters)


@router.get("/integrity", response_model=IntegrityCheckResult)
def ext_integrity(
    project_id: int,
    report_month: str | None = Query(
        default=None,
        description="YYYY-MM or YYYY-MM-DD",
    ),
    period: str | None = Query(
        default=None,
        description=(
            "Convenience period alias. Only full-month aliases "
            "(this_month / last_month / ytd) make sense for integrity. "
            "Mutually exclusive with report_month."
        ),
    ),
    db: Session = Depends(get_read_db_session),
) -> IntegrityCheckResult:
    """Cross-month integrity check.

    Accepts either ``report_month`` (explicit YYYY-MM-DD) or ``period``
    (convenience alias — only full-month aliases resolve to a single
    ``report_month`` for the integrity check; partial-month aliases
    return 400).
    """
    if not report_month and not period:
        raise HTTPException(
            status_code=400,
            detail="Either report_month or period is required",
        )
    if report_month and period:
        raise HTTPException(
            status_code=400,
            detail="report_month and period are mutually exclusive",
        )
    if report_month:
        try:
            month_date = parse_report_month(report_month)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        # period path: resolve via the shared helper, ignoring start/end
        # (integrity is always a single-month check).
        _start, _end, report_month_date = resolve_period_inputs(
            report_month=None,
            start_date=None,
            end_date=None,
            period=period,
        )
        if report_month_date is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"period={period!r} does not resolve to a full "
                    "calendar month; use report_month for non-full-month "
                    "integrity checks"
                ),
            )
        month_date = report_month_date
    return check_ledger_integrity(db, project_id, month_date)


@router.get("/trend", response_model=TrendResponse)
def ext_trend(
    project_id: int,
    months: int = Query(6, ge=1, le=24, description="Number of recent months"),
    db: Session = Depends(get_read_db_session),
) -> TrendResponse:
    """Multi-month aggregated trend."""
    items = get_trend(db, project_id, months=months)
    return TrendResponse(project_id=project_id, months=items)
