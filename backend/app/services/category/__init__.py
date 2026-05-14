"""Category research service subpackage.

Split from the monolithic category_research_service.py.
Each module handles a specific aspect of category research functionality.
"""

from __future__ import annotations

from app.services.category.dataset import (
    import_category_research_dataset,
    list_datasets,
    recompute_dataset_from_history,
    recompute_datasets_from_history,
    upsert_manual_dimensions,
    normalize_dimension_map,
    effective_dimensions,
    get_dataset_or_none,
    list_available_exports,
    build_export_payload,
    get_dataset_overview,
    list_dataset_products,
    list_dataset_trend_points,
    get_dataset_market_trend_points,
)
from app.services.category.export import (
    CategoryResearchExportPayload,
)
from app.services.category.analytics import (
    build_dimension_profiles,
    build_market_concentration,
    risk_level_by_concentration,
    build_brand_monopoly,
    build_seller_monopoly,
    build_product_monopoly,
    is_china_seller,
    is_amazon_seller,
    build_china_seller_competition,
    build_market_growth,
    build_seasonality,
    build_review_research,
    build_new_product_opportunity,
    build_supply_complexity,
    build_asin_momentum,
    build_data_quality,
    build_dimension_blocks,
    build_metric_definitions,
    build_action_recommendations,
    build_signals,
    risk_label,
    max_risk_level,
)
from app.services.category.dataset import (
    build_fixed_price_bands,
    build_quantile_price_bands,
    build_price_stats,
    price_sales_correlation,
    build_fba_fee_distribution,
)

__all__ = [
    # dataset
    'import_category_research_dataset',
    'list_datasets',
    'recompute_dataset_from_history',
    'recompute_datasets_from_history',
    'upsert_manual_dimensions',
    'normalize_dimension_map',
    'effective_dimensions',
    'get_dataset_or_none',
    'list_available_exports',
    'build_export_payload',
    'get_dataset_overview',
    'list_dataset_products',
    'list_dataset_trend_points',
    'get_dataset_market_trend_points',
    # export
    'CategoryResearchExportPayload',
    # analytics
    'build_dimension_profiles',
    'build_market_concentration',
    'risk_level_by_concentration',
    'build_brand_monopoly',
    'build_seller_monopoly',
    'build_product_monopoly',
    'is_china_seller',
    'is_amazon_seller',
    'build_china_seller_competition',
    'build_market_growth',
    'build_seasonality',
    'build_review_research',
    'build_new_product_opportunity',
    'build_supply_complexity',
    'build_asin_momentum',
    'build_data_quality',
    'build_dimension_blocks',
    'build_metric_definitions',
    'build_action_recommendations',
    'build_signals',
    'risk_label',
    'max_risk_level',
    'build_fixed_price_bands',
    'build_quantile_price_bands',
    'build_price_stats',
    'price_sales_correlation',
    'build_fba_fee_distribution',
]
