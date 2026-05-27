"""Shared report-parsing functions used by both the backend service and autoReportUpload.

All functions here parse a report file into a list of row dicts ready for
SQLAlchemy bulk insert.  They have no knowledge of DB sessions or ORM models —
that responsibility stays with the caller.

The backend's ``product_analysis_source_service.py`` is the canonical source;
this module extracts the pure-parsing logic so autoReportUpload can import it
without duplicating code.
"""
from __future__ import annotations

import warnings
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

from app.utils.utils import (
    to_int as _to_int,
    to_decimal as _to_decimal,
    to_decimal_with_currency as _to_decimal_with_currency,
    sum_decimals as _sum_decimals,
    to_raw_row as _to_raw_row,
)

from app.utils.text_utils import (
    normalize_text as _normalize_text,
    normalize_asin as _normalize_asin,
    normalize_sku as _normalize_sku,
)

# ─── Constants ───────────────────────────────────────────────────────────────

SCOPE_INCLUDED = "included_product"
SCOPE_EXCLUDED_STORE = "excluded_store_level"
SCOPE_EXCLUDED_UNMAPPED = "excluded_unmapped"

OPENPYXL_MISSING_DEFAULT_STYLE_WARNING = (
    r"Workbook contains no default style, apply openpyxl's default"
)

PT_TIMEZONE = ZoneInfo("America/Los_Angeles")
COUNTRY_TIMEZONE: dict[str, ZoneInfo] = {
    "US": PT_TIMEZONE,
    "CA": PT_TIMEZONE,
    "MX": PT_TIMEZONE,
    "UK": ZoneInfo("Europe/London"),
    "DE": ZoneInfo("Europe/Berlin"),
    "FR": ZoneInfo("Europe/Paris"),
    "IT": ZoneInfo("Europe/Rome"),
    "ES": ZoneInfo("Europe/Madrid"),
    "JP": ZoneInfo("Asia/Tokyo"),
    "AU": ZoneInfo("Australia/Sydney"),
    "IN": ZoneInfo("Asia/Kolkata"),
}

from app.utils.constants import (
    TZ_OFFSET_BY_ABBR,
    INVENTORY_PROJECT_MATCH_MIN_ROWS,
    INVENTORY_PROJECT_MATCH_MIN_RATIO,
)

from app.utils.country import normalize_country


# ─── Column matching ─────────────────────────────────────────────────────────


def match_columns(
    columns: list[str],
    aliases: dict[str, list[str]],
    label: str,
) -> dict[str, str]:
    mapped: dict[str, str] = {}
    for target, candidates in aliases.items():
        for candidate in candidates:
            if candidate in columns:
                mapped[target] = candidate
                break
    missing = [key for key in aliases if key not in mapped]
    if missing:
        raise ValueError(f"{label} missing required columns: {missing}")
    return mapped


# ─── Scope classification ────────────────────────────────────────────────────


def classify_scope(
    *,
    sku: str | None,
    asin: str | None,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[str, str | None]:
    norm_sku = _normalize_sku(sku)
    norm_asin = _normalize_asin(asin)
    if not norm_sku and not norm_asin:
        return SCOPE_EXCLUDED_STORE, "missing sku/asin"
    if norm_sku in known_skus or norm_asin in known_asins:
        return SCOPE_INCLUDED, None
    return SCOPE_EXCLUDED_UNMAPPED, "sku/asin not found in product_costs"


# ─── Aging status ────────────────────────────────────────────────────────────


def build_aging_status(
    *,
    age_91_180: int,
    age_181_270: int,
    age_271_365: int,
    age_365_plus: int,
) -> str:
    if age_365_plus > 0:
        return "over_aged"
    if age_91_180 + age_181_270 + age_271_365 > 0:
        return "aging"
    return "fresh"


# ─── Sales counting rule ────────────────────────────────────────────────────


def is_counted_sales_status(
    status: str,
    purchase_date_pt: date,
    as_of_date_pt: date,
) -> bool:
    normalized = status.strip().lower()
    if normalized in {"cancelled", "canceled"}:
        return False
    age_days = (as_of_date_pt - purchase_date_pt).days
    if age_days <= 2:
        return normalized in {"pending", "unshipped", "shipped"}
    return normalized == "shipped"


# ─── Transaction timestamp parsing ──────────────────────────────────────────


def parse_transaction_at(row: Any) -> datetime | None:
    for key in ("date/time", "transaction date", "transaction_date", "date"):
        if key not in row:
            continue
        value = row.get(key)
        if value is None:
            continue
        parsed = _parse_utc_timestamp(value)
        if pd.isna(parsed):
            continue
        return parsed.to_pydatetime()
    return None


def _parse_utc_timestamp(value: Any) -> pd.Timestamp:
    text = _normalize_text(value)
    if text is None:
        return pd.NaT
    parts = text.rsplit(" ", 1)
    if len(parts) == 2 and parts[1] in TZ_OFFSET_BY_ABBR:
        try:
            naive = datetime.strptime(parts[0], "%b %d, %Y %I:%M:%S %p")
        except ValueError:
            pass
        else:
            tz = timezone(timedelta(hours=TZ_OFFSET_BY_ABBR[parts[1]]))
            return pd.Timestamp(naive.replace(tzinfo=tz).astimezone(UTC))
    return pd.to_datetime(text, utc=True, errors="coerce")


# ─── Excel reader (suppress openpyxl warning) ───────────────────────────────


def read_excel_no_warning(path: Path) -> pd.DataFrame:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            message=OPENPYXL_MISSING_DEFAULT_STYLE_WARNING,
            category=UserWarning,
        )
        return pd.read_excel(path, engine="openpyxl")


# ─── Per-report-type parsers ─────────────────────────────────────────────────


def parse_business_rows(
    path: Path,
    source_file_id: int,
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, encoding="utf-8-sig")
    df.columns = [str(col).strip() for col in df.columns]

    aliases = {
        "asin": ["（子）ASIN", "(子)ASIN", "子ASIN", "ASIN"],
        "page_views": ["页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"],
        "units_ordered": ["已订购商品数量", "Ordered Product Sales Units", "Units Ordered"],
        "sessions": ["会话数 - 总计", "会话数-总计", "Sessions - Total"],
        "ordered_sales_amount": [
            "已订购商品销售额",
            "Ordered Product Sales",
            "Ordered Product Sales Amount",
        ],
    }
    mapped = match_columns(df.columns, aliases, "Business report")

    payloads: list[dict[str, Any]] = []
    for index, row in df.iterrows():
        amount = _to_decimal_with_currency(row.get(mapped["ordered_sales_amount"]))
        payloads.append(
            {
                "source_file_id": source_file_id,
                "source_row_no": int(index) + 1,
                "asin": _normalize_text(row.get(mapped["asin"])),
                "page_views": _to_int(row.get(mapped["page_views"])),
                "units_ordered": _to_int(row.get(mapped["units_ordered"])),
                "sessions": _to_int(row.get(mapped["sessions"])),
                "ordered_sales_amount": amount,
                "raw_row": _to_raw_row(row.to_dict()),
            }
        )
    total = len(payloads)
    return payloads, total, total


def parse_payment_rows(
    df: pd.DataFrame,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict[str, Any]], int, int]:
    numeric_cols = [
        "quantity",
        "product sales",
        "shipping credits",
        "promotional rebates",
        "other",
        "selling fees",
        "fba fees",
    ]
    if "total" in df.columns:
        numeric_cols.append("total")
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)

    asin_col = "asin" if "asin" in df.columns else ("ASIN" if "ASIN" in df.columns else None)
    payloads: list[dict[str, Any]] = []
    included = 0

    transaction_status_col = next(
        (c for c in df.columns if c.strip().lower() in ("transaction status", "transaktionsstatus")),
        None,
    )
    transaction_release_date_col = next(
        (c for c in df.columns if c.strip().lower() in ("transaction release date", "freigabedatum der transaktion")),
        None,
    )

    for index, row in df.iterrows():
        sku = _normalize_text(row.get("sku"))
        asin = _normalize_text(row.get(asin_col)) if asin_col else None
        scope_status, scope_reason = classify_scope(
            sku=sku, asin=asin, known_skus=known_skus, known_asins=known_asins,
        )
        if scope_status == SCOPE_INCLUDED:
            included += 1

        total_amount = (
            _to_decimal(row.get("total"))
            if "total" in df.columns
            else _sum_decimals(
                row.get("product sales"),
                row.get("shipping credits"),
                row.get("promotional rebates"),
                row.get("other"),
                row.get("selling fees"),
                row.get("fba fees"),
            )
        )

        raw_release_date = row.get(transaction_release_date_col) if transaction_release_date_col else None
        parsed_release_date: datetime | None = None
        if raw_release_date is not None and not pd.isna(raw_release_date):
            ts = _parse_utc_timestamp(raw_release_date)
            if not pd.isna(ts):
                parsed_release_date = ts.to_pydatetime()

        payloads.append(
            {
                "source_file_id": source_file_id,
                "source_row_no": int(index) + 1,
                "transaction_at": parse_transaction_at(row),
                "transaction_type": _normalize_text(row.get("type")) or "UNKNOWN",
                "order_id": _normalize_text(
                    row.get("order id") if "order id" in df.columns else None,
                ),
                "sku": sku,
                "asin": asin,
                "quantity": _to_int(row.get("quantity")),
                "product_sales": _to_decimal(row.get("product sales")),
                "shipping_credits": _to_decimal(row.get("shipping credits")),
                "promotional_rebates": _to_decimal(row.get("promotional rebates")),
                "other_amount": _to_decimal(row.get("other")),
                "selling_fees": _to_decimal(row.get("selling fees")),
                "fba_fees": _to_decimal(row.get("fba fees")),
                "total_amount": total_amount,
                "scope_status": scope_status,
                "scope_reason": scope_reason,
                "transaction_status": _normalize_text(row.get(transaction_status_col)) if transaction_status_col else None,
                "transaction_release_date": parsed_release_date,
                "raw_row": _to_raw_row(row.to_dict()),
            }
        )

    return payloads, len(payloads), included


def parse_ad_rows(
    path: Path,
    source_file_id: int,
    known_skus: set[str],
    known_asins: set[str],
) -> tuple[list[dict[str, Any]], int, int]:
    df = read_excel_no_warning(path)
    df.columns = [str(col).strip() for col in df.columns]

    required = ["广告SKU", "展示量", "点击量", "花费", "7天总销售额", "7天总销售量(#)"]
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f"Ad report missing required columns: {missing}")

    asin_col = (
        "广告ASIN" if "广告ASIN" in df.columns else ("ASIN" if "ASIN" in df.columns else None)
    )
    payloads: list[dict[str, Any]] = []
    included = 0

    for index, row in df.iterrows():
        sku = _normalize_text(row.get("广告SKU"))
        asin = _normalize_text(row.get(asin_col)) if asin_col else None
        scope_status, scope_reason = classify_scope(
            sku=sku, asin=asin, known_skus=known_skus, known_asins=known_asins,
        )
        if scope_status == SCOPE_INCLUDED:
            included += 1
        payloads.append(
            {
                "source_file_id": source_file_id,
                "source_row_no": int(index) + 1,
                "sku": sku,
                "asin": asin,
                "impressions": _to_int(row.get("展示量")),
                "clicks": _to_int(row.get("点击量")),
                "spend": _to_decimal(row.get("花费")),
                "sales_7d": _to_decimal(row.get("7天总销售额")),
                "orders_7d": _to_int(row.get("7天总销售量(#)")),
                "scope_status": scope_status,
                "scope_reason": scope_reason,
                "raw_row": _to_raw_row(row.to_dict()),
            }
        )
    return payloads, len(payloads), included


def parse_inventory_rows(
    path: Path,
    source_file_id: int,
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig")
    df.columns = [str(col).strip() for col in df.columns]

    keep = [
        "sku",
        "asin",
        "available",
        "inv-age-0-to-90-days",
        "inv-age-91-to-180-days",
        "inv-age-181-to-270-days",
        "inv-age-271-to-365-days",
        "inv-age-365-plus-days",
        "recommended-action",
    ]
    existing = [col for col in keep if col in df.columns]
    if not existing:
        raise ValueError("Inventory report missing required columns")

    payloads: list[dict[str, Any]] = []
    for index, row in df.iterrows():
        available_qty = _to_int(row.get("available"))
        age_0_90 = _to_int(row.get("inv-age-0-to-90-days"))
        age_91_180 = _to_int(row.get("inv-age-91-to-180-days"))
        age_181_270 = _to_int(row.get("inv-age-181-to-270-days"))
        age_271_365 = _to_int(row.get("inv-age-271-to-365-days"))
        age_365_plus = _to_int(row.get("inv-age-365-plus-days"))
        stock_status = "out_of_stock" if available_qty <= 0 else "in_stock"
        aging_status = build_aging_status(
            age_91_180=age_91_180,
            age_181_270=age_181_270,
            age_271_365=age_271_365,
            age_365_plus=age_365_plus,
        )
        payloads.append(
            {
                "source_file_id": source_file_id,
                "source_row_no": int(index) + 1,
                "sku": _normalize_text(row.get("sku")),
                "asin": _normalize_text(row.get("asin")),
                "available_qty": available_qty,
                "age_0_90_qty": age_0_90,
                "age_91_180_qty": age_91_180,
                "age_181_270_qty": age_181_270,
                "age_271_365_qty": age_271_365,
                "age_365_plus_qty": age_365_plus,
                "recommended_action": _normalize_text(row.get("recommended-action")),
                "stock_status": stock_status,
                "aging_status": aging_status,
                "raw_row": _to_raw_row(row.to_dict()),
            }
        )
    total = len(payloads)
    return payloads, total, total


def validate_inventory_rows_against_project_mapping(
    rows: list[dict[str, Any]],
    *,
    project_name: str,
    country: str,
    known_skus: set[str],
    known_asins: set[str],
) -> None:
    if not known_skus and not known_asins:
        return

    identifiable_rows = 0
    matched_rows = 0
    sample_unmatched: list[str] = []

    for row in rows:
        sku = _normalize_sku(row.get("sku"))
        asin = _normalize_asin(row.get("asin"))
        if not sku and not asin:
            continue
        identifiable_rows += 1
        if sku in known_skus or asin in known_asins:
            matched_rows += 1
            continue
        if len(sample_unmatched) < 5:
            sample_unmatched.append(str(row.get("sku") or row.get("asin") or "UNKNOWN"))

    if identifiable_rows == 0:
        raise ValueError(
            f"Inventory report validation failed: no identifiable SKU/ASIN rows found "
            f"for project {project_name} ({country})"
        )

    match_ratio = matched_rows / identifiable_rows
    if matched_rows == 0 or (
        identifiable_rows >= INVENTORY_PROJECT_MATCH_MIN_ROWS
        and match_ratio < INVENTORY_PROJECT_MATCH_MIN_RATIO
    ):
        sample_text = ", ".join(sample_unmatched) if sample_unmatched else "N/A"
        raise ValueError(
            "Inventory report validation failed: "
            f"{matched_rows}/{identifiable_rows} rows matched active SKU info "
            f"for project {project_name} ({country}), "
            f"match rate {match_ratio:.0%}. "
            f"Please confirm the inventory file belongs to the selected project. "
            f"Unmatched sample: {sample_text}"
        )


def detect_countries_in_sales_file(path: Path) -> list[str]:
    """Detect all marketplace countries in a sales report file.

    Reads the sales-channel column and extracts unique country codes.
    Returns list like ['UK', 'DE'].
    """
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig")
    df.columns = [str(col).strip() for col in df.columns]

    # Try common column names for sales channel
    channel_col = None
    for col_name in ["sales-channel", "sales channel", "Sales Channel"]:
        if col_name in df.columns:
            channel_col = col_name
            break

    if channel_col is None:
        return ["US"]  # Default fallback

    countries: set[str] = set()
    for value in df[channel_col].dropna():
        text = str(value).strip().lower()
        if "amazon.co.uk" in text or text == "amazon.co.uk":
            countries.add("UK")
        elif "amazon.de" in text or text == "amazon.de":
            countries.add("DE")
        elif "amazon.com" in text or text == "amazon.com":
            countries.add("US")
        elif "amazon.fr" in text or text == "amazon.fr":
            countries.add("FR")

    return list(countries) if countries else ["US"]


def parse_sales_rows(
    path: Path,
    source_file_id: int,
    count_as_of_date_pt: date | None = None,
    *,
    country: str = "US",
) -> tuple[list[dict[str, Any]], int, int]:
    df = pd.read_csv(path, sep="\t", encoding="utf-8-sig")
    df.columns = [str(col).strip() for col in df.columns]
    required = [
        "amazon-order-id",
        "purchase-date",
        "order-status",
        "sku",
        "asin",
        "quantity",
        "item-price",
    ]
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise ValueError(f"Sales report missing required columns: {missing}")

    normalized_country = normalize_country(country)
    local_tz = COUNTRY_TIMEZONE.get(normalized_country, PT_TIMEZONE)
    effective_as_of = count_as_of_date_pt or datetime.now(UTC).astimezone(local_tz).date()
    payloads: list[dict[str, Any]] = []
    included = 0

    # Try to find sales channel column for per-row country detection
    channel_col = None
    for col_name in ["sales-channel", "sales channel", "Sales Channel"]:
        if col_name in df.columns:
            channel_col = col_name
            break

    def extract_row_country(row_val: Any) -> str:
        """Extract country code from sales channel value."""
        if channel_col is None or row_val is None or pd.isna(row_val):
            return normalized_country
        text = str(row_val).strip().lower()
        if "amazon.co.uk" in text:
            return "UK"
        elif "amazon.de" in text:
            return "DE"
        elif "amazon.fr" in text:
            return "FR"
        return normalized_country

    for index, row in df.iterrows():
        order_id = _normalize_text(row.get("amazon-order-id"))
        parsed_utc = pd.to_datetime(row.get("purchase-date"), utc=True, errors="coerce")
        if order_id is None or pd.isna(parsed_utc):
            continue

        purchase_at_utc = parsed_utc.to_pydatetime()
        purchase_at_local_aware = purchase_at_utc.astimezone(local_tz)
        purchase_at_pt = purchase_at_local_aware.replace(tzinfo=None)
        purchase_date_pt = purchase_at_local_aware.date()
        status_text = (_normalize_text(row.get("order-status")) or "").strip()
        counted = is_counted_sales_status(status_text, purchase_date_pt, effective_as_of)
        if counted:
            included += 1

        # Extract per-row country from sales channel
        row_country = extract_row_country(row.get(channel_col)) if channel_col else normalized_country

        payloads.append(
            {
                "source_file_id": source_file_id,
                "source_row_no": int(index) + 1,
                "country": row_country,
                "amazon_order_id": order_id,
                "purchase_at_utc": purchase_at_utc,
                "purchase_at_pt": purchase_at_pt,
                "purchase_date_pt": purchase_date_pt,
                "order_status": status_text or "UNKNOWN",
                "sku": _normalize_text(row.get("sku")),
                "asin": _normalize_text(row.get("asin")),
                "quantity": _to_int(row.get("quantity")),
                "item_price": _to_decimal(row.get("item-price")),
                "shipping_price": _to_decimal(row.get("shipping-price")),
                "currency": _normalize_text(row.get("currency")),
                "is_counted_sales": counted,
                "status_rule_version": 1,
                "raw_row": _to_raw_row(row.to_dict()),
            }
        )
    return payloads, len(payloads), included


# ─── Return report parsing ─────────────────────────────────────────────────


def parse_return_rows(
    df: pd.DataFrame,
) -> tuple[list[dict[str, Any]], list[datetime]]:
    """Parse a return-report TSV/DataFrame into row dicts.

    This is the **single source of truth** for return-report row parsing,
    shared by the web upload pipeline (``return_analysis.persistence``) and
    the RPA pipeline (``autoReportUpload.processor``).

    Args:
        df: DataFrame already read from the return-report TSV file.
            Columns are expected to be stripped of whitespace.

    Returns:
        ``(rows, raw_datetimes)`` where *rows* is a list of dicts suitable
        for bulk insert (without ``source_file_id`` / ``source_row_no``,
        which are caller-specific), and *raw_datetimes* is the list of
        parsed UTC datetimes for date-range calculation.

    Raises:
        ValueError: if required columns (``return-date``, ``sku``) are missing.
    """
    required = ["return-date", "sku"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"缺少必要字段: {missing}")

    seen_keys: set[tuple] = set()
    rows: list[dict[str, Any]] = []
    raw_datetimes: list[datetime] = []

    for idx, row in df.iterrows():
        original_dt_str = str(row.get("return-date", "")).strip()
        if not original_dt_str or pd.isna(row.get("return-date")):
            continue
        parsed = pd.to_datetime(original_dt_str, errors="coerce", utc=True)
        if parsed is None or pd.isna(parsed):
            continue
        original_dt = parsed.to_pydatetime()
        raw_datetimes.append(original_dt)

        order_id = str(row.get("order-id", "")).strip()
        sku = str(row.get("sku", "")).strip()
        asin = str(row.get("asin", "")) if pd.notna(row.get("asin")) else None
        fnsku = str(row.get("fnsku", "")) if pd.notna(row.get("fnsku")) else None
        product_name = (
            str(row.get("product-name", "")) if pd.notna(row.get("product-name")) else None
        )
        quantity = int(row.get("quantity", 1)) if pd.notna(row.get("quantity")) else 1
        fulfillment_center_id = (
            str(row.get("fulfillment-center-id", ""))
            if pd.notna(row.get("fulfillment-center-id"))
            else None
        )
        detailed_disposition = str(row.get("detailed-disposition", "")).strip()
        reason = str(row.get("reason", "")).strip()
        status = str(row.get("status", "")).strip()
        license_plate = (
            str(row.get("license-plate-number", ""))
            if pd.notna(row.get("license-plate-number"))
            else ""
        )
        customer_comments = (
            str(row.get("customer-comments", ""))
            if pd.notna(row.get("customer-comments"))
            else ""
        )

        # In-file dedup on file-level subset of uq_return_event columns.
        # project_id and country are added by the caller.
        # Use UTC date here; the DB constraint uses local date which may
        # differ at timezone boundaries.  Being conservative (not deduping
        # borderline cases) is safe — the DB UPSERT handles the rest.
        dedupe_key = (order_id, sku, original_dt.date(), license_plate)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        rows.append({
            "return_date_raw": original_dt,  # caller converts to local date
            "order_id": order_id,
            "sku": sku,
            "asin": asin,
            "fnsku": fnsku,
            "product_name": product_name,
            "quantity": quantity,
            "fulfillment_center_id": fulfillment_center_id,
            "detailed_disposition": detailed_disposition,
            "reason": reason,
            "status": status,
            "license_plate_number": license_plate,
            "original_return_datetime": original_dt_str,
            "customer_comments": customer_comments if customer_comments else None,
            "raw_row": _to_raw_row(row.to_dict()),
        })

    return rows, raw_datetimes
