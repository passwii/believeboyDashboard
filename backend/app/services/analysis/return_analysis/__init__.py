"""Return analysis service package.

Extracted from return_analysis_service.py (phase 5 of backend refactor plan).
All public functions remain importable from the legacy module for backward compatibility.
"""

from __future__ import annotations

from app.services.analysis.return_analysis.analysis import (
    _build_sales_aggregates,
    _build_summary_text,
    _safe_rate,
    build_return_analysis,
    build_return_analysis_from_snapshot,
    get_snapshot_last_computed_at,
    is_snapshot_fresh_for_range,
)
from app.services.analysis.return_analysis.models import (
    _convert_to_us_date,
    _split_customer_comments,
)
from app.services.analysis.return_analysis.parsers import (
    US_TIMEZONE,
    _parse_iso_datetime_with_timezone,
    _read_csv_with_encoding_fallback,
)
from app.services.analysis.return_analysis.persistence import (
    persist_return_report,
)
from app.services.analysis.return_analysis.queries import query_current_return_rows

__all__ = [
    # parsers
    "US_TIMEZONE",
    "_read_csv_with_encoding_fallback",
    "_parse_iso_datetime_with_timezone",
    # models
    "_convert_to_us_date",
    "_split_customer_comments",
    # persistence
    "persist_return_report",
    # queries
    "query_current_return_rows",
    # analysis
    "_safe_rate",
    "_build_sales_aggregates",
    "_build_summary_text",
    "build_return_analysis",
]
