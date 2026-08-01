"""Inventory Ledger service — query functions + CSV ingest.

Replaces the PRD's 7 SQL views with service-layer SQLAlchemy queries.
All query functions accept (db, project_id, start_date, end_date).
"""

from __future__ import annotations

import calendar
import csv
import hashlib
import io
import re
from datetime import date, datetime, timezone

from sqlalchemy import func, select, and_, case
from sqlalchemy.orm import Session

from app.models.inventory_ledger import InventoryLedgerRaw
from app.schemas.inventory_ledger import (
    DispositionSummary,
    IntegrityCheckResult,
    IntegrityMismatch,
    LocationDetail,
    ReceiptCluster,
    SkuMonthEom,
    SkuMonthEvents,
)

# ─── Column mapping: CSV header (normalized) → model attribute ───────────────

CSV_COLUMN_MAP: dict[str, str] = {
    "date": "date",
    "fnsku": "fnsku",
    "asin": "asin",
    "msku": "msku",
    "title": "title",
    "disposition": "disposition",
    "starting_warehouse_balance": "starting_balance",
    "in_transit_between_warehouses": "in_transit_between",
    "receipts": "receipts",
    "customer_shipments": "customer_shipments",
    "customer_returns": "customer_returns",
    "vendor_returns": "vendor_returns",
    "warehouse_transfer_in/out": "warehouse_transfer_io",
    "found": "found",
    "lost": "lost",
    "damaged": "damaged",
    "disposed": "disposed",
    "other_events": "other_events",
    "ending_warehouse_balance": "ending_balance",
    "unknown_events": "unknown_events",
    "location": "location",
    "store": "store",
}

INT_COLUMNS = {
    "starting_balance",
    "in_transit_between",
    "receipts",
    "customer_shipments",
    "customer_returns",
    "vendor_returns",
    "warehouse_transfer_io",
    "found",
    "lost",
    "damaged",
    "disposed",
    "other_events",
    "ending_balance",
    "unknown_events",
}

REQUIRED_COLUMNS = {
    "date",
    "msku",
    "disposition",
    "location",
    "starting_warehouse_balance",
    "ending_warehouse_balance",
}


# ─── Helpers ──────────────────────────────────────────────────────────────────


def parse_report_month(value: str) -> date:
    """Parse report_month from 'YYYY-MM' or 'YYYY-MM-DD' into a date (first of month)."""
    value = value.strip()
    # YYYY-MM format
    m = re.match(r"^(\d{4})-(\d{2})$", value)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    # YYYY-MM-DD format — normalize to first of month
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", value)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    raise ValueError(
        f"Invalid report_month format: '{value}'. Use YYYY-MM or YYYY-MM-DD."
    )


def resolve_period(
    report_month: str | date | None, start_date: date | None, end_date: date | None
) -> tuple[date, date]:
    """Resolve report_month or explicit date range into (start, end).

    report_month accepts 'YYYY-MM', 'YYYY-MM-DD', or a date object.
    """
    if report_month and (start_date or end_date):
        raise ValueError("report_month and start_date/end_date are mutually exclusive")
    if report_month:
        if isinstance(report_month, str):
            report_month = parse_report_month(report_month)
        last_day = calendar.monthrange(report_month.year, report_month.month)[1]
        return report_month, date(report_month.year, report_month.month, last_day)
    if start_date and end_date:
        return start_date, end_date
    raise ValueError("Either report_month or both start_date and end_date are required")


def _eom_subquery(db: Session, project_id: int, start: date, end: date):
    """Subquery: ROW_NUMBER partitioned by (msku, location, disposition) ordered by date DESC.

    Returns rows with rn == 1 (last row per group in the period).
    """
    rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerRaw.msku,
                InventoryLedgerRaw.location,
                InventoryLedgerRaw.disposition,
            ],
            order_by=InventoryLedgerRaw.date.desc(),
        )
        .label("rn")
    )

    subq = (
        select(InventoryLedgerRaw, rn)
        .where(
            InventoryLedgerRaw.project_id == project_id,
            InventoryLedgerRaw.date >= start,
            InventoryLedgerRaw.date <= end,
        )
        .subquery()
    )
    return subq


# ─── 1. get_sku_month_eom ─────────────────────────────────────────────────────


def get_sku_month_eom(
    db: Session,
    project_id: int,
    start: date,
    end: date,
    prev_start: date | None = None,
    prev_end: date | None = None,
) -> list[SkuMonthEom]:
    """Per-SKU end-of-period total inventory (all dispositions summed)."""
    subq = _eom_subquery(db, project_id, start, end)

    stmt = (
        select(
            subq.c.msku,
            func.max(subq.c.title).label("title"),
            func.sum(subq.c.ending_balance).label("qty_eom"),
            func.sum(
                case((subq.c.disposition == "SELLABLE", subq.c.ending_balance), else_=0)
            ).label("sellable_qty"),
            func.sum(
                case((subq.c.disposition != "SELLABLE", subq.c.ending_balance), else_=0)
            ).label("damaged_qty"),
        )
        .where(subq.c.rn == 1, subq.c.ending_balance > 0)
        .group_by(subq.c.msku)
        .order_by(subq.c.msku)
    )
    rows = db.execute(stmt).all()

    # Previous period for MoM comparison
    prev_map: dict[str, int] = {}
    if prev_start and prev_end:
        prev_subq = _eom_subquery(db, project_id, prev_start, prev_end)
        prev_stmt = (
            select(prev_subq.c.msku, func.sum(prev_subq.c.ending_balance).label("qty"))
            .where(prev_subq.c.rn == 1, prev_subq.c.ending_balance > 0)
            .group_by(prev_subq.c.msku)
        )
        for r in db.execute(prev_stmt).all():
            prev_map[r.msku] = int(r.qty or 0)

    results = []
    for r in rows:
        qty = int(r.qty_eom or 0)
        prev = prev_map.get(r.msku)
        results.append(
            SkuMonthEom(
                msku=r.msku,
                title=r.title,
                qty_eom=qty,
                sellable_qty=int(r.sellable_qty or 0),
                damaged_qty=int(r.damaged_qty or 0),
                prev_qty_eom=prev,
                change=(qty - prev) if prev is not None else None,
            )
        )
    return results


# ─── 2. get_sku_location_eom ──────────────────────────────────────────────────


def get_sku_location_eom(
    db: Session,
    project_id: int,
    start: date,
    end: date,
    msku: str | None = None,
) -> list[LocationDetail]:
    """SKU × Location × Disposition end-of-period detail."""
    subq = _eom_subquery(db, project_id, start, end)

    filters = [subq.c.rn == 1, subq.c.ending_balance > 0]
    if msku:
        filters.append(subq.c.msku == msku)

    stmt = (
        select(
            subq.c.msku,
            subq.c.title,
            subq.c.location,
            subq.c.disposition,
            subq.c.ending_balance.label("qty_eom"),
        )
        .where(*filters)
        .order_by(subq.c.msku, subq.c.ending_balance.desc())
    )
    return [
        LocationDetail(
            msku=r.msku,
            title=r.title,
            location=r.location,
            disposition=r.disposition,
            qty_eom=int(r.qty_eom),
        )
        for r in db.execute(stmt).all()
    ]


# ─── 3. get_sku_disp_eom ──────────────────────────────────────────────────────


def get_sku_disp_eom(
    db: Session, project_id: int, start: date, end: date
) -> list[dict]:
    """SKU × Disposition end-of-period (for damage ratio)."""
    subq = _eom_subquery(db, project_id, start, end)

    stmt = (
        select(
            subq.c.msku,
            subq.c.disposition,
            func.sum(subq.c.ending_balance).label("qty_eom"),
        )
        .where(subq.c.rn == 1, subq.c.ending_balance > 0)
        .group_by(subq.c.msku, subq.c.disposition)
        .order_by(subq.c.msku, subq.c.disposition)
    )
    return [
        {"msku": r.msku, "disposition": r.disposition, "qty_eom": int(r.qty_eom or 0)}
        for r in db.execute(stmt).all()
    ]


# ─── 4. get_month_disposition_summary ─────────────────────────────────────────


def get_month_disposition_summary(
    db: Session,
    project_id: int,
    start: date,
    end: date,
) -> list[DispositionSummary]:
    """Disposition breakdown with percentage."""
    subq = _eom_subquery(db, project_id, start, end)

    stmt = (
        select(
            subq.c.disposition,
            func.sum(subq.c.ending_balance).label("qty_eom"),
        )
        .where(subq.c.rn == 1, subq.c.ending_balance > 0)
        .group_by(subq.c.disposition)
        .order_by(subq.c.disposition)
    )
    rows = db.execute(stmt).all()
    total = sum(int(r.qty_eom or 0) for r in rows)

    return [
        DispositionSummary(
            disposition=r.disposition,
            qty_eom=int(r.qty_eom or 0),
            pct_of_total=round(100.0 * int(r.qty_eom or 0) / total, 2)
            if total > 0
            else 0.0,
        )
        for r in rows
    ]


# ─── 5. get_receipt_clusters ──────────────────────────────────────────────────


def get_receipt_clusters(
    db: Session, project_id: int, start: date, end: date
) -> list[ReceiptCluster]:
    """Receipt clusters: group by (date, location), aggregate SKUs."""
    stmt = (
        select(
            InventoryLedgerRaw.date,
            InventoryLedgerRaw.location,
            func.string_agg(InventoryLedgerRaw.msku, ",").label("sku_set_raw"),
            func.count(func.distinct(InventoryLedgerRaw.msku)).label("sku_count"),
            func.sum(InventoryLedgerRaw.receipts).label("total_qty"),
        )
        .where(
            InventoryLedgerRaw.project_id == project_id,
            InventoryLedgerRaw.date >= start,
            InventoryLedgerRaw.date <= end,
            InventoryLedgerRaw.receipts > 0,
        )
        .group_by(InventoryLedgerRaw.date, InventoryLedgerRaw.location)
        .order_by(InventoryLedgerRaw.date.desc(), InventoryLedgerRaw.location)
    )
    results = []
    for r in db.execute(stmt).all():
        # Sort SKU set for deterministic cluster_id
        skus = sorted(set((r.sku_set_raw or "").split(",")))
        sku_set = ",".join(skus)
        cluster_id = hashlib.md5(
            f"{start.isoformat()}|{r.date.isoformat()}|{r.location}|{sku_set}".encode()
        ).hexdigest()
        results.append(
            ReceiptCluster(
                date=r.date,
                location=r.location,
                sku_set=sku_set,
                sku_count=int(r.sku_count or 0),
                total_qty=int(r.total_qty or 0),
                cluster_id=cluster_id,
            )
        )
    return results


# ─── 6. get_sku_month_events ──────────────────────────────────────────────────


def get_sku_month_events(
    db: Session, project_id: int, start: date, end: date
) -> list[SkuMonthEvents]:
    """Per-SKU event totals for the period."""
    stmt = (
        select(
            InventoryLedgerRaw.msku,
            func.max(InventoryLedgerRaw.title).label("title"),
            func.sum(InventoryLedgerRaw.receipts).label("total_receipts"),
            func.sum(InventoryLedgerRaw.customer_shipments).label("total_shipments"),
            func.sum(InventoryLedgerRaw.customer_returns).label("total_returns"),
            func.sum(InventoryLedgerRaw.damaged).label("total_damaged"),
            func.sum(InventoryLedgerRaw.lost).label("total_lost"),
            func.sum(InventoryLedgerRaw.disposed).label("total_disposed"),
            func.sum(InventoryLedgerRaw.found).label("total_found"),
            func.sum(InventoryLedgerRaw.vendor_returns).label("total_vendor_returns"),
            func.sum(InventoryLedgerRaw.warehouse_transfer_io).label("total_transfer"),
            func.sum(InventoryLedgerRaw.other_events).label("total_other"),
        )
        .where(
            InventoryLedgerRaw.project_id == project_id,
            InventoryLedgerRaw.date >= start,
            InventoryLedgerRaw.date <= end,
        )
        .group_by(InventoryLedgerRaw.msku)
        .order_by(InventoryLedgerRaw.msku)
    )
    results = []
    for r in db.execute(stmt).all():
        receipts = int(r.total_receipts or 0)
        shipments = int(r.total_shipments or 0)
        returns_ = int(r.total_returns or 0)
        damaged = int(r.total_damaged or 0)
        lost = int(r.total_lost or 0)
        disposed = int(r.total_disposed or 0)
        found = int(r.total_found or 0)
        vendor_returns = int(r.total_vendor_returns or 0)
        transfer = int(r.total_transfer or 0)
        other = int(r.total_other or 0)
        net = (
            receipts
            + shipments
            + returns_
            + damaged
            + lost
            + disposed
            + found
            + vendor_returns
            + transfer
            + other
        )
        results.append(
            SkuMonthEvents(
                msku=r.msku,
                title=r.title,
                total_receipts=receipts,
                total_shipments=shipments,
                total_returns=returns_,
                total_damaged=damaged,
                total_lost=lost,
                total_disposed=disposed,
                total_found=found,
                total_vendor_returns=vendor_returns,
                total_transfer=transfer,
                total_other=other,
                net_change=net,
            )
        )
    return results


# ─── 7. check_ledger_integrity ────────────────────────────────────────────────


def check_ledger_integrity(
    db: Session,
    project_id: int,
    report_month: date,
) -> IntegrityCheckResult:
    """Cross-month continuity: prev month ending == curr month starting."""
    # Previous month
    if report_month.month == 1:
        prev_month = date(report_month.year - 1, 12, 1)
    else:
        prev_month = date(report_month.year, report_month.month - 1, 1)
    prev_last_day = calendar.monthrange(prev_month.year, prev_month.month)[1]
    prev_end = date(prev_month.year, prev_month.month, prev_last_day)

    # Check if previous month has data
    prev_count = (
        db.execute(
            select(func.count())
            .select_from(InventoryLedgerRaw)
            .where(
                InventoryLedgerRaw.project_id == project_id,
                InventoryLedgerRaw.report_month == prev_month,
            )
        ).scalar()
        or 0
    )

    if prev_count == 0:
        return IntegrityCheckResult(
            report_month=report_month,
            status="PENDING",
            mismatch_count=0,
            mismatches=[],
            checked_at=datetime.now(timezone.utc),
        )

    # Previous month EOM per (msku, location, disposition)
    prev_subq = _eom_subquery(db, project_id, prev_month, prev_end)
    prev_stmt = select(
        prev_subq.c.msku,
        prev_subq.c.location,
        prev_subq.c.disposition,
        prev_subq.c.ending_balance.label("prev_ending"),
    ).where(prev_subq.c.rn == 1)
    prev_map: dict[tuple[str, str, str], int] = {}
    for r in db.execute(prev_stmt).all():
        prev_map[(r.msku, r.location, r.disposition)] = int(r.prev_ending or 0)

    # Current month first-day starting balances
    curr_last_day = calendar.monthrange(report_month.year, report_month.month)[1]
    curr_end = date(report_month.year, report_month.month, curr_last_day)
    curr_subq = _eom_subquery(db, project_id, report_month, curr_end)

    # Get the earliest rows (starting_balance) for current month
    curr_first_stmt = select(
        InventoryLedgerRaw.msku,
        InventoryLedgerRaw.location,
        InventoryLedgerRaw.disposition,
        InventoryLedgerRaw.starting_balance,
    ).where(
        InventoryLedgerRaw.project_id == project_id,
        InventoryLedgerRaw.report_month == report_month,
        InventoryLedgerRaw.date
        == (
            select(func.min(InventoryLedgerRaw.date))
            .where(
                InventoryLedgerRaw.project_id == project_id,
                InventoryLedgerRaw.report_month == report_month,
                InventoryLedgerRaw.msku == InventoryLedgerRaw.msku,
                InventoryLedgerRaw.location == InventoryLedgerRaw.location,
                InventoryLedgerRaw.disposition == InventoryLedgerRaw.disposition,
            )
            .correlate(InventoryLedgerRaw)
            .scalar_subquery()
        ),
    )

    mismatches: list[IntegrityMismatch] = []
    for r in db.execute(curr_first_stmt).all():
        key = (r.msku, r.location, r.disposition)
        prev_ending = prev_map.get(key)
        if prev_ending is None:
            continue  # New combination in current month, not a mismatch
        curr_starting = int(r.starting_balance or 0)
        if prev_ending != curr_starting:
            mismatches.append(
                IntegrityMismatch(
                    msku=r.msku,
                    location=r.location,
                    disposition=r.disposition,
                    prev_ending=prev_ending,
                    curr_starting=curr_starting,
                    diff=curr_starting - prev_ending,
                )
            )

    return IntegrityCheckResult(
        report_month=report_month,
        status="MISMATCH" if mismatches else "OK",
        mismatch_count=len(mismatches),
        mismatches=mismatches,
        checked_at=datetime.now(timezone.utc),
    )


# ─── 8. get_available_months ──────────────────────────────────────────────────


def get_available_months(db: Session, project_id: int) -> list[date]:
    """List distinct report_months that have data for this project."""
    stmt = (
        select(InventoryLedgerRaw.report_month)
        .where(InventoryLedgerRaw.project_id == project_id)
        .group_by(InventoryLedgerRaw.report_month)
        .order_by(InventoryLedgerRaw.report_month.desc())
    )
    return [r[0] for r in db.execute(stmt).all()]


# ─── 9. get_trend ─────────────────────────────────────────────────────────────


def get_trend(db: Session, project_id: int, months: int = 6) -> list[dict]:
    """Multi-month aggregated trend: EOM qty, events, damaged pct per month."""
    from app.schemas.inventory_ledger import TrendMonthItem

    available = get_available_months(db, project_id)
    # Take the most recent N months
    target_months = available[:months]

    results: list[TrendMonthItem] = []
    for month_start in reversed(target_months):  # chronological order
        last_day = calendar.monthrange(month_start.year, month_start.month)[1]
        month_end = date(month_start.year, month_start.month, last_day)

        # EOM totals via subquery
        subq = _eom_subquery(db, project_id, month_start, month_end)
        eom_stmt = select(
            func.count(func.distinct(subq.c.msku)).label("sku_count"),
            func.sum(subq.c.ending_balance).label("total_qty"),
            func.sum(
                case(
                    (subq.c.disposition != "SELLABLE", subq.c.ending_balance),
                    else_=0,
                )
            ).label("damaged_qty"),
        ).where(subq.c.rn == 1, subq.c.ending_balance > 0)
        eom_row = db.execute(eom_stmt).one()

        # Event totals
        evt_stmt = select(
            func.sum(InventoryLedgerRaw.receipts).label("total_receipts"),
            func.sum(InventoryLedgerRaw.customer_shipments).label("total_shipments"),
            func.sum(InventoryLedgerRaw.customer_returns).label("total_returns"),
            func.sum(InventoryLedgerRaw.damaged).label("total_damaged"),
            func.sum(InventoryLedgerRaw.lost).label("total_lost"),
            func.sum(InventoryLedgerRaw.disposed).label("total_disposed"),
        ).where(
            InventoryLedgerRaw.project_id == project_id,
            InventoryLedgerRaw.date >= month_start,
            InventoryLedgerRaw.date <= month_end,
        )
        evt_row = db.execute(evt_stmt).one()

        total_qty = int(eom_row.total_qty or 0)
        damaged_qty = int(eom_row.damaged_qty or 0)
        damaged_pct = (
            round(100.0 * damaged_qty / total_qty, 2) if total_qty > 0 else 0.0
        )

        results.append(
            TrendMonthItem(
                report_month=month_start.strftime("%Y-%m"),
                sku_count=int(eom_row.sku_count or 0),
                total_qty_eom=total_qty,
                total_receipts=int(evt_row.total_receipts or 0),
                total_shipments=int(evt_row.total_shipments or 0),
                total_returns=int(evt_row.total_returns or 0),
                total_damaged=int(evt_row.total_damaged or 0),
                total_lost=int(evt_row.total_lost or 0),
                total_disposed=int(evt_row.total_disposed or 0),
                damaged_pct=damaged_pct,
            )
        )

    return results


# ─── 9. ingest_ledger_csv ─────────────────────────────────────────────────────


def _normalize_header(h: str) -> str:
    return h.strip().lower().replace(" ", "_")


def _extract_report_month(filename: str, dates: list[date]) -> date:
    """Extract report_month from filename or fallback to min date."""
    # Pattern: 20260501-0531.csv
    m = re.search(r"(\d{4})(\d{2})\d{2}", filename)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    # Pattern: 库存分类账 2026-0601-0630.csv
    m = re.search(r"(\d{4})-?(\d{2})\d{2}", filename)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1)
    # Fallback: min date's month
    if dates:
        min_d = min(dates)
        return date(min_d.year, min_d.month, 1)
    raise ValueError("Cannot determine report_month from filename or data")


def ingest_ledger_csv(
    db: Session,
    project_id: int,
    csv_content: str | bytes,
    filename: str = "",
) -> int:
    """Parse a 22-column Amazon Detailed Inventory Ledger CSV and upsert rows.

    Returns the number of rows upserted.
    """
    if isinstance(csv_content, bytes):
        csv_content = csv_content.decode("utf-8-sig")

    reader = csv.DictReader(io.StringIO(csv_content))
    if not reader.fieldnames:
        raise ValueError("Empty CSV file")

    # Normalize headers and validate
    raw_headers = [_normalize_header(h) for h in reader.fieldnames]
    header_map = {raw: CSV_COLUMN_MAP.get(raw) for raw in raw_headers}

    missing = REQUIRED_COLUMNS - set(raw_headers)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    rows_to_upsert: list[dict] = []
    all_dates: list[date] = []

    for raw_row in reader:
        # Build normalized row
        row: dict = {}
        for raw_key, value in raw_row.items():
            norm_key = _normalize_header(raw_key)
            model_attr = header_map.get(norm_key)
            if model_attr is None:
                continue
            value = (value or "").strip()
            if model_attr in INT_COLUMNS:
                row[model_attr] = int(value) if value else 0
            elif model_attr == "date":
                # MM/DD/YYYY format
                row["date"] = datetime.strptime(value, "%m/%d/%Y").date()
                all_dates.append(row["date"])
            elif model_attr == "disposition":
                row["disposition"] = value or "SELLABLE"
            elif model_attr == "location":
                row["location"] = value or "UNKNOWN"
            else:
                row[model_attr] = value or None

        if "date" in row and "msku" in row:
            rows_to_upsert.append(row)

    if not rows_to_upsert:
        return 0

    report_month = _extract_report_month(filename, all_dates)

    # Bulk upsert using PostgreSQL ON CONFLICT
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    full_rows = [
        {**row, "project_id": project_id, "report_month": report_month}
        for row in rows_to_upsert
    ]

    # Batch in chunks of 500
    batch_size = 500
    total = 0
    for i in range(0, len(full_rows), batch_size):
        batch = full_rows[i : i + batch_size]
        stmt = pg_insert(InventoryLedgerRaw).values(batch)
        update_cols = {
            c.name: stmt.excluded[c.name]
            for c in InventoryLedgerRaw.__table__.columns
            if c.name
            not in (
                "id",
                "project_id",
                "report_month",
                "date",
                "msku",
                "disposition",
                "location",
                "loaded_at",
            )
        }
        stmt = stmt.on_conflict_do_update(
            constraint="uq_ledger_natural_key",
            set_=update_cols,
        )
        db.execute(stmt)
        total += len(batch)

    db.flush()
    return total
