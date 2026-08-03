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

    # Current month first-day starting balances.
    #
    # BEL-417 P0 fix: the previous implementation matched rows via
    # ``date = (SELECT min(date) WHERE ...)`` with ``.correlate()`` — the
    # correlated subquery collapsed into the outer query and lifted ``min()``
    # into the outer WHERE, which Postgres rejects with
    # ``GroupingError: aggregate functions are not allowed in WHERE``.
    # Every ``/snapshot`` call for a full month where the project already had
    # the previous month's data 500'd (and white-screened the frontend page).
    #
    # Replacement mirrors ``_eom_subquery``: ROW_NUMBER partitioned by the
    # natural group key, ordered ASCending, take rn == 1 — the earliest row
    # per (msku, location, disposition) carries the month's starting balance.
    first_rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerRaw.msku,
                InventoryLedgerRaw.location,
                InventoryLedgerRaw.disposition,
            ],
            order_by=InventoryLedgerRaw.date.asc(),
        )
        .label("rn")
    )
    curr_first_subq = (
        select(InventoryLedgerRaw, first_rn)
        .where(
            InventoryLedgerRaw.project_id == project_id,
            InventoryLedgerRaw.report_month == report_month,
        )
        .subquery()
    )
    curr_first_stmt = select(
        curr_first_subq.c.msku,
        curr_first_subq.c.location,
        curr_first_subq.c.disposition,
        curr_first_subq.c.starting_balance,
    ).where(curr_first_subq.c.rn == 1)

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


# BEL-417: column order in the COPY payload must match the staging table
# definition below AND InventoryLedgerRaw.__table__.columns (minus id, raw_row,
# loaded_at, which are DB-managed / defaulted).
_LEDGER_COPY_COLUMNS: tuple[str, ...] = (
    "project_id",
    "report_month",
    "date",
    "fnsku",
    "asin",
    "msku",
    "title",
    "disposition",
    "location",
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
    "store",
)


def _format_copy_value(value) -> str:
    """Format a Python value for PostgreSQL COPY text format.

    - ``None`` → ``\\N`` (NULL)
    - ``date`` / ``datetime`` → ISO date / datetime
    - ``int`` / ``float`` → str representation
    - ``str`` → backslash-escaped (\\, \\t, \\n, \\r) per COPY default mode
    """
    if value is None:
        return r"\N"
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bool):
        return "t" if value else "f"
    if isinstance(value, (int, float)):
        return str(value)
    s = str(value)
    # COPY text default-mode escapes (order matters — backslash first):
    return (
        s.replace("\\", "\\\\")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    )


def _build_copy_payload(
    full_rows: list[dict],
) -> bytes:
    """Serialize parsed CSV rows to a single COPY payload (UTF-8 text).

    Each row becomes one tab-separated line ending in ``\\n`` (the COPY default
    text format row terminator). The output is one byte string that can be
    fed to ``cursor.copy_expert("COPY ... FROM STDIN", buffer)``.
    """
    out = io.StringIO()
    for row in full_rows:
        cells = [_format_copy_value(row.get(col)) for col in _LEDGER_COPY_COLUMNS]
        out.write("\t".join(cells))
        out.write("\n")
    return out.getvalue().encode("utf-8")


def _ingest_ledger_csv_legacy(
    db: Session,
    full_rows: list[dict],
) -> int:
    """Pre-BEL-417 path: per-batch pg_insert().on_conflict_do_update().

    Kept as a safety net for the test suite (SQLite-style) and as a
    reference implementation. The production path now uses
    ``_ingest_ledger_csv_copy`` — see the public ``ingest_ledger_csv``.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

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
    return total


def _ingest_ledger_csv_copy(
    db: Session,
    full_rows: list[dict],
) -> int:
    """BEL-417: COPY-from-STDIN into a temp staging table, then
    ``INSERT ... ON CONFLICT`` into the real table — all in the same
    transaction.

    Replaces a 100-statement INSERT loop (one per 500-row batch) with a
    single COPY round-trip, then one bulk upsert. Cuts a 30-50k-row monthly
    ledger from ~30-60s (which routinely blew the 5s frontend proxy
    timeout AND sometimes the 120s Postgres ``statement_timeout``) down to
    a few seconds.

    The temp table is created with ``ON COMMIT DROP`` so it disappears
    when the surrounding transaction ends — no migration, no leftover
    staging data, and no risk of conflict with concurrent ingest calls
    in the same session.
    """
    if not full_rows:
        return 0

    payload = _build_copy_payload(full_rows)
    # Type the staging table columns to match inventory_ledger_raw so the
    # subsequent ``INSERT ... SELECT`` does not need per-column casts. The
    # 5 natural-key columns (project_id, report_month, date, msku, disposition,
    # location) keep their real types; everything else follows the real
    # table's column list.
    staging_column_defs: list[str] = [
        '"project_id" INTEGER',
        '"report_month" DATE',
        '"date" DATE',
        '"fnsku" VARCHAR(20)',
        '"asin" VARCHAR(15)',
        '"msku" VARCHAR(30)',
        '"title" VARCHAR(500)',
        '"disposition" VARCHAR(20)',
        '"location" VARCHAR(10)',
        '"starting_balance" INTEGER',
        '"in_transit_between" INTEGER',
        '"receipts" INTEGER',
        '"customer_shipments" INTEGER',
        '"customer_returns" INTEGER',
        '"vendor_returns" INTEGER',
        '"warehouse_transfer_io" INTEGER',
        '"found" INTEGER',
        '"lost" INTEGER',
        '"damaged" INTEGER',
        '"disposed" INTEGER',
        '"other_events" INTEGER',
        '"ending_balance" INTEGER',
        '"unknown_events" INTEGER',
        '"store" VARCHAR(50)',
    ]
    staging_ddl = (
        "CREATE TEMP TABLE IF NOT EXISTS staging_inventory_ledger_raw ("
        + ", ".join(staging_column_defs)
        + ") ON COMMIT DROP"
    )
    staging_columns = ", ".join(f'"{c}"' for c in _LEDGER_COPY_COLUMNS)
    insert_columns_sql = ", ".join(f'"{c}"' for c in _LEDGER_COPY_COLUMNS)
    update_set_sql = ", ".join(
        f'"{c}" = EXCLUDED."{c}"'
        for c in _LEDGER_COPY_COLUMNS
        if c
        not in (
            "project_id",
            "report_month",
            "date",
            "msku",
            "disposition",
            "location",
        )
    )
    conflict_cols = "(project_id, report_month, date, msku, disposition, location)"

    # Re-use the session's checked-out DBAPI connection so this COPY runs
    # in the SAME transaction as the surrounding session.flush()/commit().
    sa_conn = db.connection()
    raw_conn = sa_conn.connection.dbapi_connection
    if raw_conn is None:
        # Fallback for sessions that haven't materialised a connection yet.
        raw_conn = db.bind.raw_connection()  # type: ignore[union-attr]
    cur = raw_conn.cursor()
    try:
        cur.execute(staging_ddl)
        # psycopg 3 doesn't expose psycopg2's ``copy_expert``; instead the
        # cursor's ``.copy()`` returns a context manager we can write the
        # payload to.  This is one round-trip — no per-row statement.
        with cur.copy(
            f"COPY staging_inventory_ledger_raw ({staging_columns}) "
            f"FROM STDIN WITH (FORMAT text)"
        ) as copy:
            copy.write(payload)
        upsert_sql = (
            f"INSERT INTO inventory_ledger_raw ({insert_columns_sql}) "
            f"SELECT {insert_columns_sql} FROM staging_inventory_ledger_raw "
            f"ON CONFLICT {conflict_cols} DO UPDATE SET {update_set_sql}"
        )
        cur.execute(upsert_sql)
    finally:
        cur.close()

    return len(full_rows)


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

    full_rows = [
        {**row, "project_id": project_id, "report_month": report_month}
        for row in rows_to_upsert
    ]

    # BEL-417: prefer COPY-from-STDIN (one round-trip + one bulk upsert) over
    # the legacy per-batch pg_insert loop. Fall back to the legacy path when
    # the session is bound to a non-Postgres dialect (e.g. SQLite in unit
    # tests where ``cursor.copy_expert`` would not exist).
    bind = db.bind
    is_postgres = bool(bind and getattr(bind.dialect, "name", "") == "postgresql")
    if is_postgres:
        return _ingest_ledger_csv_copy(db, full_rows)
    return _ingest_ledger_csv_legacy(db, full_rows)
