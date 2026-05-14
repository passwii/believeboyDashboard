"""Dataset management for category research.

Handles dataset CRUD operations, import, recompute, dimension management,
and data listing/filtering functions.

Re-exports all functions from submodules for backward compatibility.
"""
from __future__ import annotations

# Re-export all functions for backward compatibility
from app.services.category.dataset.cruds import (
    import_category_research_dataset,
    recompute_dataset_from_history,
    recompute_datasets_from_history,
)
from app.services.category.dataset.queries import (
    list_datasets,
    get_dataset_or_none,
    list_available_exports,
    list_dataset_products,
    list_dataset_trend_points,
    get_dataset_market_trend_points,
)
from app.services.category.dataset.dimensions import (
    upsert_manual_dimensions,
    normalize_dimension_map,
    effective_dimensions,
    _normalize_dimension_map,
    _effective_dimensions,
)
from app.services.category.dataset.price_bands import (
    resolve_price_band_spec,
    build_fixed_price_bands,
    build_quantile_price_bands,
    build_price_stats,
    price_sales_correlation,
    build_fba_fee_distribution,
)
from app.services.category.dataset.overview import (
    get_dataset_overview,
    _build_launch_month_distribution,
)
from app.services.category.dataset.queries import (
    build_export_payload,
)

__all__ = [
    # CRUDS
    'import_category_research_dataset',
    'recompute_dataset_from_history',
    'recompute_datasets_from_history',
    # Queries
    'list_datasets',
    'get_dataset_or_none',
    'list_available_exports',
    'list_dataset_products',
    'list_dataset_trend_points',
    'get_dataset_market_trend_points',
    'build_export_payload',
    # Dimensions
    'upsert_manual_dimensions',
    'normalize_dimension_map',
    'effective_dimensions',
    '_normalize_dimension_map',
    '_effective_dimensions',
    # Price Bands
    'resolve_price_band_spec',
    'build_fixed_price_bands',
    'build_quantile_price_bands',
    'build_price_stats',
    'price_sales_correlation',
    'build_fba_fee_distribution',
    # Overview
    'get_dataset_overview',
    '_build_launch_month_distribution',
]