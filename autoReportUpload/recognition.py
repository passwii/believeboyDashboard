"""
Report type recognition for the auto-report-upload service.
Adapted from backend/app/services/report_upload_service.py
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
import warnings
import re
from zoneinfo import ZoneInfo

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from models import ProductCost

AD_PRODUCT_REPORT = "ad_product_report"

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    r"Workbook contains no default style, apply openpyxl's default"
)

COUNTRY_TIMEZONE = {
    "US": ZoneInfo("America/Los_Angeles"),
    "DE": ZoneInfo("Europe/Berlin"),
    "UK": ZoneInfo("Europe/London"),
}

COUNTRY_ALIASES = {
    "US": "US",
    "USA": "US",
    "DE": "DE",
    "GERMANY": "DE",
    "UK": "UK",
    "GB": "UK",
    "UNITED KINGDOM": "UK",
}


@dataclass
class RecognitionResult:
    """Result of recognizing a single file."""

    report_type: str
    matched_columns: list[str]
    reason: str
    date_input_mode: str
    detected_date: str | None = None
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    row_count_preview: int | None = None
    warnings: list[str] = field(default_factory=list)
    country: str = "US"
    project_match: dict | None = None


# ─── Helpers ───────────────────────────────────────────────────────────────────


def _read_csv_with_encoding_fallback(path: Path, sep: str = "\t") -> pd.DataFrame:
    for encoding in ("utf-8-sig", "cp1252", "gbk"):
        try:
            return pd.read_csv(path, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, sep=sep, encoding="latin-1")


def _read_text_with_encoding_fallback(path: Path) -> str:
    raw_bytes = path.read_bytes()
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw_bytes.decode("latin-1", errors="replace")


def _read_excel(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
            category=UserWarning,
        )
        return pd.read_excel(path, engine="openpyxl")


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    df.columns = [str(col).strip() for col in df.columns]
    return df


def _normalize_identifier(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() == "nan":
        return ""
    return text.upper()


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
    tz = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
    return parsed.tz_convert(tz).strftime("%Y-%m-%d")


def _normalize_country(value: str) -> str:
    normalized = value.strip().upper()
    if not normalized:
        return "US"
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in {"US", "DE", "UK"}:
        return "US"
    return mapped


def _extract_date_from_filename(filename: str) -> str | None:
    m = re.search(r"(\d{4})(\d{2})(\d{2})", filename)
    if not m:
        return None
    year, month, day = m.group(1), m.group(2), m.group(3)
    try:
        datetime(int(year), int(month), int(day))
        return f"{year}-{month}-{day}"
    except ValueError:
        return None


def _detect_country_from_sales_channel(df: pd.DataFrame) -> str | None:
    col_candidates = [c for c in df.columns if "sales" in c.lower() and "channel" in c.lower()]
    if not col_candidates:
        return None
    val = str(df[col_candidates[0]].dropna().iloc[0]).strip().lower()
    if "amazon.de" in val:
        return "DE"
    if "amazon.com" in val or "amazon.co.uk" in val:
        return "US"
    return None


def _detect_country_from_currency(df: pd.DataFrame) -> str | None:
    col_candidates = [c for c in df.columns if "currency" in c.lower() or "币种" in c]
    if not col_candidates:
        return None
    first_val = str(df[col_candidates[0]].dropna().iloc[0]).strip().upper()
    if first_val in {"USD"}:
        return "US"
    if first_val in {"EUR", "EURO"}:
        return "DE"
    if first_val in {"GBP"}:
        return "UK"
    return None


# ─── Project matching ─────────────────────────────────────────────────────────


def _build_project_match(
    db: Session,
    *,
    values: list[str],
    match_by: str,
    country: str = "US",
) -> dict[str, Any]:
    """Match files to projects by SKU or ASIN."""
    normalized_values = sorted(
        {_normalize_identifier(v) for v in values if _normalize_identifier(v)}
    )
    if not normalized_values:
        return {
            "status": "unmatched",
            "matched_by": match_by,
            "message": "文件中未找到可用于匹配项目的标识",
        }

    col = ProductCost.sku if match_by == "sku" else ProductCost.asin
    # Use LOWER() for case-insensitive matching (DB stores mixed-case SKU/ASIN)
    normalized_lower = [v.lower() for v in normalized_values]
    rows = (
        db.execute(
            select(ProductCost.project_name)
            .where(func.lower(col).in_(normalized_lower))
            .where(ProductCost.is_active.is_(True))
            .where(ProductCost.country == country)
            .distinct()
        )
        .scalars()
        .all()
    )
    all_projects = sorted(set(rows))

    if len(all_projects) == 1:
        return {
            "status": "matched",
            "project_name": all_projects[0],
            "matched_by": match_by,
            "message": f"已根据{match_by.upper()}自动匹配项目",
        }
    if len(all_projects) > 1:
        return {
            "status": "conflict",
            "candidate_projects": all_projects,
            "matched_by": match_by,
            "message": f"检测到多个项目，请手动确认（{len(all_projects)} 个候选项目）",
        }
    return {
        "status": "unmatched",
        "matched_by": match_by,
        "message": "未匹配到项目",
    }


# ─── Per-type recognizers ─────────────────────────────────────────────────────


def _recognize_inventory_report(db: Session, path: Path, country: str = "US") -> RecognitionResult:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["snapshot-date", "sku", "asin"]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Inventory report missing required columns: {required}")

    detected_date = _date_to_string_by_country(
        df["snapshot-date"].dropna().iloc[0] if not df["snapshot-date"].dropna().empty else None,
        country,
    )
    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
    )
    warnings_list: list[str] = []
    detected_country = _detect_country_from_currency(df)
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内 currency 为 {detected_country}，当前按 {country} 处理")

    return RecognitionResult(
        report_type="inventory_report",
        matched_columns=required,
        reason="命中 snapshot-date / sku / asin",
        date_input_mode="single_detected" if detected_date else "single_manual",
        detected_date=detected_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def _recognize_business_report(
    db: Session, path: Path, country: str = "US", original_filename: str = ""
) -> RecognitionResult:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
    asin_col = next(
        (c for c in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"] if c in df.columns),
        None,
    )
    if not asin_col:
        raise ValueError("Business report missing child ASIN column")

    project_match = _build_project_match(
        db,
        values=df[asin_col].dropna().astype(str).tolist(),
        match_by="asin",
        country=country,
    )
    detected_date = _extract_date_from_filename(original_filename)
    warnings_list: list[str] = []
    if detected_date:
        warnings_list.append(f"从文件名识别日期：{detected_date}")

    return RecognitionResult(
        report_type="business_report",
        matched_columns=[asin_col],
        reason="命中（子）ASIN字段",
        date_input_mode="single_detected" if detected_date else "single_manual",
        detected_date=detected_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
    )


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

    import io
    csv_reader = pd.read_csv(io.StringIO("\n".join(lines[header_idx:])))
    csv_reader.columns = [str(c).strip() for c in csv_reader.columns]
    return csv_reader


def _recognize_payment_report(db: Session, path: Path, country: str = "US") -> RecognitionResult:
    df = _read_payment_report(path)
    if "sku" not in df.columns:
        raise ValueError("Payment report missing sku column")

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
    )
    return RecognitionResult(
        report_type="payment_report",
        matched_columns=["sku"],
        reason="命中付款报告表头与 sku 字段",
        date_input_mode="range_manual",
        project_match=project_match,
        row_count_preview=len(df.index),
    )


def _recognize_sales_report(db: Session, path: Path, country: str = "US") -> RecognitionResult:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["purchase-date", "sku", "asin"]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Sales report missing required columns: {required}")

    purchase_dates = pd.to_datetime(df["purchase-date"], utc=True, errors="coerce").dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not purchase_dates.empty:
        local_tz = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
        local_dates = purchase_dates.dt.tz_convert(local_tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

    is_periodic = bool(detected_start_date and detected_end_date and detected_start_date != detected_end_date)
    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
    )
    warnings_list: list[str] = []
    detected_country = _detect_country_from_sales_channel(df)
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内 sales-channel 为 {detected_country}，当前按 {country} 处理")

    return RecognitionResult(
        report_type="sales_report",
        matched_columns=required,
        reason="命中 purchase-date / sku / asin",
        date_input_mode="multi_auto" if is_periodic else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def _recognize_ad_product_report(db: Session, path: Path, country: str = "US") -> RecognitionResult:
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期", "广告SKU", "广告ASIN"]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Ad report missing required columns: {required}")

    project_match = _build_project_match(
        db,
        values=df["广告SKU"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
    )
    detected_end_date = _date_to_string_by_country(
        df["结束日期"].dropna().iloc[0] if not df["结束日期"].dropna().empty else None,
        country,
    )
    detected_start_date = _date_to_string_by_country(
        df["开始日期"].dropna().iloc[0] if not df["开始日期"].dropna().empty else None,
        country,
    )
    warnings_list: list[str] = []
    if "国家/地区" in df.columns and not df["国家/地区"].dropna().empty:
        file_country = _normalize_country(str(df["国家/地区"].dropna().iloc[0]))
        if file_country != country:
            warnings_list.append(f"文件内国家/地区为 {file_country}，当前按 {country} 处理")

    return RecognitionResult(
        report_type=AD_PRODUCT_REPORT,
        matched_columns=required,
        reason="命中开始日期 / 结束日期 / 广告SKU / 广告ASIN",
        date_input_mode="single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=country,
    )


def _recognize_ad_search_term_report(path: Path, country: str = "US") -> RecognitionResult:
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期"]
    if any(c not in df.columns for c in required):
        raise ValueError("Ad search term report missing required columns")

    return RecognitionResult(
        report_type="ad_search_term_report",
        matched_columns=required,
        reason="命中开始日期 / 结束日期，识别为商品推广搜索词报表",
        date_input_mode="single_detected",
        detected_date=_date_to_string(
            df["结束日期"].dropna().iloc[0] if not df["结束日期"].dropna().empty else None
        ),
        detected_start_date=_date_to_string(
            df["开始日期"].dropna().iloc[0] if not df["开始日期"].dropna().empty else None
        ),
        detected_end_date=_date_to_string(
            df["结束日期"].dropna().iloc[0] if not df["结束日期"].dropna().empty else None
        ),
        project_match={"status": "manual", "message": "该报表项目需手动选择"},
        row_count_preview=len(df.index),
        country=country,
    )


def _recognize_return_report(db: Session, path: Path, country: str = "US") -> RecognitionResult:
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["return-date", "sku"]
    if any(c not in df.columns for c in required):
        raise ValueError(f"Return report missing required columns: {required}")

    return_dates = pd.to_datetime(df["return-date"], utc=True, errors="coerce").dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not return_dates.empty:
        local_tz = COUNTRY_TIMEZONE.get(country, COUNTRY_TIMEZONE["US"])
        local_dates = return_dates.dt.tz_convert(local_tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

    project_match = _build_project_match(
        db,
        values=df["sku"].dropna().astype(str).tolist(),
        match_by="sku",
        country=country,
    )
    return RecognitionResult(
        report_type="return_report",
        matched_columns=required,
        reason="命中 return-date / sku 字段",
        date_input_mode="multi_auto"
        if detected_start_date and detected_end_date and detected_start_date != detected_end_date
        else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        project_match=project_match,
        row_count_preview=len(df.index),
        country=country,
    )


# ─── Main entry point ─────────────────────────────────────────────────────────


def recognize_file(
    db: Session,
    path: Path,
    country: str = "US",
    original_filename: str = "",
) -> RecognitionResult | None:
    """
    Recognize a file's report type.
    Returns None if the file doesn't match any known report type (skip the file).
    """
    normalized_country = _normalize_country(country)
    extension = path.suffix.lower()

    try:
        if extension == ".txt":
            header = (
                _read_text_with_encoding_fallback(path)
                .splitlines()[0]
                .strip()
                .lower()
            )
            if "snapshot-date" in header and "\tsku\t" in header:
                return _recognize_inventory_report(db, path, normalized_country)
            if "purchase-date" in header and "\tsku\t" in header:
                return _recognize_sales_report(db, path, normalized_country)
            if "return-date" in header and "\tsku\t" in header:
                return _recognize_return_report(db, path, normalized_country)
            return None

        if extension == ".csv":
            first_lines = _read_text_with_encoding_fallback(path).splitlines()[:8]
            joined = "\n".join(first_lines)
            if "Includes Amazon Marketplace" in joined:
                return _recognize_payment_report(db, path, normalized_country)
            return _recognize_business_report(db, path, normalized_country, original_filename)

        if extension == ".xlsx":
            df = _normalize_columns(_read_excel(path))
            columns = set(df.columns)
            if {"广告SKU", "广告ASIN"}.issubset(columns):
                return _recognize_ad_product_report(db, path, normalized_country)
            if {"开始日期", "结束日期", "投放", "客户搜索词"}.issubset(columns):
                return _recognize_ad_search_term_report(path, normalized_country)
            return None

        return None

    except Exception:
        # Don't raise — return None so the file is skipped
        return None
