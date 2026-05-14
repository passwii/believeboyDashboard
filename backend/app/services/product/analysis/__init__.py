"""Product analysis subpackage.

Contains core analytics logic for product analysis:
- Cost handling
- Period source management
- Data availability checks
- Recompute functions

Re-exports all functions for backward compatibility.
"""
from __future__ import annotations

from sqlalchemy import select

# Re-export all functions for backward compatibility
from app.services.product.analysis.costs import (
    _build_active_product_costs_df,
)
from app.services.product.analysis.period_sources import (
    _list_recomputable_weekly_period_sources,
    list_weekly_product_analysis_from_details,
    _list_history_weekly_period_sources,
)
from app.services.product.analysis.data_availability import (
    check_product_calculation_data_availability,
)
from app.services.product.analysis.recompute import (
    recompute_weekly_product_analysis_from_history,
    recompute_pt1_for_period,
    run_product_calculation_from_history,
)

__all__ = [
    # SQLAlchemy utilities (for backward compat with tests)
    'select',
    # Costs
    '_build_active_product_costs_df',
    # Period Sources
    '_list_recomputable_weekly_period_sources',
    'list_weekly_product_analysis_from_details',
    '_list_history_weekly_period_sources',
    # Data Availability
    'check_product_calculation_data_availability',
    # Recompute
    'recompute_weekly_product_analysis_from_history',
    'recompute_pt1_for_period',
    'run_product_calculation_from_history',
]