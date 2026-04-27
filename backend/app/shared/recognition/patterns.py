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
    pass

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    r"Workbook contains no default style, apply openpyxl's default"
)

AD_PRODUCT_REPORT = "ad_product_report"

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


def _read_payment_report(path: Path) -> pd.DataFrame:
    """Read Amazon payment report CSV with variable header offset."""
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
    header_idx = 0
    for i, line in enumerate(lines[:20]):
        if "transaction-type" in line.lower() or "sku" in line.lower():
            header_idx = i
            break

    csv_reader = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    csv_reader.columns = [str(c).strip() for c in csv_reader.columns]
    return csv_reader


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
    if not value:
        return "US"
    normalized = value.strip().upper()
    if normalized in {"US", "USA", "美国", "美国站"}:
        return "US"
    if normalized in {"DE", "GERMANY", "德国", "德国站"}:
        return "DE"
    if normalized in {"UK", "GB", "UNITED KINGDOM", "英国", "英国站"}:
        return "UK"
    return "US"


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
