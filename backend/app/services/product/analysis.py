"""Product analysis - core analytics logic.

DEPRECATED: This module has been split into submodules.
Please import from `app.services.product.analysis` instead.

This file is kept for backward compatibility and will be removed in a future version.
"""
from __future__ import annotations

import warnings

warnings.warn(
    "app.services.product.analysis is deprecated. "
    "Import from app.services.product.analysis instead.",
    DeprecationWarning,
    stacklevel=2,
)

from sqlalchemy import select

from app.services.product.analysis import (
    _build_active_product_costs_df,
    _list_recomputable_weekly_period_sources,
    list_weekly_product_analysis_from_details,
    _list_history_weekly_period_sources,
    check_product_analysis_data_availability,
    recompute_weekly_product_analysis_from_history,
    recompute_pt1_for_period,
    run_product_analysis_from_history,
)

__all__ = [
    'select',  # Exported for backward compatibility with tests
    '_build_active_product_costs_df',
    '_list_recomputable_weekly_period_sources',
    'list_weekly_product_analysis_from_details',
    '_list_history_weekly_period_sources',
    'check_product_analysis_data_availability',
    'recompute_weekly_product_analysis_from_history',
    'recompute_pt1_for_period',
    'run_product_analysis_from_history',
]