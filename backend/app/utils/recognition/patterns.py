"""Country detection patterns for report files (no FastAPI/SQLAlchemy deps)."""
from __future__ import annotations

import io
import re
import warnings
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

import pandas as pd

if TYPE_CHECKING:
    from zoneinfo import ZoneInfo

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    r"Workbook contains no default style, apply openpyxl's default"
)

AD_PRODUCT_REPORT = "ad_product_report"

# Country timezone mapping for date conversion
COUNTRY_TIMEZONE: dict[str, str] = {
    "US": "America/Los_Angeles",
    "DE": "Europe/Berlin",
    "UK": "Europe/London",
}

# ─── File readers ──────────────────────────────────────────────────────────────


def _read_excel(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
            category=UserWarning,
        )
        return pd.read_excel(path, engine="openpyxl")


def _read_csv_with_encoding_fallback(path: Path, sep: str = "\t") -> pd.DataFrame:
    """Try UTF-8 first, fall back to CP1252 (Windows-1252) if decode fails."""
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return pd.read_csv(path, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, sep=sep, encoding="latin-1")


def _read_text_with_encoding_fallback(path: Path) -> str:
    """Try UTF-8 first, fall back to CP1252 if decode fails."""
    raw_bytes = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("latin-1", errors="replace")


def _read_payment_report(
    path: Path,
    *,
    extract_dates: bool = False,
    country: str = "US",
) -> tuple[pd.DataFrame, str | None, str | None, str | None]:
    """Read Amazon payment report CSV with variable header offset.

    Returns (df, detected_start_date, detected_end_date, detected_country).
    Dates are in YYYY-MM-DD local time for the given country.
    Country is detected from the 'marketplace' column if present.
    When extract_dates=False (default), the date/country fields are always None
    to preserve existing behaviour in callers that don't need them.
    """
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("latin-1", errors="replace")

    lines = text.splitlines()

    # ── Locate header row (variable offset, search up to 30 lines) ──
    header_idx = 0
    for i, line in enumerate(lines[:30]):
        if "transaction-type" in line.lower() or "sku" in line.lower():
            header_idx = i
            break

    df = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    df.columns = [str(c).strip() for c in df.columns]

    # ── Date extraction (only when requested) ──
    detected_start: str | None = None
    detected_end: str | None = None
    detected_country: str | None = None

    if extract_dates:
        # Detect country from marketplace column
        mkt_col = next((c for c in df.columns if "marketplace" in c.lower()), None)
        if mkt_col and not df[mkt_col].dropna().empty:
            mkt_val = str(df[mkt_col].dropna().iloc[0]).strip().lower()
            if "amazon.com" in mkt_val:
                detected_country = "US"
            elif "amazon.de" in mkt_val:
                detected_country = "DE"
            elif "amazon.co.uk" in mkt_val:
                detected_country = "UK"

        # Extract date range from transaction timestamps.
        # The date/time column is already in the marketplace's local timezone
        # (e.g. "May 1, 2026 2:01:59 AM PDT"). Strip the timezone suffix and
        # parse just the date — no UTC conversion needed.
        date_col = next(
            (c for c in df.columns if "date/time" in c.lower() or "transaction date" in c.lower()),
            None,
        )
        if date_col:
            dates: list[str] = []
            for raw in df[date_col].dropna():
                text = str(raw).strip()
                # Remove trailing timezone abbreviation: "May 1, 2026 2:01:59 AM PDT" → "May 1, 2026 2:01:59 AM"
                cleaned = re.sub(r'\s+(PST|PDT|GMT|UTC)\s*$', '', text, flags=re.IGNORECASE)
                try:
                    # Parse to date only — no UTC conversion needed, file is already in local time
                    dt = pd.to_datetime(cleaned, errors="coerce")
                    if dt is not None and not pd.isna(dt):
                        dates.append(dt.strftime("%Y-%m-%d"))
                except Exception:
                    continue
            unique_dates = sorted(set(dates))
            if unique_dates:
                detected_start = unique_dates[0]
                detected_end = unique_dates[-1]

    return df, detected_start, detected_end, detected_country


# ─── Column normalizers ────────────────────────────────────────────────────────


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(column).strip() for column in df.columns]
    return df


def _normalize_identifier(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return ""
    return text.upper()


# ─── Date helpers ──────────────────────────────────────────────────────────────


def _date_to_string(value: object) -> str | None:
    if value is None or value == "":
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
    except Exception:
        return None
    if parsed is None or pd.isna(parsed):
        return None
    return parsed.strftime("%Y-%m-%d")


def _date_to_string_by_country(value: object, country: str) -> str | None:
    """Convert date to string, applying timezone conversion for the given country."""
    if value is None or value == "":
        return None
    try:
        parsed = pd.to_datetime(value, errors="coerce")
    except Exception:
        return None
    if parsed is None or pd.isna(parsed):
        return None

    if parsed.tzinfo is None:
        return parsed.strftime("%Y-%m-%d")

    # Apply timezone conversion
    from zoneinfo import ZoneInfo
    timezone = ZoneInfo(COUNTRY_TIMEZONE.get(country, "America/Los_Angeles"))
    return parsed.tz_convert(timezone).strftime("%Y-%m-%d")


def _extract_date_from_filename(filename: str) -> str | None:
    """Extract YYYYMMDD date from filename, e.g. BusinessReport-15-4-26_20260413.csv → 2026-04-13"""
    m = re.search(r"(\d{4})(\d{2})(\d{2})", filename)
    if not m:
        return None
    year, month, day = m.group(1), m.group(2), m.group(3)
    try:
        datetime(int(year), int(month), int(day))
        return f"{year}-{month}-{day}"
    except ValueError:
        return None


# ─── Country detection patterns ────────────────────────────────────────────────


def _normalize_country(value: str | None) -> str:
    """Normalize country to US/DE/UK, defaulting to US for empty/None."""
    from app.utils.country import normalize_country
    return normalize_country(value, default="US")


def _detect_country_from_sales_channel(df: pd.DataFrame) -> str | None:
    """Detect country from sales-channel column.

    Amazon.de → DE, Amazon.com → US, Amazon.co.uk → UK
    """
    col_candidates = [c for c in df.columns if "sales" in c.lower() and "channel" in c.lower()]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().lower()
    if "amazon.de" in val:
        return "DE"
    if "amazon.com" in val:
        return "US"
    if "amazon.co.uk" in val:
        return "UK"  # 🔶 Reserved for UK站点
    return None


def _detect_country_from_currency(df: pd.DataFrame) -> str | None:
    """Detect country from currency column. USD→US, EUR→DE, GBP→UK."""
    col_candidates = [c for c in df.columns if "currency" in c.lower() or "币种" in c]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().upper()
    if val in {"USD", "US"}:
        return "US"
    if val in {"EUR", "EURO"}:
        return "DE"
    if val in {"GBP", "UK"}:
        return "UK"  # 🔶 Reserved
    return None


def _detect_country_from_marketplace(df: pd.DataFrame) -> str | None:
    """Detect country from marketplace column. DE→DE, UK/GB→UK."""
    col_candidates = [c for c in df.columns if "marketplace" in c.lower()]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().upper()
    if val in {"DE", "GERMANY"}:
        return "DE"
    if val in {"UK", "GB", "UNITED KINGDOM"}:
        return "UK"  # 🔶 Reserved
    return None


def _detect_country_from_sales_amount_symbol(df: pd.DataFrame) -> str | None:
    """Detect country from currency symbol in sales amount columns (业务报告).

    € → DE, £ → UK
    """
    sales_col_candidates = [
        c for c in df.columns
        if "销售额" in c or "sales" in c.lower()
    ]
    for col in sales_col_candidates:
        sample = (
            str(df[col].dropna().iloc[0])
            if not df[col].dropna().empty
            else ""
        )
        if "€" in sample:
            return "DE"
        if "£" in sample:
            return "UK"  # 🔶 Reserved
    return None
