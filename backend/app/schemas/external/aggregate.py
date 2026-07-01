"""Aggregate response schemas for the external API.

One ``*AggregateRow`` per row table + one ``AggregateResponse`` wrapper
+ ``AggregateSummary`` shared structure.

All percentage fields (ctr / cvr / acos) are **percent values** — e.g.
``acos: 37.08`` means 37.08%. All money fields (spend / sales_7d / cpc /
budget) carry 2 decimal places. roas is a plain ratio.
"""
from __future__ import annotations

from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.external.common import PeriodInfo


# ---------------------------------------------------------------------------
# Shared summary block
# ---------------------------------------------------------------------------


class AggregateSummary(BaseModel):
    """Top-level totals across all aggregated rows in the response.

    ``overall_acos`` / ``overall_roas`` are weighted: the same formula
    applied to the *total* spend / sales, not an average of per-row rates.
    """

    model_config = ConfigDict(from_attributes=True)

    total_rows: int
    total_spend: float
    total_sales: float
    total_orders: int
    overall_acos: float
    overall_roas: float


class RawSummary(BaseModel):
    """Top-level metadata for a raw response — total row count + date range."""

    model_config = ConfigDict(from_attributes=True)

    total_rows: int
    date_range: list[str] = Field(default_factory=list)  # [start, end]


# ---------------------------------------------------------------------------
# Generic aggregate / raw response wrappers
# ---------------------------------------------------------------------------


_RowT = TypeVar("_RowT")


class AggregateResponse(BaseModel, Generic[_RowT]):
    """Wrapper for aggregate endpoints. ``data`` carries one ``*AggregateRow``
    per business key (campaign / search-term / placement / ...)."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[_RowT]
    summary: AggregateSummary


class RawResponse(BaseModel, Generic[_RowT]):
    """Wrapper for raw endpoints. ``data`` carries the original row list
    (no aggregation, no per-row formatting beyond what the ``*RawRow``
    schema declares)."""

    model_config = ConfigDict(from_attributes=True)

    project_id: int
    period: PeriodInfo
    country: str
    data: List[_RowT]
    summary: RawSummary


# ---------------------------------------------------------------------------
# Per-table aggregate rows (10)
# Fields mirror spec §聚合规则 / §字段格式化.
# ---------------------------------------------------------------------------


class AdCampaignAggregateRow(BaseModel):
    """Aggregate by ``campaign_name``."""

    model_config = ConfigDict(from_attributes=True)

    campaign_name: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    ctr: float = 0.0       # percent
    cpc: float = 0.0       # money
    cvr: float = 0.0       # percent
    acos: float = 0.0      # percent
    roas: float = 0.0
    # "latest value" fields (taken from the most recent report_end_date)
    budget: Optional[float] = None
    status: Optional[str] = None
    bidding_strategy: Optional[str] = None
    campaign_type: Optional[str] = None
    targeting_type: Optional[str] = None
    portfolio_name: Optional[str] = None


class AdBudgetAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    acos: float = 0.0   # percent
    roas: float = 0.0
    budget: Optional[float] = None
    suggested_budget: Optional[float] = None
    status: Optional[str] = None
    budget_utilization_rate: float = 0.0
    # Missed metrics (period-level min/max — see aggregator.aggregate_budgets)
    missed_impressions_min: int = 0
    missed_impressions_max: int = 0
    missed_clicks_min: int = 0
    missed_clicks_max: int = 0
    missed_sales_min: float = 0.0
    missed_sales_max: float = 0.0


class AdTargetAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    ad_group_name: Optional[str] = None
    target_text: Optional[str] = None
    match_type: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    units_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0
    # Period-level AVG of top-of-search impression share (per spec).
    top_of_search_impression_share: float = 0.0   # percent


class AdPlacementAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    placement: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    units_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0
    # Latest bidding_strategy observed for this placement within the window.
    bidding_strategy: Optional[str] = None


class AdSearchTermAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    ad_group_name: Optional[str] = None
    target_text: Optional[str] = None
    match_type: Optional[str] = None
    search_term: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0


class AdSearchTermShareAggregateRow(BaseModel):
    search_term: Optional[str] = None
    match_type: Optional[str] = None
    impression_rank: int = 0
    campaign_name: Optional[str] = None
    # Latest target_text / ad_group_name observed within the window
    # (these rows are now grouped by (search_term, match_type)).
    target_text: Optional[str] = None
    ad_group_name: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0
    impression_share: float = 0.0   # percent


class AdPromotedProductAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    ad_sku: Optional[str] = None
    ad_asin: Optional[str] = None
    impressions: int = 0
    clicks: int = 0
    spend: float = 0.0
    sales_7d: float = 0.0
    orders_7d: int = 0
    units_7d: int = 0
    ctr: float = 0.0
    cpc: float = 0.0
    cvr: float = 0.0
    acos: float = 0.0
    roas: float = 0.0
    # SKU-attribution metrics (per spec — ad_sku vs cross-sku breakdown)
    ad_sku_units_7d: int = 0
    ad_sku_sales_7d: float = 0.0
    other_sku_units_7d: int = 0
    other_sku_sales_7d: float = 0.0
    # Latest scope_status within the window (e.g. included_product / excluded_*)
    scope_status: Optional[str] = None


class AdTimeTrendAggregateRow(BaseModel):
    """Aggregate by ``report_end_date`` (one row per day)."""

    report_end_date: str
    country: Optional[str] = None
    currency: Optional[str] = None
    clicks: int = 0
    cpc: float = 0.0
    spend: float = 0.0


class AdPurchasedProductAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    ad_group_name: Optional[str] = None
    ad_sku: Optional[str] = None
    ad_asin: Optional[str] = None
    purchased_asin: Optional[str] = None
    target_text: Optional[str] = None
    match_type: Optional[str] = None
    other_sku_units_7d: int = 0
    other_sku_orders_7d: int = 0
    other_sku_sales_7d: float = 0.0


class AdInvalidTrafficAggregateRow(BaseModel):
    campaign_name: Optional[str] = None
    total_impressions: int = 0
    valid_impressions: int = 0
    invalid_impressions: int = 0
    invalid_impression_rate: float = 0.0   # percent
    total_clicks: int = 0
    valid_clicks: int = 0
    invalid_clicks: int = 0
    invalid_click_rate: float = 0.0        # percent
    status: Optional[str] = None


# Typed response aliases — concrete generics so OpenAPI shows the right shapes.


class AdCampaignAggregateResponse(AggregateResponse[AdCampaignAggregateRow]):
    pass


class AdBudgetAggregateResponse(AggregateResponse[AdBudgetAggregateRow]):
    pass


class AdTargetAggregateResponse(AggregateResponse[AdTargetAggregateRow]):
    pass


class AdPlacementAggregateResponse(AggregateResponse[AdPlacementAggregateRow]):
    pass


class AdSearchTermAggregateResponse(AggregateResponse[AdSearchTermAggregateRow]):
    pass


class AdSearchTermShareAggregateResponse(AggregateResponse[AdSearchTermShareAggregateRow]):
    pass


class AdPromotedProductAggregateResponse(AggregateResponse[AdPromotedProductAggregateRow]):
    pass


class AdTimeTrendAggregateResponse(AggregateResponse[AdTimeTrendAggregateRow]):
    pass


class AdPurchasedProductAggregateResponse(AggregateResponse[AdPurchasedProductAggregateRow]):
    pass


class AdInvalidTrafficAggregateResponse(AggregateResponse[AdInvalidTrafficAggregateRow]):
    pass