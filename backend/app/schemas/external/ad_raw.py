"""Raw row schemas for the shared read-query layer.

原 external 命名空间的共享 schema（external 机制已退役删除，BLF-583），供 agent 原生域复用。

The ``*RawRow`` schemas mirror the underlying ORM table 1:1 (including
``id``, ``source_file_id``, ``raw_row`` JSON, ``created_at``) so that
deep-diagnostic BI tools have full audit context.

Numeric fields are kept as raw ORM values (ratio, not percent) so callers
can compute their own metrics. Aggregate endpoint schemas — see
``schemas/external/aggregate.py`` — do the percent conversion.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class _AdRawRowBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_file_id: int
    report_start_date: date
    report_end_date: date
    raw_row: dict[str, Any]
    created_at: datetime


class AdCampaignRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    portfolio_name: str | None = None
    campaign_type: str | None = None
    targeting_type: str | None = None
    bidding_strategy: str | None = None
    status: str | None = None
    budget: float
    impressions: int
    clicks: int
    ctr: float
    spend: float
    cpc: float
    orders_7d: int
    sales_7d: float
    acos: float
    roas: float


class AdBudgetRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    status: str | None = None
    budget: float
    suggested_budget: float
    budget_utilization_rate: float
    missed_impressions_min: int
    missed_impressions_max: int
    missed_clicks_min: int
    missed_clicks_max: int
    missed_sales_min: float
    missed_sales_max: float
    spend: float
    sales_7d: float
    orders_7d: int
    acos: float


class AdTargetRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    target_text: str | None = None
    match_type: str | None = None
    impressions: int
    top_of_search_impression_share: float
    clicks: int
    ctr: float
    cpc: float
    spend: float
    sales_7d: float
    orders_7d: int
    units_7d: int
    acos: float
    roas: float
    cvr_7d: float


class AdPlacementRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    placement: str | None = None
    bidding_strategy: str | None = None
    impressions: int
    clicks: int
    spend: float
    cpc: float
    sales_7d: float
    orders_7d: int
    units_7d: int
    acos: float
    roas: float


class AdSearchTermRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    match_type: str | None = None
    search_term: str | None = None
    targeting_type: str | None = None
    impressions: int
    clicks: int
    ctr: float
    spend: float
    cpc: float
    orders_7d: int
    sales_7d: float
    acos: float
    roas: float
    cvr_7d: float


class AdSearchTermShareRawRow(_AdRawRowBase):
    search_term: str | None = None
    impression_rank: int
    impression_share: float
    target_text: str | None = None
    match_type: str | None = None
    campaign_name: str | None = None
    ad_group_name: str | None = None
    clicks: int
    impressions: int
    ctr: float
    spend: float
    cpc: float
    orders_7d: int
    sales_7d: float
    acos: float
    roas: float
    cvr_7d: float


class AdPromotedProductRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    ad_sku: str | None = None
    ad_asin: str | None = None
    impressions: int
    clicks: int
    ctr: float
    spend: float
    cpc: float
    orders_7d: int
    units_7d: int
    sales_7d: float
    acos: float
    roas: float
    cvr_7d: float
    ad_sku_units_7d: int
    other_sku_units_7d: int
    ad_sku_sales_7d: float
    other_sku_sales_7d: float
    scope_status: str


class AdTimeTrendRawRow(_AdRawRowBase):
    country: str | None = None
    currency: str | None = None
    clicks: int
    cpc: float
    spend: float


class AdPurchasedProductRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    ad_sku: str | None = None
    ad_asin: str | None = None
    target_text: str | None = None
    match_type: str | None = None
    purchased_asin: str | None = None
    other_sku_units_7d: int
    other_sku_orders_7d: int
    other_sku_sales_7d: float


class AdInvalidTrafficRawRow(_AdRawRowBase):
    campaign_name: str | None = None
    status: str | None = None
    total_impressions: int
    valid_impressions: int
    invalid_impressions: int
    invalid_impression_rate: float
    total_clicks: int
    valid_clicks: int
    invalid_clicks: int
    invalid_click_rate: float