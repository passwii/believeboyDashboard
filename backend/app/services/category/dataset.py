"""Dataset management for category research.

DEPRECATED: This module has been split into submodules.
Please import from `app.services.category.dataset` instead.

This file is kept for backward compatibility and will be removed in a future version.
"""
from __future__ import annotations

import warnings

warnings.warn(
    "app.services.category.dataset is deprecated. "
    "Import from app.services.category.dataset instead.",
    DeprecationWarning,
    stacklevel=2,
)

# Re-export everything from the new submodule structure
from app.services.category.dataset import (
    import_category_research_dataset,
    recompute_dataset_from_history,
    recompute_datasets_from_history,
    list_datasets,
    get_dataset_or_none,
    list_available_exports,
    list_dataset_products,
    list_dataset_trend_points,
    get_dataset_market_trend_points,
    build_export_payload,
    upsert_manual_dimensions,
    normalize_dimension_map,
    effective_dimensions,
    _normalize_dimension_map,
    _effective_dimensions,
    resolve_price_band_spec,
    build_fixed_price_bands,
    build_quantile_price_bands,
    build_price_stats,
    price_sales_correlation,
    build_fba_fee_distribution,
    get_dataset_overview,
    _build_launch_month_distribution,
)

__all__ = [
    'import_category_research_dataset',
    'recompute_dataset_from_history',
    'recompute_datasets_from_history',
    'list_datasets',
    'get_dataset_or_none',
    'list_available_exports',
    'list_dataset_products',
    'list_dataset_trend_points',
    'get_dataset_market_trend_points',
    'build_export_payload',
    'upsert_manual_dimensions',
    'normalize_dimension_map',
    'effective_dimensions',
    '_normalize_dimension_map',
    '_effective_dimensions',
    'resolve_price_band_spec',
    'build_fixed_price_bands',
    'build_quantile_price_bands',
    'build_price_stats',
    'price_sales_correlation',
    'build_fba_fee_distribution',
    'get_dataset_overview',
    '_build_launch_month_distribution',
]