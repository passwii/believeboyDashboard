"""Pydantic schemas for inventory ledger API responses."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field


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
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    status: Literal["OK", "MISMATCH", "PENDING"]
    mismatch_count: int
    mismatches: list[IntegrityMismatch] = []
    checked_at: datetime


class MonthlySnapshotResponse(BaseModel):
    """Full monthly snapshot: SKU EOM + disposition summary + integrity."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    sku_count: int
    total_qty: int
    disposition_summary: list[DispositionSummary] = []
    skus: list[SkuMonthEom] = []
    integrity: IntegrityCheckResult | None = None


class EventsResponse(BaseModel):
    """SKU event flow response."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    skus: list[SkuMonthEvents] = []


class ReceiptClustersResponse(BaseModel):
    """Receipt clusters response."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    clusters: list[ReceiptCluster] = []


class LocationDetailResponse(BaseModel):
    """Location detail response."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    rows: list[LocationDetail] = []


class MonthsResponse(BaseModel):
    """Available months list."""

    project_id: int
    country: str | None = Field(default=None, description="国家/地区（归一化）")
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
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    months: list[TrendMonthItem] = []


class LedgerSummaryRow(BaseModel):
    """A single daily water-level row from the Amazon Summary view.

    1 row = 1 (FNSKU × FC × Disposition × Date) snapshot. Sparse ledger:
    Amazon only emits a row when the combination changed that day.

    字段英文列名 = Amazon Summary 一览视图表头；中文 label 对照见
    docs/superpowers/specs/2026-08-14-inventory-ledger-field-glossary.md。
    """

    id: int = Field(description="记录 ID")
    date: Annotated[date, Field(description="日期")]
    fnsku: str | None = Field(default=None, description="FNSKU")
    asin: str | None = Field(default=None, description="ASIN")
    msku: str = Field(description="MSKU")
    title: str | None = Field(default=None, description="品名")
    disposition: str = Field(description="处置状态")
    location: str = Field(description="仓库")
    starting_balance: int = Field(default=0, description="期初库存")
    in_transit_between: int = Field(default=0, description="在途库存")
    receipts: int = Field(default=0, description="入库")
    customer_shipments: int = Field(default=0, description="客户发货")
    customer_returns: int = Field(default=0, description="客户退货")
    vendor_returns: int = Field(default=0, description="供应商退货")
    warehouse_transfer_io: int = Field(default=0, description="仓库调拨")
    found: int = Field(default=0, description="盘盈")
    lost: int = Field(default=0, description="盘亏")
    damaged: int = Field(default=0, description="损坏")
    disposed: int = Field(default=0, description="报废")
    other_events: int = Field(default=0, description="其他事件")
    ending_balance: int = Field(default=0, description="期末库存")
    unknown_events: int = Field(default=0, description="未知事件")
    store: str | None = Field(default=None, description="店铺")
    batch_id: int | None = Field(default=None, description="上传批次 ID")


class LedgerSummaryResponse(BaseModel):
    """Daily water-level rows for a period."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    rows: list[LedgerSummaryRow] = []


class LedgerDetailRow(BaseModel):
    """A single event-level row from the Amazon Detailed view.

    字段英文列名 = Amazon Detailed 详细视图表头；中文 label 对照见
    docs/superpowers/specs/2026-08-14-inventory-ledger-field-glossary.md。
    """

    id: int = Field(description="记录 ID")
    date: Annotated[date, Field(description="日期")]
    fnsku: str | None = Field(default=None, description="FNSKU")
    asin: str | None = Field(default=None, description="ASIN")
    msku: str = Field(description="MSKU")
    title: str | None = Field(default=None, description="品名")
    event_type: str = Field(description="事件类型")
    reference_id: str | None = Field(default=None, description="参考编号")
    quantity: int = Field(description="数量")
    fulfillment_center: str = Field(description="履约中心")
    disposition: str = Field(description="处置状态")
    reason: str | None = Field(default=None, description="原因")
    country: str | None = Field(default=None, description="国家/地区")
    reconciled_quantity: int | None = Field(default=None, description="已对账数量")
    unreconciled_quantity: int | None = Field(default=None, description="未对账数量")
    date_and_time: datetime | None = Field(default=None, description="日期时间")
    store: str | None = Field(default=None, description="店铺")
    batch_id: int | None = Field(default=None, description="上传批次 ID")


class LedgerDetailResponse(BaseModel):
    """Event-level detail rows for a period."""

    report_month: date
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    rows: list[LedgerDetailRow] = []


class IngestBatchInfo(BaseModel):
    """One CSV ingest run — traceability metadata (排查版本用)."""

    model_config = {"from_attributes": True}

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
    country: str | None = Field(default=None, description="国家/地区（归一化）")
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
    country: str | None = Field(default=None, description="国家/地区（归一化）")
    status: Literal["OK", "MISMATCH", "PENDING"]
    mismatch_count: int
    mismatches: list[ConsistencyMismatch] = []
    checked_at: datetime
