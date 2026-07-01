"""Whitelist of columns eligible for ``?order_by=`` on the external row and
aggregate endpoints.

Two parallel whitelists:

* ``ROW_WHITELIST``  — single-row endpoints (``/ad-*-raw``). Maps the public
  column name to a SQLAlchemy ``InstrumentedAttribute``.
* ``AGG_WHITELIST``  — aggregate endpoints (``/ad-*``). Maps the public
  column name to a ``ColumnElement`` that may be either an ORM column
  (used as a ``GROUP BY`` key) or a ``func.sum(...).label(...)`` expression
  (used in ``SELECT`` / ``ORDER BY``).

Both whitelists are intentionally narrow — only columns that are useful for
sorting in a BI tool are exposed. Names *not* in the whitelist return 400 so
we never sort on JSON blobs or un-indexed text columns.
"""
from __future__ import annotations

from sqlalchemy import ColumnElement, func
from sqlalchemy.orm import InstrumentedAttribute

from app.models import (
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPromotedProductRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermShareRow,
    AdUploadSearchTermRow,
    AdUploadTargetRow,
    AdUploadTimeTrendRow,
)
from app.schemas.external.common import PeriodParseError


def _whitelist(
    **columns: InstrumentedAttribute,
) -> dict[str, InstrumentedAttribute]:
    return dict(columns)


def _agg_whitelist(
    **columns: ColumnElement,
) -> dict[str, ColumnElement]:
    return dict(columns)


# ---------------------------------------------------------------------------
# ROW_WHITELIST — used by /ad-*-raw endpoints
# ---------------------------------------------------------------------------

ROW_WHITELIST: dict[type, dict[str, InstrumentedAttribute]] = {
    AdUploadCampaignRow: _whitelist(
        id=AdUploadCampaignRow.id,
        source_file_id=AdUploadCampaignRow.source_file_id,
        report_start_date=AdUploadCampaignRow.report_start_date,
        report_end_date=AdUploadCampaignRow.report_end_date,
        campaign_name=AdUploadCampaignRow.campaign_name,
        spend=AdUploadCampaignRow.spend,
        impressions=AdUploadCampaignRow.impressions,
        clicks=AdUploadCampaignRow.clicks,
        sales_7d=AdUploadCampaignRow.sales_7d,
        orders_7d=AdUploadCampaignRow.orders_7d,
        roas=AdUploadCampaignRow.roas,
        acos=AdUploadCampaignRow.acos,
    ),
    AdUploadBudgetRow: _whitelist(
        id=AdUploadBudgetRow.id,
        source_file_id=AdUploadBudgetRow.source_file_id,
        report_start_date=AdUploadBudgetRow.report_start_date,
        report_end_date=AdUploadBudgetRow.report_end_date,
        campaign_name=AdUploadBudgetRow.campaign_name,
        budget=AdUploadBudgetRow.budget,
        suggested_budget=AdUploadBudgetRow.suggested_budget,
        budget_utilization_rate=AdUploadBudgetRow.budget_utilization_rate,
        missed_impressions_max=AdUploadBudgetRow.missed_impressions_max,
        missed_sales_max=AdUploadBudgetRow.missed_sales_max,
    ),
    AdUploadTargetRow: _whitelist(
        id=AdUploadTargetRow.id,
        source_file_id=AdUploadTargetRow.source_file_id,
        report_start_date=AdUploadTargetRow.report_start_date,
        report_end_date=AdUploadTargetRow.report_end_date,
        campaign_name=AdUploadTargetRow.campaign_name,
        target_text=AdUploadTargetRow.target_text,
        spend=AdUploadTargetRow.spend,
        impressions=AdUploadTargetRow.impressions,
        clicks=AdUploadTargetRow.clicks,
        sales_7d=AdUploadTargetRow.sales_7d,
        orders_7d=AdUploadTargetRow.orders_7d,
        roas=AdUploadTargetRow.roas,
        acos=AdUploadTargetRow.acos,
    ),
    AdUploadPlacementRow: _whitelist(
        id=AdUploadPlacementRow.id,
        source_file_id=AdUploadPlacementRow.source_file_id,
        report_start_date=AdUploadPlacementRow.report_start_date,
        report_end_date=AdUploadPlacementRow.report_end_date,
        campaign_name=AdUploadPlacementRow.campaign_name,
        placement=AdUploadPlacementRow.placement,
        spend=AdUploadPlacementRow.spend,
        impressions=AdUploadPlacementRow.impressions,
        clicks=AdUploadPlacementRow.clicks,
        sales_7d=AdUploadPlacementRow.sales_7d,
        orders_7d=AdUploadPlacementRow.orders_7d,
        roas=AdUploadPlacementRow.roas,
        acos=AdUploadPlacementRow.acos,
    ),
    AdUploadSearchTermRow: _whitelist(
        id=AdUploadSearchTermRow.id,
        source_file_id=AdUploadSearchTermRow.source_file_id,
        report_start_date=AdUploadSearchTermRow.report_start_date,
        report_end_date=AdUploadSearchTermRow.report_end_date,
        campaign_name=AdUploadSearchTermRow.campaign_name,
        search_term=AdUploadSearchTermRow.search_term,
        spend=AdUploadSearchTermRow.spend,
        impressions=AdUploadSearchTermRow.impressions,
        clicks=AdUploadSearchTermRow.clicks,
        sales_7d=AdUploadSearchTermRow.sales_7d,
        orders_7d=AdUploadSearchTermRow.orders_7d,
        roas=AdUploadSearchTermRow.roas,
        acos=AdUploadSearchTermRow.acos,
    ),
    AdUploadSearchTermShareRow: _whitelist(
        id=AdUploadSearchTermShareRow.id,
        source_file_id=AdUploadSearchTermShareRow.source_file_id,
        report_start_date=AdUploadSearchTermShareRow.report_start_date,
        report_end_date=AdUploadSearchTermShareRow.report_end_date,
        campaign_name=AdUploadSearchTermShareRow.campaign_name,
        search_term=AdUploadSearchTermShareRow.search_term,
        impression_rank=AdUploadSearchTermShareRow.impression_rank,
        impression_share=AdUploadSearchTermShareRow.impression_share,
        spend=AdUploadSearchTermShareRow.spend,
        impressions=AdUploadSearchTermShareRow.impressions,
        clicks=AdUploadSearchTermShareRow.clicks,
        sales_7d=AdUploadSearchTermShareRow.sales_7d,
        orders_7d=AdUploadSearchTermShareRow.orders_7d,
        roas=AdUploadSearchTermShareRow.roas,
        acos=AdUploadSearchTermShareRow.acos,
    ),
    AdUploadPromotedProductRow: _whitelist(
        id=AdUploadPromotedProductRow.id,
        source_file_id=AdUploadPromotedProductRow.source_file_id,
        report_start_date=AdUploadPromotedProductRow.report_start_date,
        report_end_date=AdUploadPromotedProductRow.report_end_date,
        campaign_name=AdUploadPromotedProductRow.campaign_name,
        ad_sku=AdUploadPromotedProductRow.ad_sku,
        spend=AdUploadPromotedProductRow.spend,
        impressions=AdUploadPromotedProductRow.impressions,
        clicks=AdUploadPromotedProductRow.clicks,
        sales_7d=AdUploadPromotedProductRow.sales_7d,
        orders_7d=AdUploadPromotedProductRow.orders_7d,
        roas=AdUploadPromotedProductRow.roas,
        acos=AdUploadPromotedProductRow.acos,
    ),
    AdUploadTimeTrendRow: _whitelist(
        id=AdUploadTimeTrendRow.id,
        source_file_id=AdUploadTimeTrendRow.source_file_id,
        report_start_date=AdUploadTimeTrendRow.report_start_date,
        report_end_date=AdUploadTimeTrendRow.report_end_date,
        country=AdUploadTimeTrendRow.country,
        spend=AdUploadTimeTrendRow.spend,
        clicks=AdUploadTimeTrendRow.clicks,
        cpc=AdUploadTimeTrendRow.cpc,
    ),
    AdUploadPurchasedProductRow: _whitelist(
        id=AdUploadPurchasedProductRow.id,
        source_file_id=AdUploadPurchasedProductRow.source_file_id,
        report_start_date=AdUploadPurchasedProductRow.report_start_date,
        report_end_date=AdUploadPurchasedProductRow.report_end_date,
        campaign_name=AdUploadPurchasedProductRow.campaign_name,
        ad_sku=AdUploadPurchasedProductRow.ad_sku,
        purchased_asin=AdUploadPurchasedProductRow.purchased_asin,
        other_sku_units_7d=AdUploadPurchasedProductRow.other_sku_units_7d,
        other_sku_orders_7d=AdUploadPurchasedProductRow.other_sku_orders_7d,
        other_sku_sales_7d=AdUploadPurchasedProductRow.other_sku_sales_7d,
    ),
    AdUploadInvalidTrafficRow: _whitelist(
        id=AdUploadInvalidTrafficRow.id,
        source_file_id=AdUploadInvalidTrafficRow.source_file_id,
        report_start_date=AdUploadInvalidTrafficRow.report_start_date,
        report_end_date=AdUploadInvalidTrafficRow.report_end_date,
        campaign_name=AdUploadInvalidTrafficRow.campaign_name,
        total_impressions=AdUploadInvalidTrafficRow.total_impressions,
        invalid_impressions=AdUploadInvalidTrafficRow.invalid_impressions,
        invalid_impression_rate=AdUploadInvalidTrafficRow.invalid_impression_rate,
        total_clicks=AdUploadInvalidTrafficRow.total_clicks,
        invalid_clicks=AdUploadInvalidTrafficRow.invalid_clicks,
        invalid_click_rate=AdUploadInvalidTrafficRow.invalid_click_rate,
    ),
}


# ---------------------------------------------------------------------------
# AGG_WHITELIST — used by /ad-* aggregate endpoints.
# Values are ColumnElement (InstrumentedAttribute OR func.sum().label()).
# ---------------------------------------------------------------------------


def _sum(model, col):
    return func.coalesce(func.sum(getattr(model, col)), 0).label(f"total_{col}")


AGG_WHITELIST: dict[type, dict[str, ColumnElement]] = {
    AdUploadCampaignRow: _agg_whitelist(
        # business key (used in GROUP BY)
        campaign_name=AdUploadCampaignRow.campaign_name,
        # aggregated metrics
        total_impressions=_sum(AdUploadCampaignRow, "impressions"),
        total_clicks=_sum(AdUploadCampaignRow, "clicks"),
        total_spend=_sum(AdUploadCampaignRow, "spend"),
        total_sales_7d=_sum(AdUploadCampaignRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadCampaignRow, "orders_7d"),
    ),
    AdUploadBudgetRow: _agg_whitelist(
        campaign_name=AdUploadBudgetRow.campaign_name,
        # Budget rows do not have sales/clicks — only spend. Provide only what's real.
        total_spend=_sum(AdUploadBudgetRow, "spend"),
        total_orders_7d=_sum(AdUploadBudgetRow, "orders_7d"),
        total_sales_7d=_sum(AdUploadBudgetRow, "sales_7d"),
    ),
    AdUploadTargetRow: _agg_whitelist(
        campaign_name=AdUploadTargetRow.campaign_name,
        ad_group_name=AdUploadTargetRow.ad_group_name,
        target_text=AdUploadTargetRow.target_text,
        match_type=AdUploadTargetRow.match_type,
        total_impressions=_sum(AdUploadTargetRow, "impressions"),
        total_clicks=_sum(AdUploadTargetRow, "clicks"),
        total_spend=_sum(AdUploadTargetRow, "spend"),
        total_sales_7d=_sum(AdUploadTargetRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadTargetRow, "orders_7d"),
    ),
    AdUploadPlacementRow: _agg_whitelist(
        campaign_name=AdUploadPlacementRow.campaign_name,
        placement=AdUploadPlacementRow.placement,
        total_impressions=_sum(AdUploadPlacementRow, "impressions"),
        total_clicks=_sum(AdUploadPlacementRow, "clicks"),
        total_spend=_sum(AdUploadPlacementRow, "spend"),
        total_sales_7d=_sum(AdUploadPlacementRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadPlacementRow, "orders_7d"),
    ),
    AdUploadSearchTermRow: _agg_whitelist(
        campaign_name=AdUploadSearchTermRow.campaign_name,
        ad_group_name=AdUploadSearchTermRow.ad_group_name,
        target_text=AdUploadSearchTermRow.target_text,
        match_type=AdUploadSearchTermRow.match_type,
        search_term=AdUploadSearchTermRow.search_term,
        total_impressions=_sum(AdUploadSearchTermRow, "impressions"),
        total_clicks=_sum(AdUploadSearchTermRow, "clicks"),
        total_spend=_sum(AdUploadSearchTermRow, "spend"),
        total_sales_7d=_sum(AdUploadSearchTermRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadSearchTermRow, "orders_7d"),
    ),
    AdUploadSearchTermShareRow: _agg_whitelist(
        search_term=AdUploadSearchTermShareRow.search_term,
        impression_rank=AdUploadSearchTermShareRow.impression_rank,
        campaign_name=AdUploadSearchTermShareRow.campaign_name,
        total_impressions=_sum(AdUploadSearchTermShareRow, "impressions"),
        total_clicks=_sum(AdUploadSearchTermShareRow, "clicks"),
        total_spend=_sum(AdUploadSearchTermShareRow, "spend"),
        total_sales_7d=_sum(AdUploadSearchTermShareRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadSearchTermShareRow, "orders_7d"),
    ),
    AdUploadPromotedProductRow: _agg_whitelist(
        campaign_name=AdUploadPromotedProductRow.campaign_name,
        ad_sku=AdUploadPromotedProductRow.ad_sku,
        ad_asin=AdUploadPromotedProductRow.ad_asin,
        total_impressions=_sum(AdUploadPromotedProductRow, "impressions"),
        total_clicks=_sum(AdUploadPromotedProductRow, "clicks"),
        total_spend=_sum(AdUploadPromotedProductRow, "spend"),
        total_sales_7d=_sum(AdUploadPromotedProductRow, "sales_7d"),
        total_orders_7d=_sum(AdUploadPromotedProductRow, "orders_7d"),
        total_units_7d=_sum(AdUploadPromotedProductRow, "units_7d"),
    ),
    AdUploadTimeTrendRow: _agg_whitelist(
        report_end_date=AdUploadTimeTrendRow.report_end_date,
        country=AdUploadTimeTrendRow.country,
        total_clicks=_sum(AdUploadTimeTrendRow, "clicks"),
        total_spend=_sum(AdUploadTimeTrendRow, "spend"),
    ),
    AdUploadPurchasedProductRow: _agg_whitelist(
        ad_asin=AdUploadPurchasedProductRow.ad_asin,
        purchased_asin=AdUploadPurchasedProductRow.purchased_asin,
        target_text=AdUploadPurchasedProductRow.target_text,
        total_other_sku_units_7d=_sum(AdUploadPurchasedProductRow, "other_sku_units_7d"),
        total_other_sku_orders_7d=_sum(AdUploadPurchasedProductRow, "other_sku_orders_7d"),
        total_other_sku_sales_7d=_sum(AdUploadPurchasedProductRow, "other_sku_sales_7d"),
    ),
    AdUploadInvalidTrafficRow: _agg_whitelist(
        campaign_name=AdUploadInvalidTrafficRow.campaign_name,
        total_impressions=_sum(AdUploadInvalidTrafficRow, "total_impressions"),
        total_clicks=_sum(AdUploadInvalidTrafficRow, "total_clicks"),
        total_invalid_impressions=_sum(AdUploadInvalidTrafficRow, "invalid_impressions"),
        total_invalid_clicks=_sum(AdUploadInvalidTrafficRow, "invalid_clicks"),
    ),
}


# ---------------------------------------------------------------------------
# parse helpers
# ---------------------------------------------------------------------------


def parse_order_by(
    order_by: str,
    order_dir: str,
    *,
    model: type,
    whitelist: dict[type, dict[str, ColumnElement]] | None = None,
) -> tuple[ColumnElement, str]:
    """Validate ``?order_by=`` + ``?order_dir=`` against the chosen whitelist
    and return ``(column_or_label, direction)``.

    ``whitelist`` defaults to ``ROW_WHITELIST``. Pass ``AGG_WHITELIST``
    explicitly for aggregate endpoints.
    """
    if order_dir not in {"asc", "desc"}:
        raise PeriodParseError(
            f"order_dir must be 'asc' or 'desc', got {order_dir!r}"
        )

    table_whitelist = (whitelist or ROW_WHITELIST).get(model, {})
    if order_by not in table_whitelist:
        allowed = sorted(table_whitelist.keys())
        raise PeriodParseError(
            f"order_by must be one of {allowed}, got {order_by!r}"
        )

    return table_whitelist[order_by], order_dir