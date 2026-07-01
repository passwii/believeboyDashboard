"""Shared helpers for the external API v1.0 aggregate endpoints.

Each of the 10 aggregate endpoints has an identical shape:
  1. parse period, country, order_by
  2. verify project exists
  3. call the corresponding ``aggregator.aggregate_*`` function
  4. compute the summary block + wrap in AggregateResponse

The :func:`make_aggregate_handler` factory returns a FastAPI endpoint
function so the per-table endpoint files stay one-liners.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Callable

from fastapi import HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._period import parse_period_v2
from app.api.v1.endpoints.external._whitelist import AGG_WHITELIST, parse_order_by
from app.models import AdUploadCampaignRow  # only used for the type annotation
from app.schemas.external.aggregate import (
    AdBudgetAggregateRow,
    AdBudgetAggregateResponse,
    AdCampaignAggregateRow,
    AdCampaignAggregateResponse,
    AdInvalidTrafficAggregateRow,
    AdInvalidTrafficAggregateResponse,
    AdPlacementAggregateRow,
    AdPlacementAggregateResponse,
    AdPromotedProductAggregateRow,
    AdPromotedProductAggregateResponse,
    AdPurchasedProductAggregateRow,
    AdPurchasedProductAggregateResponse,
    AdSearchTermAggregateRow,
    AdSearchTermAggregateResponse,
    AdSearchTermShareAggregateRow,
    AdSearchTermShareAggregateResponse,
    AdTargetAggregateRow,
    AdTargetAggregateResponse,
    AdTimeTrendAggregateRow,
    AdTimeTrendAggregateResponse,
)
from app.services.external import aggregator
from app.services.external import projects_query


# Mapping: (ORM model class) -> (aggregator function, AggregateRow schema,
# AggregateResponse schema, summary builder).
#
# The summary builder is one of the helpers in aggregator.py — most tables
# use the default ``build_aggregate_summary``; a few have specialised
# variants because they don't carry the standard metrics.


_TABLE_CONFIG = {
    "ad-campaigns": {
        "model": AdUploadCampaignRow,
        "aggregate": aggregator.aggregate_campaigns,
        "row_schema": AdCampaignAggregateRow,
        "response_schema": AdCampaignAggregateResponse,
        "summary": aggregator.build_aggregate_summary,
        "default_order_by": "total_spend",
    },
    # All other tables are wired up at import time below (to avoid a circular
    # import with models).  See _register_remaining().
}


def _register_remaining() -> None:
    """Lazy-register the remaining 9 tables after all model imports
    have settled. Called from this module's __init__ effect."""
    from app.models import (
        AdUploadBudgetRow,
        AdUploadInvalidTrafficRow,
        AdUploadPlacementRow,
        AdUploadPromotedProductRow,
        AdUploadPurchasedProductRow,
        AdUploadSearchTermShareRow,
        AdUploadSearchTermRow,
        AdUploadTargetRow,
        AdUploadTimeTrendRow,
    )
    _TABLE_CONFIG.update({
        "ad-budgets": {
            "model": AdUploadBudgetRow,
            "aggregate": aggregator.aggregate_budgets,
            "row_schema": AdBudgetAggregateRow,
            "response_schema": AdBudgetAggregateResponse,
            "summary": aggregator.build_aggregate_summary_for_budgets,
            "default_order_by": "total_spend",
        },
        "ad-targets": {
            "model": AdUploadTargetRow,
            "aggregate": aggregator.aggregate_targets,
            "row_schema": AdTargetAggregateRow,
            "response_schema": AdTargetAggregateResponse,
            "summary": aggregator.build_aggregate_summary,
            "default_order_by": "total_spend",
        },
        "ad-placements": {
            "model": AdUploadPlacementRow,
            "aggregate": aggregator.aggregate_placements,
            "row_schema": AdPlacementAggregateRow,
            "response_schema": AdPlacementAggregateResponse,
            "summary": aggregator.build_aggregate_summary,
            "default_order_by": "total_spend",
        },
        "ad-search-terms": {
            "model": AdUploadSearchTermRow,
            "aggregate": aggregator.aggregate_search_terms,
            "row_schema": AdSearchTermAggregateRow,
            "response_schema": AdSearchTermAggregateResponse,
            "summary": aggregator.build_aggregate_summary,
            "default_order_by": "total_spend",
        },
        "ad-search-term-shares": {
            "model": AdUploadSearchTermShareRow,
            "aggregate": aggregator.aggregate_search_term_shares,
            "row_schema": AdSearchTermShareAggregateRow,
            "response_schema": AdSearchTermShareAggregateResponse,
            "summary": aggregator.build_aggregate_summary,
            "default_order_by": "total_spend",
        },
        "ad-promoted-products": {
            "model": AdUploadPromotedProductRow,
            "aggregate": aggregator.aggregate_promoted_products,
            "row_schema": AdPromotedProductAggregateRow,
            "response_schema": AdPromotedProductAggregateResponse,
            "summary": aggregator.build_aggregate_summary,
            "default_order_by": "total_spend",
        },
        "ad-time-trends": {
            "model": AdUploadTimeTrendRow,
            "aggregate": aggregator.aggregate_time_trends,
            "row_schema": AdTimeTrendAggregateRow,
            "response_schema": AdTimeTrendAggregateResponse,
            "summary": aggregator.build_aggregate_summary_for_time_trends,
            "default_order_by": "report_end_date",
        },
        "ad-purchased-products": {
            "model": AdUploadPurchasedProductRow,
            "aggregate": aggregator.aggregate_purchased_products,
            "row_schema": AdPurchasedProductAggregateRow,
            "response_schema": AdPurchasedProductAggregateResponse,
            "summary": aggregator.build_aggregate_summary_for_purchased_products,
            "default_order_by": "other_sku_orders_7d",
        },
        "ad-invalid-traffic": {
            "model": AdUploadInvalidTrafficRow,
            "aggregate": aggregator.aggregate_invalid_traffic,
            "row_schema": AdInvalidTrafficAggregateRow,
            "response_schema": AdInvalidTrafficAggregateResponse,
            "summary": aggregator.build_aggregate_summary_for_invalid_traffic,
            "default_order_by": "total_impressions",
        },
    })


_register_remaining()


def get_table_config(name: str) -> dict:
    if name not in _TABLE_CONFIG:
        raise KeyError(f"Unknown aggregate table: {name}")
    return _TABLE_CONFIG[name]