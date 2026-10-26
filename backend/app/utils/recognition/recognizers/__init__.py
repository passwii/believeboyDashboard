"""Per-type recognizers for report files (no FastAPI/SQLAlchemy deps)."""

from __future__ import annotations

from pathlib import Path

from app.utils.payment_locale import (
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
        warnings_list.append(
            f"文件内检测到 {detected_country}，当前按所选站点 {country} 处理"
        )

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

    purchase_dates = to_datetime(
        df["purchase-date"], utc=True, errors="coerce"
    ).dropna()
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if not purchase_dates.empty:
        from zoneinfo import ZoneInfo
        from app.utils.recognition.patterns import COUNTRY_TIMEZONE

        tz = ZoneInfo(COUNTRY_TIMEZONE.get(country, "America/Los_Angeles"))
        local_dates = purchase_dates.dt.tz_convert(tz).dt.strftime("%Y-%m-%d")
        detected_start_date = str(local_dates.min())
        detected_end_date = str(local_dates.max())

    is_periodic = bool(
        detected_start_date
        and detected_end_date
        and detected_start_date != detected_end_date
    )

    warnings_list: list[str] = []
    detected_country = _detect_country_from_sales_channel(df)
    if not detected_country:
        detected_country = _detect_country_from_currency(df)
    if detected_country and detected_country != country:
        warnings_list.append(
            f"文件内 sales-channel 为 {detected_country}，当前按所选站点 {country} 处理"
        )

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


def recognize_business_report(
    path: Path, country: str = "US", original_filename: str = ""
) -> RecognitionResult:
    """Recognize business report (.csv with ASIN column)."""
    df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
    asin_column = next(
        (
            column
            for column in [
                "（子）asin",  # 中文界面: （子）ASIN
                "(子)asin",  # 半角全角混用
                "子asin",  # 无括号
                "asin",  # 退化匹配（无子项标记）
                "(child) asin",  # EN 界面: (Child) ASIN
                "(parent) asin",  # EN 界面: (Parent) ASIN,叶子 ASIN 缺失时的退化
            ]
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
        warnings_list.append(
            f"文件内销售额符号检测为 {detected_country}，当前按所选站点 {country} 处理"
        )

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
        (
            c
            for c in df.columns
            if "date/time" in c.lower() or "transaction date" in c.lower()
        ),
        None,
    )
    detected_start_date: str | None = None
    detected_end_date: str | None = None
    if date_col:
        import re

        dates: list[str] = []
        for raw in df[date_col].dropna():
            text = str(raw).strip()
            cleaned = re.sub(r"\s+(PST|PDT|GMT|UTC)\s*$", "", text, flags=re.IGNORECASE)
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
        warnings_list.append(
            f"文件内检测到 {detected_country}，当前按所选站点 {country} 处理"
        )

    is_range = bool(
        detected_start_date
        and detected_end_date
        and detected_start_date != detected_end_date
    )

    return RecognitionResult(
        report_type="payment_report",
        matched_columns=["sku"],
        reason="命中付款报告表头与 sku 字段",
        date_input_mode="range_auto"
        if is_range
        else ("single_auto" if detected_start_date else "single_manual"),
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        warnings=warnings_list,
        country=detected_country or country,
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
        if detected_start_date
        and detected_end_date
        and detected_start_date != detected_end_date
        else "single_detected",
        detected_date=detected_end_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        country=country,
    )


# ─── Inventory Ledger (Amazon 库存分类账: Summary 22 列 / Detail 16 列) ───────


class LedgerRecognitionError(ValueError):
    """结构化识别失败：库存分类账部分签名或 Summary/Detail 签名冲突。

    与普通识别失败（返回 None，继续探测其他报表）不同，此类错误必须
    原样抛给调用方，不能静默降级为 business_report 或 None。
    """


# 列名签名必须使用 _normalize_columns 的实际产物（strip + lowercase，
# 保留空格），与 ingestion 层 _normalize_header（空格转下划线）不同。
# 真实表头 "Starting Warehouse Balance" 标准化后是 "starting warehouse balance"。
_INVENTORY_LEDGER_SUMMARY_REQUIRED_COLUMNS = {
    "date",
    "msku",
    "disposition",
    "location",
    "starting warehouse balance",
    "ending warehouse balance",
}
_INVENTORY_LEDGER_DETAIL_REQUIRED_COLUMNS = {
    "date",
    "msku",
    "event type",
    "quantity",
    "fulfillment center",
    "disposition",
}

# 强特征：Summary 两列均为分类账独有，任一出现即视为部分签名；
# Detail 三列中 "quantity" 在其它 Amazon 导出（普通商品/业务报表）中常见，
# 单列命中不足以认定与库存分类账相关，需命中 ≥2 列才进入部分签名校验。
_INVENTORY_LEDGER_SUMMARY_STRONG_COLUMNS = {
    "starting warehouse balance",
    "ending warehouse balance",
}
_INVENTORY_LEDGER_DETAIL_STRONG_COLUMNS = {
    "event type",
    "quantity",
    "fulfillment center",
}


def _detect_ledger_dates(
    df: "pd.DataFrame", original_filename: str
) -> tuple[str | None, str | None, str | None]:
    """从 Date 列（MM/DD/YYYY 或 MM/YYYY）和文件名提取日期信息。"""
    import re
    from datetime import date, datetime

    detected_start_date = None
    detected_end_date = None
    detected_date = None
    parsed_dates: list[date] = []
    has_day_level_date = False
    if "date" in df.columns:
        for raw_date in df["date"].dropna().astype(str):
            value = raw_date.strip()
            parsed = None
            for fmt in ("%m/%d/%Y", "%m/%Y"):
                try:
                    parsed = datetime.strptime(value, fmt).date()
                    break
                except ValueError:
                    continue
            if parsed is None:
                continue
            parsed_dates.append(parsed)
            if not re.fullmatch(r"\d{1,2}/\d{4}", value):
                has_day_level_date = True

        if parsed_dates:
            min_d = min(parsed_dates)
            max_d = max(parsed_dates)
            if has_day_level_date:
                detected_start_date = min_d.strftime("%Y-%m-%d")
                detected_end_date = max_d.strftime("%Y-%m-%d")
                detected_date = detected_start_date
            else:
                detected_date = min_d.strftime("%Y-%m-%d")

    # Only use a filename date when the CSV itself has no usable date. Require
    # an explicit 20xx prefix so arbitrary numeric filenames are not treated as
    # compact YYYYMMDD values (e.g. 99539020752.csv).
    if not detected_date and original_filename:
        m = re.search(r"(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)", original_filename)
        if m:
            try:
                detected_date = date(
                    int(m.group(1)), int(m.group(2)), int(m.group(3))
                ).isoformat()
            except ValueError:
                pass
    return detected_date, detected_start_date, detected_end_date


def _build_ledger_result(
    kind: str, df: "pd.DataFrame", country: str, original_filename: str
) -> RecognitionResult:
    if kind == "summary":
        report_type = "inventory_ledger_summary"
        matched = sorted(_INVENTORY_LEDGER_SUMMARY_REQUIRED_COLUMNS)
        reason = "命中 Amazon Inventory Ledger Summary 22 列签名"
    else:
        report_type = "inventory_ledger_detail"
        matched = sorted(_INVENTORY_LEDGER_DETAIL_REQUIRED_COLUMNS)
        reason = "命中 Amazon Inventory Ledger Detail 16 列签名"

    detected_date, detected_start_date, detected_end_date = _detect_ledger_dates(
        df, original_filename
    )
    if detected_start_date:
        date_input_mode = "range_auto"
    elif detected_date:
        date_input_mode = "single_auto"
    else:
        date_input_mode = "single_manual"
    return RecognitionResult(
        report_type=report_type,
        matched_columns=matched,
        reason=reason,
        date_input_mode=date_input_mode,
        detected_date=detected_date,
        detected_start_date=detected_start_date,
        detected_end_date=detected_end_date,
        row_count_preview=len(df.index),
        country=country,
    )


def _recognize_inventory_ledger_columns(
    df: "pd.DataFrame", country: str, original_filename: str
) -> RecognitionResult | None:
    """由已标准化的 DataFrame 计算库存分类账识别结果。

    识别矩阵：
    - 完整 Summary 签名 → ``inventory_ledger_summary``
    - 完整 Detail 签名 → ``inventory_ledger_detail``
    - 两套签名同时完整 / 同时出现两类强特征 → ``LedgerRecognitionError``（冲突）
    - 仅 Summary 强特征但不完整 → ``LedgerRecognitionError``（列出缺失字段）
    - Detail 强特征命中 ≥2 列但不完整 → ``LedgerRecognitionError``（列出缺失字段）
    - 无任何强特征 → ``None``（调用方继续识别其他报表）
    """
    columns = set(df.columns)
    summary_complete = _INVENTORY_LEDGER_SUMMARY_REQUIRED_COLUMNS <= columns
    detail_complete = _INVENTORY_LEDGER_DETAIL_REQUIRED_COLUMNS <= columns
    if summary_complete and detail_complete:
        raise LedgerRecognitionError(
            "库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段"
        )
    if summary_complete:
        return _build_ledger_result("summary", df, country, original_filename)
    if detail_complete:
        return _build_ledger_result("detail", df, country, original_filename)

    summary_strong = bool(_INVENTORY_LEDGER_SUMMARY_STRONG_COLUMNS & columns)
    # Detail 强特征需命中 ≥2 列：单列 "quantity" 在其它 Amazon 导出中常见，
    # 不足以免误判普通 CSV 为库存分类账（summary 强特征无此问题）。
    detail_strong = len(_INVENTORY_LEDGER_DETAIL_STRONG_COLUMNS & columns) >= 2
    if summary_strong and detail_strong:
        raise LedgerRecognitionError(
            "库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段"
        )
    if summary_strong:
        missing = sorted(_INVENTORY_LEDGER_SUMMARY_REQUIRED_COLUMNS - columns)
        raise LedgerRecognitionError(f"无法识别库存分类账 Summary：缺少 {missing}")
    if detail_strong:
        missing = sorted(_INVENTORY_LEDGER_DETAIL_REQUIRED_COLUMNS - columns)
        raise LedgerRecognitionError(f"无法识别库存分类账 Detail：缺少 {missing}")
    return None


def recognize_inventory_ledger(
    path: Path, country: str = "US", original_filename: str = ""
) -> RecognitionResult | None:
    """Recognize Amazon Inventory Ledger CSV as one of two exclusive types.

    - Summary（一览视图，22 列）→ ``inventory_ledger_summary``
    - Detail（详细视图，16 列）→ ``inventory_ledger_detail``

    Returns None when the file has no inventory-ledger strong features.
    Raises ``LedgerRecognitionError`` for partial signatures / conflicts.
    Never returns the legacy ``inventory_ledger`` type.
    """
    df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
    return _recognize_inventory_ledger_columns(df, country, original_filename)


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
                _read_text_with_encoding_fallback(path).splitlines()[0].strip().lower()
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

            # 4. Check for inventory ledger (Summary 22 列 / Detail 16 列).
            #    Must check BEFORE business report because ledger also has "asin"
            #    column. 部分签名/冲突抛 LedgerRecognitionError（结构化失败），
            #    不得降级为 business_report 或 None。
            try:
                df_ledger = _normalize_columns(
                    _read_csv_with_encoding_fallback(path, sep=",")
                )
            except Exception:
                df_ledger = None
            if df_ledger is not None:
                ledger_result = _recognize_inventory_ledger_columns(
                    df_ledger, normalized_country, original_filename
                )
                if ledger_result is not None:
                    return ledger_result

            # 5. Check for business report (has child ASIN columns)
            try:
                df = _normalize_columns(_read_csv_with_encoding_fallback(path, sep=","))
                asin_col = next(
                    (
                        c
                        for c in [
                            "（子）asin",
                            "(子)asin",
                            "子asin",
                            "asin",
                            "(child) asin",
                            "(parent) asin",
                        ]
                        if c in df.columns
                    ),
                    None,
                )
                if asin_col:
                    return recognize_business_report(
                        path, normalized_country, original_filename
                    )
            except Exception:
                pass

            # No report type matched — return None (recognition failure)
            return None

        # ad 报表 (.xlsx) 全部走 B 表 (app.services.ad.upload.specs)，
        # 此处不再识别 A 表 ad_*_report。CLAUDE.md 注明 ad_product_report 已切到 C 表。
        return None

    except LedgerRecognitionError:
        # 库存分类账部分签名/冲突是结构化识别失败，必须抛给调用方，
        # 不能吞掉后当作"无法识别"（None）处理。
        raise
    except Exception:
        return None
