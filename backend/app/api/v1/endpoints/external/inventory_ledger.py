"""External API — inventory ledger endpoints.

No auth (network isolation at gateway). project_id in path.
"""

from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.schemas.inventory_ledger import (
    EventsResponse,
    IntegrityCheckResult,
    MonthlySnapshotResponse,
    MonthsResponse,
    ReceiptClustersResponse,
)
from app.services.inventory.ledger import (
    check_ledger_integrity,
    get_available_months,
    get_month_disposition_summary,
    get_receipt_clusters,
    get_sku_month_eom,
    get_sku_month_events,
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
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> MonthlySnapshotResponse:
    """Monthly/period snapshot."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

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
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> EventsResponse:
    """SKU event flow."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    skus = get_sku_month_events(db, project_id, start, end)
    return EventsResponse(report_month=start, skus=skus)


@router.get("/receipt-clusters", response_model=ReceiptClustersResponse)
def ext_receipt_clusters(
    project_id: int,
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_read_db_session),
) -> ReceiptClustersResponse:
    """Receipt clusters."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    clusters = get_receipt_clusters(db, project_id, start, end)
    return ReceiptClustersResponse(report_month=start, clusters=clusters)


@router.get("/integrity", response_model=IntegrityCheckResult)
def ext_integrity(
    project_id: int,
    report_month: date = Query(...),
    db: Session = Depends(get_read_db_session),
) -> IntegrityCheckResult:
    """Cross-month integrity check."""
    return check_ledger_integrity(db, project_id, report_month)
