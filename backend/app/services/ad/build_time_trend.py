"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.date_utils import build_previous_period
from app.utils.math_utils import DECIMAL_ZERO
from app.utils.country import normalize_country
from app.utils.period_comparison import build_period_comparison
from .helpers import _build_time_trend_summary, _ensure_project_access
from .loaders import _load_time_trend_rows
def build_time_trend(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    previous_date_from, previous_date_to = build_previous_period(date_from=date_from, date_to=date_to)
    rows = _load_time_trend_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    previous_rows = (
        _load_time_trend_rows(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=previous_date_from,
            date_to=previous_date_to,
        )
        if previous_date_from is not None and previous_date_to is not None
        else []
    )
    current_summary = _build_time_trend_summary(rows)
    current_spend = sum((Decimal(row.spend or 0) for row in rows), DECIMAL_ZERO)
    previous_spend = sum((Decimal(row.spend or 0) for row in previous_rows), DECIMAL_ZERO)
    current_clicks = sum(int(row.clicks or 0) for row in rows)
    previous_clicks = sum(int(row.clicks or 0) for row in previous_rows)
    comparison = build_period_comparison(
        current_start=date_from,
        current_end=date_to,
        previous_start=previous_date_from,
        previous_end=previous_date_to,
        current_spend=current_spend,
        previous_spend=previous_spend,
        current_clicks=current_clicks,
        previous_clicks=previous_clicks,
        current_sales=DECIMAL_ZERO,
        previous_sales=DECIMAL_ZERO,
        current_orders=0,
        previous_orders=0,
    )

    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary': current_summary,
        'comparison': comparison,
    }


