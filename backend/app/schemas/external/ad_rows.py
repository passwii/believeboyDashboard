"""Ad upload row schemas for the external API.

One ``*RowItem`` per underlying ORM table. All schemas intentionally exclude
the ``raw_row`` JSON blob (P0 contract — see docs/external-api.md).

Columns mirror ``app.models.ad_upload`` field-for-field; the only ORM column
that is *not* surfaced is ``raw_row``. ``source_file_id`` is included so that
BI tools can join rows back to ``AdUploadFileItem`` metadata.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, ConfigDict


# Common columns shared by every row table.
# Each table-specific class re-declares these explicitly so that OpenAPI
# documents every field (we do not use mixins to keep schemas self-describing
# for the BI team).


class _AdRowBase(BaseModel):
    # Allow ``model_validate(orm_row)`` to read attributes from SQLAlchemy
    # ORM instances (Pydantic v2 default is dict-only).
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_file_id: int
    report_start_date: date
    report_end_date: date


# ---------------------------------------------------------------------------
# ad_upload_campaign_rows
# ---------------------------------------------------------------------------


class AdCampaignRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_budget_rows
# ---------------------------------------------------------------------------


class AdBudgetRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_target_rows
# ---------------------------------------------------------------------------


class AdTargetRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_placement_rows
# ---------------------------------------------------------------------------


class AdPlacementRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_search_term_rows
# ---------------------------------------------------------------------------


class AdSearchTermRowItem(_AdRowBase):
    campaign_name: str | None = None
    ad_group_name: str | None = None
    target_text: str | None = None
    match_type: str | None = None
    search_term: str | None = None
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


# ---------------------------------------------------------------------------
# ad_upload_search_term_share_rows
# ---------------------------------------------------------------------------


class AdSearchTermShareRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_promoted_product_rows
# ---------------------------------------------------------------------------


class AdPromotedProductRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_time_trend_rows
# ---------------------------------------------------------------------------


class AdTimeTrendRowItem(_AdRowBase):
    country: str | None = None
    currency: str | None = None
    clicks: int
    cpc: float
    spend: float


# ---------------------------------------------------------------------------
# ad_upload_purchased_product_rows
# ---------------------------------------------------------------------------


class AdPurchasedProductRowItem(_AdRowBase):
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


# ---------------------------------------------------------------------------
# ad_upload_invalid_traffic_rows
# ---------------------------------------------------------------------------


class AdInvalidTrafficRowItem(_AdRowBase):
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