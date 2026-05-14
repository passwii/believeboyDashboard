"""CSV parsing utilities for return analysis.

Extracted from return_analysis_service.py (phase 5 of backend refactor plan).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
from zoneinfo import ZoneInfo

# 美国时区
US_TIMEZONE = ZoneInfo("America/Los_Angeles")


def _read_csv_with_encoding_fallback(path: str | Path, sep: str = "\t") -> pd.DataFrame:
    """Try UTF-8 first, fall back to CP1252 (Windows-1252) if decode fails."""
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return pd.read_csv(path, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, sep=sep, encoding="latin-1")


def _parse_iso_datetime_with_timezone(date_str: str) -> Any | None:
    """Parse ISO-format datetime string with timezone, e.g. 2026-03-31T23:05:02+00:00."""
    try:
        if not date_str or pd.isna(date_str):
            return None
        parsed = pd.to_datetime(date_str, errors="coerce", utc=True)
        if parsed is None or pd.isna(parsed):
            return None
        return parsed.to_pydatetime()
    except Exception:
        return None


__all__ = [
    "US_TIMEZONE",
    "_read_csv_with_encoding_fallback",
    "_parse_iso_datetime_with_timezone",
]
