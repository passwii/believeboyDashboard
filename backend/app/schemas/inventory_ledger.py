"""Pydantic schemas for inventory ledger API responses."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel


class SkuMonthEom(BaseModel):
    """Per-SKU end-of-period inventory summary."""

    msku: str
    title: str | None = None
    qty_eom: int
    sellable_qty: int = 0
    damaged_qty: int = 0
    prev_qty_eom: int | None = None
    change: int | None = None


class DispositionSummary(BaseModel):
    """Disposition breakdown for a period."""

    disposition: str
    qty_eom: int
    pct_of_total: float


class ReceiptCluster(BaseModel):
    """A receipt cluster: same date + location receiving multiple SKUs."""

    date: date
    location: str
    sku_set: str
    sku_count: int
    total_qty: int
    cluster_id: str


class SkuMonthEvents(BaseModel):
    """Per-SKU event totals for a period."""

    msku: str
    title: str | None = None
    total_receipts: int = 0
    total_shipments: int = 0
    total_returns: int = 0
    total_damaged: int = 0
    total_lost: int = 0
    total_disposed: int = 0
    total_found: int = 0
    total_vendor_returns: int = 0
    total_transfer: int = 0
    total_other: int = 0
    net_change: int = 0


class LocationDetail(BaseModel):
    """SKU × Location × Disposition end-of-period detail."""

    msku: str
    title: str | None = None
    location: str
    disposition: str
    qty_eom: int


class IntegrityMismatch(BaseModel):
    """A single cross-month continuity mismatch."""

    msku: str
    location: str
    disposition: str
    prev_ending: int
    curr_starting: int
    diff: int


class IntegrityCheckResult(BaseModel):
    """Cross-month ledger integrity check result."""

    report_month: date
    status: Literal["OK", "MISMATCH", "PENDING"]
    mismatch_count: int
    mismatches: list[IntegrityMismatch] = []
    checked_at: datetime


class MonthlySnapshotResponse(BaseModel):
    """Full monthly snapshot: SKU EOM + disposition summary + integrity."""

    report_month: date
    sku_count: int
    total_qty: int
    disposition_summary: list[DispositionSummary] = []
    skus: list[SkuMonthEom] = []
    integrity: IntegrityCheckResult | None = None


class EventsResponse(BaseModel):
    """SKU event flow response."""

    report_month: date
    skus: list[SkuMonthEvents] = []


class ReceiptClustersResponse(BaseModel):
    """Receipt clusters response."""

    report_month: date
    clusters: list[ReceiptCluster] = []


class LocationDetailResponse(BaseModel):
    """Location detail response."""

    report_month: date
    rows: list[LocationDetail] = []


class MonthsResponse(BaseModel):
    """Available months list."""

    project_id: int
    months: list[date] = []


class TrendMonthItem(BaseModel):
    """Aggregated metrics for a single month in the trend."""

    report_month: str  # YYYY-MM
    sku_count: int = 0
    total_qty_eom: int = 0
    total_receipts: int = 0
    total_shipments: int = 0
    total_returns: int = 0
    total_damaged: int = 0
    total_lost: int = 0
    total_disposed: int = 0
    damaged_pct: float = 0.0


class TrendResponse(BaseModel):
    """Multi-month trend response."""

    project_id: int
    months: list[TrendMonthItem] = []


class LedgerDetailRow(BaseModel):
    """A single event-level row from the Amazon Detailed view."""

    id: int
    date: date
    fnsku: str | None = None
    asin: str | None = None
    msku: str
    title: str | None = None
    event_type: str
    reference_id: str | None = None
    quantity: int
    fulfillment_center: str
    disposition: str
    reason: str | None = None
    country: str | None = None
    reconciled_quantity: int | None = None
    unreconciled_quantity: int | None = None
    date_and_time: datetime | None = None
    store: str | None = None
    batch_id: int | None = None


class LedgerDetailResponse(BaseModel):
    """Event-level detail rows for a period."""

    report_month: date
    rows: list[LedgerDetailRow] = []


class IngestBatchInfo(BaseModel):
    """One CSV ingest run — traceability metadata (排查版本用)."""

    id: int
    project_id: int
    report_month: date
    source_filename: str
    file_hash: str
    file_size_bytes: int
    file_kind: str  # summary / detail / unknown
    loaded_by: str | None = None
    loaded_at: datetime
    completed_at: datetime | None = None
    status: str  # pending / running / success / failed / partial
    rows_parsed: int = 0
    rows_written_summary: int = 0
    rows_written_detail: int = 0
    rows_skipped_duplicate: int = 0
    rows_failed_validation: int = 0
    error_message: str | None = None
    consistency_check: str | None = None  # ok / mismatch / not_run
    consistency_mismatch_count: int = 0


class IngestBatchesResponse(BaseModel):
    """Ingest batch list for a project."""

    project_id: int
    batches: list[IngestBatchInfo] = []


class ConsistencyMismatch(BaseModel):
    """A single cross-table reconciliation mismatch."""

    msku: str
    location: str
    disposition: str
    detail_quantity: int
    summary_delta: int
    diff: int


class ConsistencyCheckResult(BaseModel):
    """Cross-table (detail vs summary) reconciliation result."""

    report_month: date
    status: Literal["OK", "MISMATCH", "PENDING"]
    mismatch_count: int
    mismatches: list[ConsistencyMismatch] = []
    checked_at: datetime
