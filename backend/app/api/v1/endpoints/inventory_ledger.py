"""Inventory Ledger internal API — /api/v1/inventory-ledger/*.

Requires authentication (Depends(protected)).
"""

from __future__ import annotations

import calendar
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.schemas.inventory_ledger import (
    EventsResponse,
    LocationDetailResponse,
    MonthlySnapshotResponse,
    MonthsResponse,
    ReceiptClustersResponse,
)
from app.services.inventory.ledger import (
    check_ledger_integrity,
    get_available_months,
    get_month_disposition_summary,
    get_receipt_clusters,
    get_sku_location_eom,
    get_sku_month_eom,
    get_sku_month_events,
    resolve_period,
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


@router.get("/months", response_model=MonthsResponse)
def list_months(
    project_id: int = Query(...),
    db: Session = Depends(get_db_session),
) -> MonthsResponse:
    """List months that have ledger data for this project."""
    months = get_available_months(db, project_id)
    return MonthsResponse(project_id=project_id, months=months)


@router.get("/snapshot", response_model=MonthlySnapshotResponse)
def get_snapshot(
    project_id: int = Query(...),
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db_session),
) -> MonthlySnapshotResponse:
    """Monthly/period snapshot: SKU EOM + disposition summary + integrity."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # MoM comparison only for report_month mode
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
def get_events(
    project_id: int = Query(...),
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db_session),
) -> EventsResponse:
    """SKU event flow for the period."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    skus = get_sku_month_events(db, project_id, start, end)
    return EventsResponse(report_month=start, skus=skus)


@router.get("/receipt-clusters", response_model=ReceiptClustersResponse)
def get_clusters(
    project_id: int = Query(...),
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    db: Session = Depends(get_db_session),
) -> ReceiptClustersResponse:
    """Receipt clusters for the period."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    clusters = get_receipt_clusters(db, project_id, start, end)
    return ReceiptClustersResponse(report_month=start, clusters=clusters)


@router.get("/location-detail", response_model=LocationDetailResponse)
def get_location_detail(
    project_id: int = Query(...),
    report_month: date | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    msku: str | None = Query(None),
    db: Session = Depends(get_db_session),
) -> LocationDetailResponse:
    """Warehouse-level detail, optionally filtered by SKU."""
    try:
        start, end = resolve_period(report_month, start_date, end_date)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    rows = get_sku_location_eom(db, project_id, start, end, msku=msku)
    return LocationDetailResponse(report_month=start, rows=rows)
