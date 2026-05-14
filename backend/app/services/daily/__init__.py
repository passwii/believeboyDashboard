from __future__ import annotations

import warnings
from datetime import date
from decimal import Decimal

from app.utils.date_utils import date_range, parse_yyyy_mm_dd
from app.utils.math_utils import round_money, safe_ratio

from app.services.daily.aggregation import (
    _MetricBucket,
    _aggregate_buckets,
    _bucket_key,
    _get_or_create_bucket,
    _set_asin_if_blank,
)
from app.services.daily.analysis import (
    _build_asin_to_sku_map,
    _get_project_or_404,
    _load_business_metrics,
    _load_latest_available_dates,
    build_daily_analysis,
    build_daily_analysis_all_projects,
)
from app.services.daily.sales import _load_sales_metrics
from app.services.daily.ad import _load_ad_metrics
from app.services.daily.inventory import _load_inventory_metrics

__all__ = [
    # Public API
    "build_daily_analysis",
    "build_daily_analysis_all_projects",
    # Internal (for testing / compat)
    "_MetricBucket",
    "_aggregate_buckets",
    "_bucket_key",
    "_get_or_create_bucket",
    "_set_asin_if_blank",
    "_get_project_or_404",
    "_build_asin_to_sku_map",
    "_load_sales_metrics",
    "_load_ad_metrics",
    "_load_inventory_metrics",
    "_load_business_metrics",
    "_load_latest_available_dates",
    # Deprecated compat aliases
    "_parse_date",
    "_round_money",
    "_safe_ratio",
    "_daterange",
]


def _parse_date(value: str | None, field_name: str) -> date:
    warnings.warn(
        "_parse_date is deprecated, use app.shared.date_utils.parse_yyyy_mm_dd instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return parse_yyyy_mm_dd(value, field_name)


def _round_money(value: Decimal) -> float:
    warnings.warn(
        "_round_money is deprecated, use app.shared.math_utils.round_money instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return round_money(value)


def _safe_ratio(numerator: Decimal, denominator: int) -> float:
    warnings.warn(
        "_safe_ratio is deprecated, use app.shared.math_utils.safe_ratio instead",
        DeprecationWarning,
        stacklevel=2,
    )
    result = safe_ratio(numerator, denominator)
    return round_money(result)


def _daterange(start_date: date, end_date: date) -> list[date]:
    warnings.warn(
        "_daterange is deprecated, use app.shared.date_utils.date_range instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return date_range(start_date, end_date)
