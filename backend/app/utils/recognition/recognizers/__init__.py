"""Per-type recognizers for report files (no FastAPI/SQLAlchemy deps)."""
from __future__ import annotations

from pathlib import Path

from app.services.payment.locale import (
    read_payment_report_dataframe,
    is_payment_report_by_columns,
    PAYMENT_REPORT_HEADER_MARKERS,
)
from app.utils.country import normalize_country
from app.utils.recognition.models import RecognitionResult
from app.utils.recognition.patterns import (
    _date_to_string_by_country,
    _detect_country_from_currency,
    _detect_country_from_marketplace,
    _detect_country_from_sales_amount_symbol,
    _detect_country_from_sales_channel,
    _normalize_columns,
    _normalize_country,
    _read_csv_with_encoding_fallback,
    _read_excel,
    _read_text_with_encoding_fallback,
    _extract_date_from_filename,
    AD_PRODUCT_REPORT,
)


def recognize_inventory_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize inventory report (.txt with snapshot-date / sku / asin)."""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["snapshot-date", "sku", "asin"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Inventory report missing required columns: {missing}")

    detected_date = None
    if not df["snapshot-date"].dropna().empty:
        detected_date = _date_to_string_by_country(
            df["snapshot-date"].dropna().iloc[0], country
        )

    warnings_list: list[str] = []
    detected_country = _detect_country_from_marketplace(df)
    if not detected_country:
        detected_country = _detect_country_from_currency(df)
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内检测到 {detected_country}，当前按所选站点 {country} 处理")

    return RecognitionResult(
        report_type="inventory_report",
        matched_columns=required,
        reason="命中 snapshot-date / sku / asin",
        date_input_mode="single_detected" if detected_date else "single_manual",
        detected_date=detected_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def recognize_sales_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize sales report (.txt with purchase-date / sku / asin)."""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["purchase-date", "sku", "asin"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Sales report missing required columns: {missing}")

    from pandas import to_datetime
    purchase_dates = to_datetime(df["purchase-date"], utc=True, errors="coerce").dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not purchase_dates.empty:
        from zoneinfo import ZoneInfo
        from app.utils.recognition.patterns import COUNTRY_TIMEZONE
        tz = ZoneInfo(COUNTRY_TIMEZONE.get(country, "America/Los_Angeles"))
        local_dates = purchase_dates.dt.tz_convert(tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

    is_periodic = bool(detected_start_date and detected_end_date and detected_start_date != detected_end_date)

    warnings_list: list[str] = []
    detected_country = _detect_country_from_sales_channel(df)
    if not detected_country:
        detected_country = _detect_country_from_currency(df)
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内 sales-channel 为 {detected_country}，当前按所选站点 {country} 处理")

    return RecognitionResult(
        report_type="sales_report",
        matched_columns=required,
        reason="命中 purchase-date / sku / asin",
        date_input_mode="multi_auto" if is_periodic else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def recognize_business_report(path: Path, country: str = "US", original_filename: str = "") -> RecognitionResult:
    """Recognize business report (.csv with ASIN column)."""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
    asin_column = next(
        (
            column
            for column in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"]
            if column in df.columns
        ),
        None,
    )
    if not asin_column:
        raise ValueError("Business report missing child ASIN column")

    detected_date = _extract_date_from_filename(original_filename)
    warnings_list: list[str] = []
    if detected_date:
        warnings_list.append(f"从文件名识别日期：{detected_date}")

    # Detect country from sales amount currency symbol (€ for DE, £ for UK)
    detected_country = _detect_country_from_sales_amount_symbol(df)
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内销售额符号检测为 {detected_country}，当前按所选站点 {country} 处理")

    return RecognitionResult(
        report_type="business_report",
        matched_columns=[asin_column],
        reason="命中（子）ASIN字段",
        date_input_mode="single_detected" if detected_date else "single_manual",
        detected_date=detected_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def recognize_payment_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize payment report (.csv with 'Includes Amazon Marketplace' header)."""
    try:
        df = read_payment_report_dataframe(path, country=country)
    except Exception:
        raise ValueError("Failed to parse payment report")

    # Detect country from marketplace column
    detected_country: str | None = None
    mkt_col = next((c for c in df.columns if "marketplace" in c.lower()), None)
    if mkt_col and not df[mkt_col].dropna().empty:
        mkt_val = str(df[mkt_col].dropna().iloc[0]).strip().lower()
        if "amazon.com" in mkt_val:
            detected_country = "US"
        elif "amazon.de" in mkt_val:
            detected_country = "DE"
        elif "amazon.co.uk" in mkt_val:
            detected_country = "UK"

    # Extract date range from transaction timestamps
    date_col = next(
        (c for c in df.columns if "date/time" in c.lower() or "transaction date" in c.lower()),
        None,
    )
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if date_col:
        import re
        dates: list[str] = []
        for raw in df[date_col].dropna():
            text = str(raw).strip()
            cleaned = re.sub(r'\s+(PST|PDT|GMT|UTC)\s*$', '', text, flags=re.IGNORECASE)
            try:
                import pandas as pd
                dt = pd.to_datetime(cleaned, errors="coerce")
                if dt is not None and not pd.isna(dt):
                    dates.append(dt.strftime("%Y-%m-%d"))
            except Exception:
                continue
        unique_dates = sorted(set(dates))
        if unique_dates:
            detected_start_date = unique_dates[0]
            detected_end_date = unique_dates[-1]

    df = _normalize_columns(df)
    if "sku" not in df.columns:
        raise ValueError("Payment report missing sku column")

    warnings_list: list[str] = []
    if detected_country and detected_country != country:
        warnings_list.append(f"文件内检测到 {detected_country}，当前按所选站点 {country} 处理")

    is_range = bool(detected_start_date and detected_end_date and detected_start_date != detected_end_date)

    return RecognitionResult(
        report_type="payment_report",
        matched_columns=["sku"],
        reason="命中付款报告表头与 sku 字段",
        date_input_mode="range_auto" if is_range else ("single_auto" if detected_start_date else "single_manual"),
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def recognize_ad_product_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize ad product report (.xlsx with 开始日期 / 结束日期 / 广告SKU / 广告ASIN)."""
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期", "广告SKU", "广告ASIN"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Ad report missing required columns: {missing}")

    detected_end_date = None
    if not df["结束日期"].dropna().empty:
        detected_end_date = _date_to_string_by_country(df["结束日期"].dropna().iloc[0], country)

    detected_start_date = None
    if not df["开始日期"].dropna().empty:
        detected_start_date = _date_to_string_by_country(df["开始日期"].dropna().iloc[0], country)

    warnings_list: list[str] = []
    detected_country: str | None = None
    if "国家/地区" in df.columns and not df["国家/地区"].dropna().empty:
        file_country_val = str(df["国家/地区"].dropna().iloc[0]).strip().upper()
        if file_country_val in {"DE", "GERMANY", "德国", "德国站"}:
            detected_country = "DE"
        elif file_country_val in {"UK", "GB", "UNITED KINGDOM", "英国", "英国站"}:
            detected_country = "UK"  # 🔶 Reserved
        elif file_country_val in {"US", "USA", "美国", "美国站"}:
            detected_country = "US"
        if detected_country and detected_country != country:
            warnings_list.append(f"文件内国家/地区为 {detected_country}，当前按所选站点 {country} 处理")

    return RecognitionResult(
        report_type=AD_PRODUCT_REPORT,
        matched_columns=required,
        reason="命中开始日期 / 结束日期 / 广告SKU / 广告ASIN",
        date_input_mode="single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
    )


def recognize_ad_search_term_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize ad search term report (.xlsx with 开始日期 / 结束日期 / 投放 / 客户搜索词)."""
    df = _normalize_columns(_read_excel(path))
    required = ["开始日期", "结束日期"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError("Ad search term report missing required columns")

    from pandas import to_datetime
    end_date = None
    if not df["结束日期"].dropna().empty:
        parsed = to_datetime(df["结束日期"].dropna().iloc[0], errors="coerce")
        if parsed is not None and not parsed.isna():
            end_date = parsed.strftime("%Y-%m-%d")

    start_date = None
    if not df["开始日期"].dropna().empty:
        parsed = to_datetime(df["开始日期"].dropna().iloc[0], errors="coerce")
        if parsed is not None and not parsed.isna():
            start_date = parsed.strftime("%Y-%m-%d")

    return RecognitionResult(
        report_type="ad_search_term_report",
        matched_columns=required,
        reason="命中开始日期 / 结束日期，识别为商品推广搜索词报表",
        date_input_mode="single_detected",
        detected_date=end_date,
        detected_start_date=start_date,
        detected_end_date=end_date,
        row_count_preview=len(df.index),
        country=country,
    )


def recognize_return_report(path: Path, country: str = "US") -> RecognitionResult:
    """Recognize return report (.txt with return-date / sku)."""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path))
    required = ["return-date", "sku"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Return report missing required columns: {missing}")

    from pandas import to_datetime
    return_dates = to_datetime(df["return-date"], utc=True, errors="coerce").dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not return_dates.empty:
        from zoneinfo import ZoneInfo
        from app.utils.recognition.patterns import COUNTRY_TIMEZONE
        tz = ZoneInfo(COUNTRY_TIMEZONE.get(country, "America/Los_Angeles"))
        local_dates = return_dates.dt.tz_convert(tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

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
        row_count_preview=len(df.index),
        country=country,
    )



def recognize_file(
    path: Path,
    country: str = "US",
    original_filename: str = "",
) -> RecognitionResult | None:
    """Main entry point: recognize a file's report type.

    Returns None if the file doesn't match any known report type.
    """
    normalized_country = _normalize_country(country) if country else "US"
    extension = path.suffix.lower()

    # Initialize df to avoid UnboundLocalError when xlsx branch accesses df
    # after an exception occurred in the csv branch (where df would be defined)
    df: "pd.DataFrame | None" = None

    try:
        if extension == ".txt":
            header = (
                _read_text_with_encoding_fallback(path)
                .splitlines()[0]
                .strip()
                .lower()
            )
            if "snapshot-date" in header and "\tsku\t" in header:
                return recognize_inventory_report(path, normalized_country)
            if "purchase-date" in header and "\tsku\t" in header:
                return recognize_sales_report(path, normalized_country)
            if "return-date" in header and "\tsku\t" in header:
                return recognize_return_report(path, normalized_country)
            return None

        if extension == ".csv":
            # 1. Check filename for Transaction (payment reports often have this in filename)
            if "transaction" in original_filename.lower():
                return recognize_payment_report(path, normalized_country)

            first_lines = _read_text_with_encoding_fallback(path).splitlines()[:15]
            joined = "\n".join(first_lines)

            # 2. Check for header markers (English or German)
            for marker in PAYMENT_REPORT_HEADER_MARKERS:
                if marker in joined:
                    return recognize_payment_report(path, normalized_country)

            # 3. Check by column names (uses locale alias table for US/DE)
            if is_payment_report_by_columns(path):
                return recognize_payment_report(path, normalized_country)

            # 4. Check for business report (has child ASIN columns)
            try:
                df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
                asin_col = next(
                    (c for c in ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"] if c in df.columns),
                    None,
                )
                if asin_col:
                    return recognize_business_report(path, normalized_country, original_filename)
            except Exception:
                pass

            # No report type matched — return None (recognition failure)
            return None

        if extension == ".xlsx":
            df = _normalize_columns(_read_excel(path))
            columns = set(df.columns)
            if {"广告SKU", "广告ASIN"}.issubset(columns):
                return recognize_ad_product_report(path, normalized_country)
            if {"开始日期", "结束日期", "投放", "客户搜索词"}.issubset(columns):
                return recognize_ad_search_term_report(path, normalized_country)
            return None

        return None

    except Exception:
        return None
