"""External schemas for the Return Analysis endpoints.

BEL-374 — exposes ``GET /api/v1/external/projects/{id}/return-analysis[-raw]``.

Design notes (BEL-372 拍板):

* Aggregate rows are deliberately slim — one row per SKU carrying the snapshot
  pre-aggregated metrics + ``risk_level`` (Wilson 95% 下界).
* Sensitive fields are **never** present in either response:
    * ``customer_comments`` — privacy (PII / free-form complaint text)
    * ``raw_row``          — debug-only blob (Amazon CSV verbatim)
* ``estimated_loss_amount`` is not implemented in v1 (P1 基建 + scope gating
  时再补; see BEL-372 decision §3).
* The shape is intentionally different from the internal
  ``ReturnAnalysisResponse``: external callers ask per-SKU, internal callers
  ask per-day. The two share the same source tables, but external surfaces
  the snapshot rollup that drives agent / BI queries.
"""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.external.common import PeriodInfo


# ---------------------------------------------------------------------------
# Aggregate row — one per SKU within (project, country, date range).
# 12 fields exposed (matches the AGG_WHITELIST contract).
# ---------------------------------------------------------------------------


class ReturnAnalysisAggregateRow(BaseModel):
    """Per-SKU rollup from ``analysis_return_aggregates``.

    Snapshot is daily grain: the endpoint collapses the per-day rows to a
    single per-SKU rollup across the requested ``period``.

    Fields mirror the AGG_WHITELIST contract in
    ``backend/app/api/v1/endpoints/external/_whitelist.py`` — adding a
    field here **requires** extending that whitelist, and vice versa.
    """

    model_config = ConfigDict(from_attributes=True)

    sku: Optional[str] = None
    return_count: int = 0
    return_quantity: int = 0
    sales_quantity: int = 0
    return_rate: float = 0.0  # percent (0.0 ~ 100.0)
    wilson_lower: float = 0.0  # percent, audit / 阈值依据
    cycle_avg_days: Optional[float] = None
    cycle_min_days: Optional[int] = None
    cycle_max_days: Optional[int] = None
    reason_top1: Optional[str] = None
    disposition_top1: Optional[str] = None
    dominant_fc_id: Optional[str] = None
    # risk_level 来自快照（已计算好）：critical/warning/normal/no_data
    # 销量门槛 15 + Wilson 下界判定见 ``app.utils.stats.compute_risk_level``
    risk_level: str = "normal"


class ReturnAnalysisAggregateSummary(BaseModel):
    """Top-level totals across all returned SKU rollups.

    Mirrors the internal ``ReturnAnalysisSummary`` (without the
    per-distribution rows that drive the dashboard): external callers
    get the same headline numbers, stripped of any privacy-sensitive
    fields.
    """

    model_config = ConfigDict(from_attributes=True)

    total_rows: int = 0
    total_return_count: int = 0
    total_return_quantity: int = 0
    total_sales_quantity: int = 0
    overall_return_rate: float = 0.0  # percent
    overall_risk_level: str = "no_data"
    # 多少 SKU 在 critical / warning 状态（agent 决策用）
    critical_sku_count: int = 0
    warning_sku_count: int = 0


class ReturnAnalysisAggregateResponse(BaseModel):
    """Wrapper for the aggregate endpoint."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[ReturnAnalysisAggregateRow] = Field(default_factory=list)
    summary: ReturnAnalysisAggregateSummary


# ---------------------------------------------------------------------------
# Raw row — one per AnalysisReturnRow, with sensitive fields stripped.
# 12 fields exposed (matches the ROW_WHITELIST contract).
# ---------------------------------------------------------------------------


class ReturnAnalysisRawRow(BaseModel):
    """Per-event raw row from ``analysis_return_rows``.

    Fields mirror the ROW_WHITELIST contract in
    ``backend/app/api/v1/endpoints/external/_whitelist.py`` — adding a
    field here **requires** extending that whitelist, and vice versa.

    Explicitly excluded:

    * ``customer_comments`` — PII / free-form complaint text (永远不返回)
    * ``raw_row``           — debug-only blob (Amazon CSV verbatim)
    * ``fnsku``             — internal Amazon fulfillment identifier (no
      analytic value to external callers; trim surface)
    * ``license_plate_number`` — internal LPN; same rationale
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    return_date: str  # ISO YYYY-MM-DD
    order_id: str
    sku: str
    asin: Optional[str] = None
    product_name: Optional[str] = None
    quantity: int
    fulfillment_center_id: Optional[str] = None
    detailed_disposition: str
    reason: str
    status: str
    original_return_datetime: str


class ReturnAnalysisRawResponse(BaseModel):
    """Wrapper for the raw endpoint.

    No project_name / summary_text — raw endpoint exposes the row list
    + the date range; BI tools handle their own summaries.
    """

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[ReturnAnalysisRawRow] = Field(default_factory=list)
    summary: dict = Field(default_factory=dict)


__all__ = [
    "ReturnAnalysisAggregateRow",
    "ReturnAnalysisAggregateSummary",
    "ReturnAnalysisAggregateResponse",
    "ReturnAnalysisRawRow",
    "ReturnAnalysisRawResponse",
]
