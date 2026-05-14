"""Sales trend analysis for category research.

Handles monthly sales aggregation, trend calculations, and market growth metrics.
"""

from __future__ import annotations

from typing import Any


def aggregate_market_monthly_sales(trend_rows: list) -> dict[str, int]:
    """Aggregate monthly sales from trend rows."""
    monthly_totals: dict[str, int] = {}
    for item in trend_rows:
        key = (item.year_month or '').strip()
        if not key:
            continue
        monthly_totals[key] = monthly_totals.get(key, 0) + int(item.monthly_sales or 0)
    return monthly_totals


def is_year_month(value: Any) -> bool:
    """Check if value is in YYYY-MM format."""
    import re
    if not value:
        return False
    text = str(value).strip()
    return bool(re.match(r'^\d{4}-\d{2}$', text))


def shift_month(value, delta: int) -> Any:
    """Shift date by delta months."""
    from datetime import timedelta
    total_days = delta * 30
    return value + timedelta(days=total_days)
