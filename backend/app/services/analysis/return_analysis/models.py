"""Data transformation utilities for return analysis.

Extracted from return_analysis_service.py (phase 5 of backend refactor plan).
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

# BLF-1036: pandas imported lazily (boot chain: endpoints.return_analysis).
if TYPE_CHECKING:
    import pandas as pd

from app.services.analysis.return_analysis.parsers import US_TIMEZONE


def _convert_to_us_date(iso_datetime: datetime) -> str:
    """Convert a UTC datetime to a US date string (YYYY-MM-DD) in America/Los_Angeles."""
    if iso_datetime.tzinfo is None:
        iso_datetime = iso_datetime.replace(tzinfo=None)
    us_dt = iso_datetime.astimezone(US_TIMEZONE)
    return us_dt.strftime("%Y-%m-%d")


def _split_customer_comments(comment: str) -> list[str]:
    """Split pipe-delimited customer comments into a list, cleaning HTML entities."""
    import pandas as pd

    if pd.isna(comment) or not comment:
        return []
    cleaned = str(comment).replace("&#39;", "'").replace("&amp;", "&")
    parts = cleaned.split("|")
    return [p.strip() for p in parts if p.strip()]


__all__ = [
    "_convert_to_us_date",
    "_split_customer_comments",
]
