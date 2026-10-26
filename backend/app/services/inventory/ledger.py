"""Inventory Ledger service — Summary + Detail 双表查询与 CSV 导入 (BEL-428).

Replaces the single ``inventory_ledger_raw`` model with the Amazon dual-view
schema:

- ``inventory_ledger_summary`` — Summary 视图（真相源），日聚合水位快照，
  重复导入按 natural key upsert 幂等
- ``inventory_ledger_detail`` — Detailed 视图（事件级），append-only，
  真实数据存在合法重复事件元组，去重落在批次表 file_hash 层
- ``inventory_ledger_ingest_batch`` — 每次 CSV 上传的批次元数据
  （排查时按 batch 定位版本；同 (project, month, filename, hash) 幂等）

旧 ``inventory_ledger_raw`` 表/模型已废弃，新代码完全不读写它。
"""

from __future__ import annotations

import calendar
import csv
import hashlib
import io
import re
from datetime import date, datetime, timezone
from typing import Literal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.inventory_ledger import (
    InventoryLedgerDetail,
    InventoryLedgerIngestBatch,
    InventoryLedgerSummary,
)
from app.models.project import Project
from app.schemas.inventory_ledger import (
    ConsistencyCheckResult,
    ConsistencyMismatch,
    DispositionSummary,
    IntegrityComparison,
    IntegrityCheckResult,
    IntegrityMismatch,
    LedgerDetailRow,
    LedgerSummaryRow,
    LocationDetail,
    ReceiptCluster,
    SkuMonthEom,
    SkuMonthEvents,
)

# ─── Column mapping: CSV header (normalized) → model attribute ───────────────

SUMMARY_CSV_COLUMN_MAP: dict[str, str] = {
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

SUMMARY_INT_COLUMNS = {
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

SUMMARY_REQUIRED_COLUMNS = {
    "date",
    "msku",
    "disposition",
    "location",
    "starting_warehouse_balance",
    "ending_warehouse_balance",
}

DETAIL_CSV_COLUMN_MAP: dict[str, str] = {
    "date": "date",
    "fnsku": "fnsku",
    "asin": "asin",
    "msku": "msku",
    "title": "title",
    "event_type": "event_type",
    "reference_id": "reference_id",
    "quantity": "quantity",
    "fulfillment_center": "fulfillment_center",
    "disposition": "disposition",
    "reason": "reason",
    "country": "country",
    "reconciled_quantity": "reconciled_quantity",
    "unreconciled_quantity": "unreconciled_quantity",
    "date_and_time": "date_and_time",
    "store": "store",
}

DETAIL_INT_COLUMNS = {
    "quantity",
    "reconciled_quantity",
    "unreconciled_quantity",
}

DETAIL_REQUIRED_COLUMNS = {
    "date",
    "msku",
    "event_type",
    "quantity",
    "fulfillment_center",
    "disposition",
}

# Detail event types whose CSV quantity is negative (out-flow).
DETAIL_NEGATIVE_EVENT_TYPES = {"Shipments", "VendorReturns", "Adjustments"}


def _project_country_matches(db: Session, project_id: int, country: str | None) -> bool:
    """Summary 表无 country 列（Amazon Summary 视图 CSV 无国家列），
    country 维度只能关联 Project.country（单项目=单站点，BLF-952）。
    返回 False 表示该项目站点与请求国家不符 → 调用方应返回空数据。
    """
    if not country:
        return True
    project = db.get(Project, project_id)
    return project is not None and project.country == country


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


def _normalize_header(h: str) -> str:
    return h.strip().lower().replace(" ", "_")


def detect_file_kind(headers: list[str]) -> str:
    """Detect whether a CSV is Summary or Detailed by its header names.

    Returns ``"summary"`` / ``"detail"`` / ``"unknown"``.
    """
    normalized = {_normalize_header(h) for h in headers}
    # Detail has Event Type + Quantity + Fulfillment Center; check first so a
    # file that happens to carry both sets of markers classifies as detail.
    if {"event_type", "quantity", "fulfillment_center"} <= normalized:
        return "detail"
    if {"starting_warehouse_balance", "ending_warehouse_balance"} <= normalized:
        return "summary"
    return "unknown"


def _guess_kind_for_validation(headers: list[str]) -> str:
    """Best-effort kind for missing-column reporting when detection is unknown.

    A file with any summary-ish marker (location / any event column) is
    treated as a broken summary; a file with any detail-ish marker (event
    type / quantity / reference id) as a broken detail. Only files with none
    of these stay ``"unknown"`` (→ 无法识别报表类型).
    """
    normalized = {_normalize_header(h) for h in headers}
    summary_markers = {
        "location",
        "starting_warehouse_balance",
        "ending_warehouse_balance",
        "receipts",
        "customer_shipments",
        "warehouse_transfer_in/out",
    }
    detail_markers = {"event_type", "quantity", "fulfillment_center", "reference_id"}
    if normalized & summary_markers and not normalized & detail_markers:
        return "summary"
    if normalized & detail_markers:
        return "detail"
    return "unknown"


def _extract_report_month(filename: str, dates: list[date]) -> date:
    """Extract report_month from filename or fallback to min date."""
    # Match only explicit 20xx date fragments. The previous unanchored
    # ``\d{8}`` pattern treated arbitrary numeric filenames (99539020752.csv)
    # as compact dates and produced invalid months.
    filename_patterns = (
        # 20260501-0531.csv
        r"(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)",
        # 库存分类账 2026-0601-0630.csv
        r"(?<!\d)(20\d{2})-?(\d{2})(\d{2})(?!\d)",
        # 库存分类账-2026-07详细视图.csv
        r"(?<!\d)(20\d{2})-(\d{2})(?!\d)",
    )
    for pattern in filename_patterns:
        m = re.search(pattern, filename)
        if not m:
            continue
        try:
            return date(int(m.group(1)), int(m.group(2)), 1)
        except ValueError:
            continue
    # Fallback: min date's month
    if dates:
        min_d = min(dates)
        return date(min_d.year, min_d.month, 1)
    raise ValueError("Cannot determine report_month from filename or data")


def _parse_csv_date(value: str) -> date:
    value = value.strip()
    for fmt in ("%m/%d/%Y", "%m/%Y"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        f"Unsupported inventory ledger Date format: '{value}'. "
        "Expected MM/DD/YYYY or MM/YYYY."
    )


def _parse_date_and_time(value: str) -> datetime | None:
    """Parse 'Date and Time' (ISO 8601 with tz, e.g. 2026-07-31T00:00:00-0700)."""
    value = (value or "").strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ─── 1. get_sku_month_eom ─────────────────────────────────────────────────────


def _eom_subquery(db: Session, project_id: int, start: date, end: date):
    """Subquery: ROW_NUMBER partitioned by (msku, location, disposition) ordered by date DESC.

    Returns rows with rn == 1 (last row per group in the period).
    """
    rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerSummary.msku,
                InventoryLedgerSummary.location,
                InventoryLedgerSummary.disposition,
            ],
            order_by=InventoryLedgerSummary.date.desc(),
        )
        .label("rn")
    )

    subq = (
        select(InventoryLedgerSummary, rn)
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.date >= start,
            InventoryLedgerSummary.date <= end,
        )
        .subquery()
    )
    return subq


def get_sku_month_eom(
    db: Session,
    project_id: int,
    start: date,
    end: date,
    prev_start: date | None = None,
    prev_end: date | None = None,
    country: str | None = None,
) -> list[SkuMonthEom]:
    """Per-SKU end-of-period total inventory (all dispositions summed)."""
    if not _project_country_matches(db, project_id, country):
        return []

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
    country: str | None = None,
) -> list[DispositionSummary]:
    """Disposition breakdown with percentage."""
    if not _project_country_matches(db, project_id, country):
        return []

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
    db: Session,
    project_id: int,
    start: date,
    end: date,
    country: str | None = None,
) -> list[ReceiptCluster]:
    """Receipt clusters: group by (date, location), aggregate SKUs."""
    if not _project_country_matches(db, project_id, country):
        return []

    stmt = (
        select(
            InventoryLedgerSummary.date,
            InventoryLedgerSummary.location,
            func.string_agg(InventoryLedgerSummary.msku, ",").label("sku_set_raw"),
            func.count(func.distinct(InventoryLedgerSummary.msku)).label("sku_count"),
            func.sum(InventoryLedgerSummary.receipts).label("total_qty"),
        )
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.date >= start,
            InventoryLedgerSummary.date <= end,
            InventoryLedgerSummary.receipts > 0,
        )
        .group_by(InventoryLedgerSummary.date, InventoryLedgerSummary.location)
        .order_by(InventoryLedgerSummary.date.desc(), InventoryLedgerSummary.location)
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
    db: Session,
    project_id: int,
    start: date,
    end: date,
    country: str | None = None,
) -> list[SkuMonthEvents]:
    """Per-SKU event totals for the period (from the Summary truth table)."""
    if not _project_country_matches(db, project_id, country):
        return []

    stmt = (
        select(
            InventoryLedgerSummary.msku,
            func.max(InventoryLedgerSummary.title).label("title"),
            func.sum(InventoryLedgerSummary.receipts).label("total_receipts"),
            func.sum(InventoryLedgerSummary.customer_shipments).label(
                "total_shipments"
            ),
            func.sum(InventoryLedgerSummary.customer_returns).label("total_returns"),
            func.sum(InventoryLedgerSummary.damaged).label("total_damaged"),
            func.sum(InventoryLedgerSummary.lost).label("total_lost"),
            func.sum(InventoryLedgerSummary.disposed).label("total_disposed"),
            func.sum(InventoryLedgerSummary.found).label("total_found"),
            func.sum(InventoryLedgerSummary.vendor_returns).label(
                "total_vendor_returns"
            ),
            func.sum(InventoryLedgerSummary.warehouse_transfer_io).label(
                "total_transfer"
            ),
            func.sum(InventoryLedgerSummary.other_events).label("total_other"),
        )
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.date >= start,
            InventoryLedgerSummary.date <= end,
        )
        .group_by(InventoryLedgerSummary.msku)
        .order_by(InventoryLedgerSummary.msku)
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
    country: str | None = None,
) -> IntegrityCheckResult:
    """Cross-month continuity: prev month ending == curr month starting.

    Operates on the Summary truth table (same semantics as the old raw-based
    check — BEL-417 P0 regression coverage preserved).
    """
    if not _project_country_matches(db, project_id, country):
        return IntegrityCheckResult(
            report_month=report_month,
            country=country,
            status="PENDING",
            mismatch_count=0,
            mismatches=[],
            checked_at=datetime.now(timezone.utc),
        )

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
            .select_from(InventoryLedgerSummary)
            .where(
                InventoryLedgerSummary.project_id == project_id,
                InventoryLedgerSummary.report_month == prev_month,
            )
        ).scalar()
        or 0
    )

    if prev_count == 0:
        return IntegrityCheckResult(
            report_month=report_month,
            country=country,
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

    # Current month first-day starting balances (earliest row per group,
    # ascending ROW_NUMBER — BEL-417 P0 fix, same pattern as _eom_subquery).
    first_rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerSummary.msku,
                InventoryLedgerSummary.location,
                InventoryLedgerSummary.disposition,
            ],
            order_by=InventoryLedgerSummary.date.asc(),
        )
        .label("rn")
    )
    curr_first_subq = (
        select(InventoryLedgerSummary, first_rn)
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.report_month == report_month,
        )
        .subquery()
    )
    curr_first_stmt = select(
        curr_first_subq.c.msku,
        curr_first_subq.c.location,
        curr_first_subq.c.disposition,
        curr_first_subq.c.starting_balance,
    ).where(curr_first_subq.c.rn == 1).order_by(
        curr_first_subq.c.msku,
        curr_first_subq.c.location,
        curr_first_subq.c.disposition,
    )

    mismatches: list[IntegrityMismatch] = []
    comparisons: list[IntegrityComparison] = []
    for r in db.execute(curr_first_stmt).all():
        key = (r.msku, r.location, r.disposition)
        prev_ending = prev_map.get(key)
        if prev_ending is None:
            continue  # New combination in current month, not a mismatch
        curr_starting = int(r.starting_balance or 0)
        diff = curr_starting - prev_ending
        comparisons.append(
            IntegrityComparison(
                msku=r.msku,
                location=r.location,
                disposition=r.disposition,
                prev_ending=prev_ending,
                curr_starting=curr_starting,
                diff=diff,
            )
        )
        if diff != 0:
            mismatches.append(
                IntegrityMismatch(
                    msku=r.msku,
                    location=r.location,
                    disposition=r.disposition,
                    prev_ending=prev_ending,
                    curr_starting=curr_starting,
                    diff=diff,
                )
            )

    return IntegrityCheckResult(
        report_month=report_month,
        country=country,
        status="MISMATCH" if mismatches else "OK",
        mismatch_count=len(mismatches),
        mismatches=mismatches,
        comparisons=comparisons,
        checked_at=datetime.now(timezone.utc),
    )


# ─── 8. get_available_months ──────────────────────────────────────────────────


def get_available_months(
    db: Session, project_id: int, country: str | None = None
) -> list[date]:
    """List distinct report_months that have data for this project.

    Unions Summary + Detail partitions so a month shows up as soon as either
    view has been uploaded. ``country`` 过滤：Summary 分支按 Project.country
    门（表无 country 列），Detail 分支按 ``detail.country`` 行级过滤。
    """
    summary_ok = _project_country_matches(db, project_id, country)
    detail_where = [InventoryLedgerDetail.project_id == project_id]
    if country:
        detail_where.append(InventoryLedgerDetail.country == country)

    stmt = (
        select(InventoryLedgerSummary.report_month)
        .where(
            InventoryLedgerSummary.project_id == project_id
        )
        if summary_ok
        else select(InventoryLedgerSummary.report_month).where(False)
    )
    detail_q = select(InventoryLedgerDetail.report_month).where(*detail_where)
    stmt = stmt.union(detail_q)
    stmt = stmt.order_by(InventoryLedgerSummary.report_month.desc())
    return [r[0] for r in db.execute(stmt).all()]


# ─── 9. get_trend ─────────────────────────────────────────────────────────────


def get_trend(
    db: Session,
    project_id: int,
    months: int = 6,
    country: str | None = None,
) -> list[dict]:
    """Multi-month aggregated trend: EOM qty, events, damaged pct per month."""
    if not _project_country_matches(db, project_id, country):
        return []
    from app.schemas.inventory_ledger import TrendMonthItem

    available = get_available_months(db, project_id, country)
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
            func.sum(InventoryLedgerSummary.receipts).label("total_receipts"),
            func.sum(InventoryLedgerSummary.customer_shipments).label(
                "total_shipments"
            ),
            func.sum(InventoryLedgerSummary.customer_returns).label("total_returns"),
            func.sum(InventoryLedgerSummary.damaged).label("total_damaged"),
            func.sum(InventoryLedgerSummary.lost).label("total_lost"),
            func.sum(InventoryLedgerSummary.disposed).label("total_disposed"),
        ).where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.date >= month_start,
            InventoryLedgerSummary.date <= month_end,
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


# ─── 10. Detail 查询 ──────────────────────────────────────────────────────────


def get_ledger_detail_rows(
    db: Session,
    project_id: int,
    start: date,
    end: date,
    msku: str | None = None,
    fulfillment_center: str | None = None,
    event_type: str | None = None,
    country: str | None = None,
    limit: int | None = 2000,
) -> list[LedgerDetailRow]:
    """Event-level rows from the Detailed view, newest first.

    ``country`` 直接按 ``InventoryLedgerDetail.country`` 列行级过滤
    （detail 表有 country 列）。
    """
    filters = [
        InventoryLedgerDetail.project_id == project_id,
        InventoryLedgerDetail.date >= start,
        InventoryLedgerDetail.date <= end,
    ]
    if msku:
        filters.append(InventoryLedgerDetail.msku == msku)
    if fulfillment_center:
        filters.append(InventoryLedgerDetail.fulfillment_center == fulfillment_center)
    if event_type:
        filters.append(InventoryLedgerDetail.event_type == event_type)
    if country:
        filters.append(InventoryLedgerDetail.country == country)

    stmt = (
        select(InventoryLedgerDetail)
        .where(*filters)
        .order_by(
            InventoryLedgerDetail.date.desc(),
            InventoryLedgerDetail.id.desc(),
        )
    )
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = []
    for r in db.execute(stmt).scalars().all():
        rows.append(
            LedgerDetailRow(
                id=r.id,
                date=r.date,
                fnsku=r.fnsku,
                asin=r.asin,
                msku=r.msku,
                title=r.title,
                event_type=r.event_type,
                reference_id=r.reference_id,
                quantity=r.quantity,
                fulfillment_center=r.fulfillment_center,
                disposition=r.disposition,
                reason=r.reason,
                country=r.country,
                reconciled_quantity=r.reconciled_quantity,
                unreconciled_quantity=r.unreconciled_quantity,
                date_and_time=r.date_and_time,
                store=r.store,
                batch_id=r.batch_id,
            )
        )
    return rows


# ─── 11. Summary 原始行查询（BLF-428 前端重构：每日水位账） ─────────────────────


def get_ledger_summary_rows(
    db: Session,
    project_id: int,
    start: date,
    end: date,
    msku: str | None = None,
    location: str | None = None,
    disposition: str | None = None,
    country: str | None = None,
    limit: int | None = 5000,
) -> list[LedgerSummaryRow]:
    """Daily water-level rows from the Summary view, newest first.

    Mirrors ``get_ledger_detail_rows``: same period contract, optional
    dimension filters, capped result. The Summary view is the truth source
    (1 row = 1 FNSKU × FC × Disposition × Date snapshot, sparse).
    ``country`` 走 Project.country 门（summary 表无 country 列）。
    """
    if not _project_country_matches(db, project_id, country):
        return []
    filters = [
        InventoryLedgerSummary.project_id == project_id,
        InventoryLedgerSummary.date >= start,
        InventoryLedgerSummary.date <= end,
    ]
    if msku:
        filters.append(InventoryLedgerSummary.msku == msku)
    if location:
        filters.append(InventoryLedgerSummary.location == location)
    if disposition:
        filters.append(InventoryLedgerSummary.disposition == disposition)

    stmt = (
        select(InventoryLedgerSummary)
        .where(*filters)
        .order_by(
            InventoryLedgerSummary.date.desc(),
            InventoryLedgerSummary.id.desc(),
        )
    )
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = []
    for r in db.execute(stmt).scalars().all():
        rows.append(
            LedgerSummaryRow(
                id=r.id,
                date=r.date,
                fnsku=r.fnsku,
                asin=r.asin,
                msku=r.msku,
                title=r.title,
                disposition=r.disposition,
                location=r.location,
                starting_balance=r.starting_balance,
                in_transit_between=r.in_transit_between,
                receipts=r.receipts,
                customer_shipments=r.customer_shipments,
                customer_returns=r.customer_returns,
                vendor_returns=r.vendor_returns,
                warehouse_transfer_io=r.warehouse_transfer_io,
                found=r.found,
                lost=r.lost,
                damaged=r.damaged,
                disposed=r.disposed,
                other_events=r.other_events,
                ending_balance=r.ending_balance,
                unknown_events=r.unknown_events,
                store=r.store,
                batch_id=r.batch_id,
            )
        )
    return rows


def list_ingest_batches(
    db: Session,
    project_id: int,
    limit: int = 100,
    country: str | None = None,
    report_month: date | None = None,
) -> list[InventoryLedgerIngestBatch]:
    """List recent ingest batches for a project, newest first.

    ``country`` 走 Project.country 门（批次表无 country 列）。
    """
    if not _project_country_matches(db, project_id, country):
        return []
    filters = [InventoryLedgerIngestBatch.project_id == project_id]
    if report_month is not None:
        filters.append(InventoryLedgerIngestBatch.report_month == report_month)
    stmt = (
        select(InventoryLedgerIngestBatch)
        .where(*filters)
        .order_by(InventoryLedgerIngestBatch.loaded_at.desc())
        .limit(limit)
    )
    return list(db.execute(stmt).scalars().all())


# ─── 11. check_ledger_consistency（跨表对账） ─────────────────────────────────


def check_ledger_consistency(
    db: Session,
    project_id: int,
    report_month: date,
    country: str | None = None,
) -> ConsistencyCheckResult:
    """Cross-table reconciliation for a full month.

    ``country`` 走 Project.country 门（summary 表无 country 列；国家不符
    直接 PENDING，避免跨站点真值表误报）。

    Method (matches the 4 rounds of manual reconciliation that hit 0 mismatch
    on real data): per (msku, location, disposition) —

        sum(detail.quantity) == (last summary ending_balance) - (first summary starting_balance)

    Only keys present in BOTH views are compared; a key that exists in only
    one view is skipped (Amazon writes sparse ledgers — a transfer row may
    exist in detail but not in summary for that date, etc.).
    """
    if not _project_country_matches(db, project_id, country):
        return ConsistencyCheckResult(
            report_month=report_month,
            country=country,
            status="PENDING",
            mismatch_count=0,
            mismatches=[],
            checked_at=datetime.now(timezone.utc),
        )

    summary_exists = (
        db.execute(
            select(func.count())
            .select_from(InventoryLedgerSummary)
            .where(
                InventoryLedgerSummary.project_id == project_id,
                InventoryLedgerSummary.report_month == report_month,
            )
        ).scalar()
        or 0
    )
    detail_exists = (
        db.execute(
            select(func.count())
            .select_from(InventoryLedgerDetail)
            .where(
                InventoryLedgerDetail.project_id == project_id,
                InventoryLedgerDetail.report_month == report_month,
            )
        ).scalar()
        or 0
    )

    if not summary_exists and not detail_exists:
        return ConsistencyCheckResult(
            report_month=report_month,
            country=country,
            status="PENDING",
            mismatch_count=0,
            mismatches=[],
            checked_at=datetime.now(timezone.utc),
        )

    # ── Summary side: first-row starting & last-row ending per group ──
    first_rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerSummary.msku,
                InventoryLedgerSummary.location,
                InventoryLedgerSummary.disposition,
            ],
            order_by=InventoryLedgerSummary.date.asc(),
        )
        .label("rn")
    )
    first_subq = (
        select(InventoryLedgerSummary, first_rn)
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.report_month == report_month,
        )
        .subquery()
    )
    last_rn = (
        func.row_number()
        .over(
            partition_by=[
                InventoryLedgerSummary.msku,
                InventoryLedgerSummary.location,
                InventoryLedgerSummary.disposition,
            ],
            order_by=InventoryLedgerSummary.date.desc(),
        )
        .label("rn")
    )
    last_subq = (
        select(InventoryLedgerSummary, last_rn)
        .where(
            InventoryLedgerSummary.project_id == project_id,
            InventoryLedgerSummary.report_month == report_month,
        )
        .subquery()
    )
    summary_stmt = (
        select(
            first_subq.c.msku,
            first_subq.c.location,
            first_subq.c.disposition,
            first_subq.c.starting_balance.label("first_starting"),
            last_subq.c.ending_balance.label("last_ending"),
        )
        .join(
            last_subq,
            (first_subq.c.msku == last_subq.c.msku)
            & (first_subq.c.location == last_subq.c.location)
            & (first_subq.c.disposition == last_subq.c.disposition),
        )
        .where(first_subq.c.rn == 1, last_subq.c.rn == 1)
    )
    summary_delta: dict[tuple[str, str, str], int] = {}
    for r in db.execute(summary_stmt).all():
        delta = int(r.last_ending or 0) - int(r.first_starting or 0)
        summary_delta[(r.msku, r.location, r.disposition)] = delta

    # ── Detail side: sum(quantity) per (msku, fc, disposition) ──
    detail_stmt = (
        select(
            InventoryLedgerDetail.msku,
            InventoryLedgerDetail.fulfillment_center,
            InventoryLedgerDetail.disposition,
            func.sum(InventoryLedgerDetail.quantity).label("detail_sum"),
        )
        .where(
            InventoryLedgerDetail.project_id == project_id,
            InventoryLedgerDetail.report_month == report_month,
        )
        .group_by(
            InventoryLedgerDetail.msku,
            InventoryLedgerDetail.fulfillment_center,
            InventoryLedgerDetail.disposition,
        )
    )
    detail_sum: dict[tuple[str, str, str], int] = {}
    for r in db.execute(detail_stmt).all():
        detail_sum[(r.msku, r.fulfillment_center, r.disposition)] = int(
            r.detail_sum or 0
        )

    # ── Compare on intersection ──
    mismatches: list[ConsistencyMismatch] = []
    for key, detail_qty in sorted(detail_sum.items()):
        summary_delta_qty = summary_delta.get(key)
        if summary_delta_qty is None:
            continue  # key only in detail (sparse ledger) — not a mismatch
        if detail_qty != summary_delta_qty:
            mismatches.append(
                ConsistencyMismatch(
                    msku=key[0],
                    location=key[1],
                    disposition=key[2],
                    detail_quantity=detail_qty,
                    summary_delta=summary_delta_qty,
                    diff=detail_qty - summary_delta_qty,
                )
            )

    return ConsistencyCheckResult(
        report_month=report_month,
        country=country,
        status="MISMATCH" if mismatches else "OK",
        mismatch_count=len(mismatches),
        mismatches=mismatches,
        checked_at=datetime.now(timezone.utc),
    )


# ─── 12. ingest_ledger_csv（双轨导入） ────────────────────────────────────────

# Summary COPY column order (must match staging DDL + model columns minus
# id / loaded_at / batch_id-overridden-in-copy, which are DB-managed).
_SUMMARY_COPY_COLUMNS: tuple[str, ...] = (
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
    "batch_id",
)

_DETAIL_COPY_COLUMNS: tuple[str, ...] = (
    "project_id",
    "report_month",
    "date",
    "fnsku",
    "asin",
    "msku",
    "title",
    "event_type",
    "reference_id",
    "quantity",
    "fulfillment_center",
    "disposition",
    "reason",
    "country",
    "reconciled_quantity",
    "unreconciled_quantity",
    "date_and_time",
    "store",
    "batch_id",
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


def _build_copy_payload(full_rows: list[dict], columns: tuple[str, ...]) -> bytes:
    """Serialize parsed CSV rows to a single COPY payload (UTF-8 text)."""
    out = io.StringIO()
    for row in full_rows:
        cells = [_format_copy_value(row.get(col)) for col in columns]
        out.write("\t".join(cells))
        out.write("\n")
    return out.getvalue().encode("utf-8")


def _upsert_batch(
    db: Session,
    *,
    project_id: int,
    report_month: date,
    source_filename: str,
    file_hash: str,
    file_size_bytes: int,
    file_kind: str,
    loaded_by: str | None,
) -> InventoryLedgerIngestBatch:
    """Find-or-create the batch row for this upload (natural-key upsert).

    Same (project, month, filename, hash) → same batch (idempotent re-upload
    of the identical file). A re-upload that hits a terminal ``success`` batch
    returns it unchanged; a retry after ``failed`` reuses the row.
    """
    existing = (
        db.execute(
            select(InventoryLedgerIngestBatch).where(
                InventoryLedgerIngestBatch.project_id == project_id,
                InventoryLedgerIngestBatch.report_month == report_month,
                InventoryLedgerIngestBatch.source_filename == source_filename,
                InventoryLedgerIngestBatch.file_hash == file_hash,
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        return existing

    batch = InventoryLedgerIngestBatch(
        project_id=project_id,
        report_month=report_month,
        source_filename=source_filename,
        file_hash=file_hash,
        file_size_bytes=file_size_bytes,
        file_kind=file_kind,
        loaded_by=loaded_by,
        status="pending",
    )
    db.add(batch)
    db.flush()  # materialise batch.id for the child rows
    return batch


def _mark_batch_failed(db: Session, batch_id: int, error_message: str) -> None:
    db.execute(
        InventoryLedgerIngestBatch.__table__.update()
        .where(InventoryLedgerIngestBatch.id == batch_id)
        .values(
            status="failed",
            error_message=error_message[:2000],
            completed_at=datetime.now(timezone.utc),
        )
    )


def _ingest_summary_copy(
    db: Session,
    full_rows: list[dict],
    batch_id: int,
) -> int:
    """BEL-417 COPY path for the summary table (upsert by natural key)."""
    if not full_rows:
        return 0

    for row in full_rows:
        row["batch_id"] = batch_id
    payload = _build_copy_payload(full_rows, _SUMMARY_COPY_COLUMNS)

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
        '"batch_id" INTEGER',
    ]
    staging_ddl = (
        "CREATE TEMP TABLE IF NOT EXISTS staging_inventory_ledger_summary ("
        + ", ".join(staging_column_defs)
        + ") ON COMMIT DROP"
    )
    staging_columns = ", ".join(f'"{c}"' for c in _SUMMARY_COPY_COLUMNS)
    insert_columns_sql = ", ".join(f'"{c}"' for c in _SUMMARY_COPY_COLUMNS)
    update_set_sql = ", ".join(
        f'"{c}" = EXCLUDED."{c}"'
        for c in _SUMMARY_COPY_COLUMNS
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

    sa_conn = db.connection()
    raw_conn = sa_conn.connection.dbapi_connection
    if raw_conn is None:
        raw_conn = db.bind.raw_connection()  # type: ignore[union-attr]
    cur = raw_conn.cursor()
    try:
        cur.execute(staging_ddl)
        with cur.copy(
            f"COPY staging_inventory_ledger_summary ({staging_columns}) "
            f"FROM STDIN WITH (FORMAT text)"
        ) as copy:
            copy.write(payload)
        upsert_sql = (
            f"INSERT INTO inventory_ledger_summary ({insert_columns_sql}) "  # noqa: S608
            f"SELECT {insert_columns_sql} FROM staging_inventory_ledger_summary "
            f"ON CONFLICT {conflict_cols} DO UPDATE SET {update_set_sql}"
        )
        cur.execute(upsert_sql)
    finally:
        cur.close()

    return len(full_rows)


def _ingest_detail_copy(
    db: Session,
    full_rows: list[dict],
    batch_id: int,
) -> int:
    """COPY path for the detail table (plain insert, append-only)."""
    if not full_rows:
        return 0

    for row in full_rows:
        row["batch_id"] = batch_id
    payload = _build_copy_payload(full_rows, _DETAIL_COPY_COLUMNS)

    staging_column_defs: list[str] = [
        '"project_id" INTEGER',
        '"report_month" DATE',
        '"date" DATE',
        '"fnsku" VARCHAR(20)',
        '"asin" VARCHAR(15)',
        '"msku" VARCHAR(30)',
        '"title" VARCHAR(500)',
        '"event_type" VARCHAR(40)',
        '"reference_id" VARCHAR(64)',
        '"quantity" INTEGER',
        '"fulfillment_center" VARCHAR(10)',
        '"disposition" VARCHAR(20)',
        '"reason" VARCHAR(20)',
        '"country" VARCHAR(10)',
        '"reconciled_quantity" INTEGER',
        '"unreconciled_quantity" INTEGER',
        '"date_and_time" TIMESTAMPTZ',
        '"store" VARCHAR(50)',
        '"batch_id" INTEGER',
    ]
    staging_ddl = (
        "CREATE TEMP TABLE IF NOT EXISTS staging_inventory_ledger_detail ("
        + ", ".join(staging_column_defs)
        + ") ON COMMIT DROP"
    )
    staging_columns = ", ".join(f'"{c}"' for c in _DETAIL_COPY_COLUMNS)
    insert_columns_sql = ", ".join(f'"{c}"' for c in _DETAIL_COPY_COLUMNS)

    sa_conn = db.connection()
    raw_conn = sa_conn.connection.dbapi_connection
    if raw_conn is None:
        raw_conn = db.bind.raw_connection()  # type: ignore[union-attr]
    cur = raw_conn.cursor()
    try:
        cur.execute(staging_ddl)
        with cur.copy(
            f"COPY staging_inventory_ledger_detail ({staging_columns}) "
            f"FROM STDIN WITH (FORMAT text)"
        ) as copy:
            copy.write(payload)
        cur.execute(
            f"INSERT INTO inventory_ledger_detail ({insert_columns_sql}) "  # noqa: S608
            f"SELECT {insert_columns_sql} FROM staging_inventory_ledger_detail"
        )
    finally:
        cur.close()

    return len(full_rows)


def _ingest_rows_legacy(db: Session, model, full_rows: list[dict]) -> int:
    """Non-Postgres fallback: per-batch SQLAlchemy inserts (upsert for summary).

    Summary uses ``on_conflict_do_update`` on its natural-key constraint;
    detail is append-only.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    batch_size = 500
    total = 0
    for i in range(0, len(full_rows), batch_size):
        chunk = full_rows[i : i + batch_size]
        stmt = pg_insert(model).values(chunk)
        if model is InventoryLedgerSummary:
            update_cols = {
                c.name: stmt.excluded[c.name]
                for c in model.__table__.columns
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
                constraint="uq_ledger_summary_natural_key",
                set_=update_cols,
            )
        db.execute(stmt)
        total += len(chunk)
    return total


def ingest_ledger_csv(
    db: Session,
    project_id: int,
    csv_content: str | bytes,
    filename: str = "",
    loaded_by: str | None = None,
    expected_kind: Literal["summary", "detail"] | None = None,
) -> int:
    """Parse an Amazon Inventory Ledger CSV and write to the dual-table schema.

    Auto-detects Summary vs Detailed by headers; creates/updates the ingest
    batch row (natural-key dedupe on file identity); writes rows with the
    batch id attached.

    ``expected_kind`` is the typed ingestion contract (HTTP 入库层在收到
    独立报表类型时传入)：声明类型与表头检测结果不一致直接抛
    ``ValueError``（消息含"类型与文件内容不一致"），不重新猜测目标视图。
    为 ``None`` 时保持旧行为——按表头自动识别（旧 ``inventory_ledger``
    兼容路径）。

    Returns the number of rows written (0 if the identical file was already
    ingested — idempotent re-upload).
    """
    if isinstance(csv_content, bytes):
        csv_content = csv_content.decode("utf-8-sig")

    raw_bytes = csv_content.encode("utf-8")
    file_hash = hashlib.sha256(raw_bytes).hexdigest()
    file_size_bytes = len(raw_bytes)

    reader = csv.DictReader(io.StringIO(csv_content))
    if not reader.fieldnames:
        raise ValueError("Empty CSV file")

    kind = detect_file_kind(list(reader.fieldnames))

    if kind == "detail":
        column_map, int_cols, required = (
            DETAIL_CSV_COLUMN_MAP,
            DETAIL_INT_COLUMNS,
            DETAIL_REQUIRED_COLUMNS,
        )
    elif kind == "summary":
        column_map, int_cols, required = (
            SUMMARY_CSV_COLUMN_MAP,
            SUMMARY_INT_COLUMNS,
            SUMMARY_REQUIRED_COLUMNS,
        )
    else:
        # Not identifiable by header markers — try to still give an
        # actionable missing-column error when the file carries any
        # summary/detail-ish marker (a broken export, not a foreign file).
        guessed = _guess_kind_for_validation(list(reader.fieldnames))
        if guessed == "summary":
            column_map, int_cols, required = (
                SUMMARY_CSV_COLUMN_MAP,
                SUMMARY_INT_COLUMNS,
                SUMMARY_REQUIRED_COLUMNS,
            )
            kind = "summary"
        elif guessed == "detail":
            column_map, int_cols, required = (
                DETAIL_CSV_COLUMN_MAP,
                DETAIL_INT_COLUMNS,
                DETAIL_REQUIRED_COLUMNS,
            )
            kind = "detail"
        else:
            raise ValueError(
                "无法识别报表类型：列头既不是 Summary 视图（Starting/Ending "
                "Warehouse Balance）也不是 Detailed 视图（Event Type / Quantity）。"
            )

    # 类型化契约：声明类型必须与表头检测结果一致，拒绝时不再重新猜测。
    if expected_kind is not None and kind != expected_kind:
        raise ValueError(
            f"报表类型与文件内容不一致：声明为 {expected_kind}，实际检测为 {kind}"
        )

    raw_headers = [_normalize_header(h) for h in reader.fieldnames]
    header_map = {raw: column_map.get(raw) for raw in raw_headers}
    missing = required - set(raw_headers)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    # Parse rows
    rows: list[dict] = []
    all_dates: list[date] = []
    failed_validation = 0
    for raw_row in reader:
        row: dict = {}
        try:
            for raw_key, value in raw_row.items():
                norm_key = _normalize_header(raw_key)
                model_attr = header_map.get(norm_key)
                if model_attr is None:
                    continue
                value = (value or "").strip()
                if model_attr in int_cols:
                    row[model_attr] = int(value) if value else 0
                elif model_attr == "date":
                    row["date"] = _parse_csv_date(value)
                    all_dates.append(row["date"])
                elif model_attr == "date_and_time":
                    row["date_and_time"] = _parse_date_and_time(value)
                elif model_attr == "disposition":
                    row["disposition"] = value or "SELLABLE"
                elif model_attr == "fulfillment_center" or model_attr == "location":
                    row[model_attr] = value or "UNKNOWN"
                else:
                    row[model_attr] = value or None
            if "date" in row and "msku" in row:
                rows.append(row)
            else:
                failed_validation += 1
        except (ValueError, TypeError):
            failed_validation += 1

    if not rows:
        if failed_validation:
            raise ValueError(
                "库存分类账解析失败：所有数据行均未通过校验，请检查 Date 列"
                "（支持 MM/DD/YYYY 或 MM/YYYY）及数值列格式。"
            )
        return 0

    report_month = _extract_report_month(filename, all_dates)

    # Batch row first (dedupe on file identity) — if the identical file was
    # already ingested successfully, skip re-writing entirely.
    batch = _upsert_batch(
        db,
        project_id=project_id,
        report_month=report_month,
        source_filename=filename,
        file_hash=file_hash,
        file_size_bytes=file_size_bytes,
        file_kind=kind,
        loaded_by=loaded_by,
    )
    if batch.status == "success":
        return 0

    # Mark running + record parse counts on the batch.
    batch.status = "running"
    batch.rows_parsed = len(rows)
    batch.rows_failed_validation = failed_validation
    db.flush()

    full_rows = [
        {**row, "project_id": project_id, "report_month": report_month} for row in rows
    ]

    bind = db.bind
    is_postgres = bool(bind and getattr(bind.dialect, "name", "") == "postgresql")
    try:
        if kind == "summary":
            if is_postgres:
                written = _ingest_summary_copy(db, full_rows, batch.id)
            else:
                written = _ingest_rows_legacy(db, InventoryLedgerSummary, full_rows)
            batch.rows_written_summary = written
        else:
            if is_postgres:
                written = _ingest_detail_copy(db, full_rows, batch.id)
            else:
                written = _ingest_rows_legacy(db, InventoryLedgerDetail, full_rows)
            batch.rows_written_detail = written
        batch.status = "success"
        batch.completed_at = datetime.now(timezone.utc)
        db.flush()
        return written
    except Exception as exc:
        _mark_batch_failed(db, batch.id, str(exc))
        db.flush()
        raise
