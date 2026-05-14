"""Core analytics for category research.

Contains all metric calculation functions for market analysis:
- Market concentration (CR1/CR3/CR5/CR10, HHI)
- Brand/seller/product monopoly analysis
- China seller competition
- Market growth and seasonality
- Review research
- Price band opportunities
- New product opportunity
- Supply complexity
- Data quality assessment
- Signals, recommendations, and dimension blocks

Re-exports all functions from submodules for backward compatibility.
"""
from __future__ import annotations

# Re-export all functions for backward compatibility
from app.services.category.analytics.concentration import (
    build_market_concentration,
    risk_level_by_concentration,
    _aggregate_sales_share_pairs,
    build_brand_monopoly,
    build_seller_monopoly,
    build_product_monopoly,
)
from app.services.category.analytics.competition import (
    is_china_seller,
    is_amazon_seller,
    build_china_seller_competition,
    build_supply_complexity,
)
from app.services.category.analytics.market_trend import (
    build_market_growth,
    build_seasonality,
    build_asin_momentum,
)
from app.services.category.analytics.review import (
    build_review_research,
    build_price_band_opportunities,
    build_new_product_opportunity,
)
from app.services.category.analytics.quality import (
    build_data_quality,
    build_dimension_profiles,
)
from app.services.category.analytics.reporting import (
    build_dimension_blocks,
    build_metric_definitions,
    build_action_recommendations,
    build_signals,
    risk_label,
    max_risk_level,
)

__all__ = [
    # Concentration
    'build_market_concentration',
    'risk_level_by_concentration',
    '_aggregate_sales_share_pairs',
    'build_brand_monopoly',
    'build_seller_monopoly',
    'build_product_monopoly',
    # Competition
    'is_china_seller',
    'is_amazon_seller',
    'build_china_seller_competition',
    'build_supply_complexity',
    # Market Trend
    'build_market_growth',
    'build_seasonality',
    'build_asin_momentum',
    # Review
    'build_review_research',
    'build_price_band_opportunities',
    'build_new_product_opportunity',
    # Quality
    'build_data_quality',
    'build_dimension_profiles',
    # Reporting
    'build_dimension_blocks',
    'build_metric_definitions',
    'build_action_recommendations',
    'build_signals',
    # Utilities
    'risk_label',
    'max_risk_level',
]