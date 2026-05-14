"""Core analytics for category research.

DEPRECATED: This module has been split into submodules.
Please import from `app.services.category.analytics` instead.

This file is kept for backward compatibility and will be removed in a future version.
"""
from __future__ import annotations

import warnings

warnings.warn(
    "app.services.category.analytics is deprecated. "
    "Import from app.services.category.analytics instead.",
    DeprecationWarning,
    stacklevel=2,
)

# Re-export everything from the new submodule structure
from app.services.category.analytics import (
    build_market_concentration,
    risk_level_by_concentration,
    _aggregate_sales_share_pairs,
    build_brand_monopoly,
    build_seller_monopoly,
    build_product_monopoly,
    is_china_seller,
    is_amazon_seller,
    build_china_seller_competition,
    build_market_growth,
    build_seasonality,
    build_asin_momentum,
    build_review_research,
    build_price_band_opportunities,
    build_new_product_opportunity,
    build_supply_complexity,
    build_data_quality,
    build_dimension_profiles,
    build_dimension_blocks,
    build_metric_definitions,
    build_action_recommendations,
    build_signals,
    risk_label,
    max_risk_level,
)

__all__ = [
    'build_market_concentration',
    'risk_level_by_concentration',
    '_aggregate_sales_share_pairs',
    'build_brand_monopoly',
    'build_seller_monopoly',
    'build_product_monopoly',
    'is_china_seller',
    'is_amazon_seller',
    'build_china_seller_competition',
    'build_market_growth',
    'build_seasonality',
    'build_asin_momentum',
    'build_review_research',
    'build_price_band_opportunities',
    'build_new_product_opportunity',
    'build_supply_complexity',
    'build_data_quality',
    'build_dimension_profiles',
    'build_dimension_blocks',
    'build_metric_definitions',
    'build_action_recommendations',
    'build_signals',
    'risk_label',
    'max_risk_level',
]