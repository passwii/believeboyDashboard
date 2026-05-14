"""Monthly report service utilities.

Utility functions specific to monthly report processing.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any

from app.utils.constants import TWO_DP, TZ_OFFSET_BY_ABBR


def _month_to_date(value: str) -> date:
    """Convert YYYY-MM string to date (first day of month)."""
    parsed = datetime.strptime(value, "%Y-%m").date().replace(day=1)
    return parsed


def _month_to_str(value: date) -> str:
    """Convert date to YYYY-MM string."""
    return value.strftime("%Y-%m")


def _add_months(base: date, delta: int) -> date:
    """Add or subtract months from a date."""
    month_index = (base.year * 12 + (base.month - 1)) + delta
    year = month_index // 12
    month = month_index % 12 + 1
    return date(year, month, 1)


def _month_range(start: date, end: date) -> list[str]:
    """Generate list of YYYY-MM strings from start to end (inclusive)."""
    cursor = start
    months: list[str] = []
    while cursor <= end:
        months.append(_month_to_str(cursor))
        cursor = _add_months(cursor, 1)
    return months


def _normalize_key(value: str | None) -> str:
    """Normalize key: lowercase + trim."""
    return (value or "").strip().lower()


def _to_decimal(value: Any) -> Decimal:
    """Convert value to Decimal safely, handling empty strings and commas."""
    if value is None:
        return Decimal("0")
    text = str(value).strip().replace(",", "")
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def _to_float(value: Decimal | float | int | None) -> float:
    """Convert value to float safely."""
    if value is None:
        return 0.0
    return float(value)


def _round2(value: Decimal) -> Decimal:
    """Round decimal to 2 decimal places."""
    return value.quantize(TWO_DP, rounding=ROUND_HALF_UP)


def _first_non_empty(rows: list[dict[str, Any]], key: str) -> str | None:
    """Get first non-empty value for key from list of dicts."""
    for row in rows:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def _empty_financial_row(
    report_month: str,
    *,
    credit_card_deduction_usd: Decimal | float | int | None = None,
    fob_cost_rmb: Decimal | float | int | None = None,
    first_leg_cost_rmb: Decimal | float | int | None = None,
) -> dict[str, Any]:
    """Return a zero-filled financial row for months without source data."""
    return {
        "report_month": report_month,
        "income_sales": 0.0,
        "income_refund": 0.0,
        "income_adjustment": 0.0,
        "income_other": 0.0,
        "expense_selling_fee": 0.0,
        "expense_fba_fee": 0.0,
        "expense_inventory_fee": 0.0,
        "expense_service_fee": 0.0,
        "expense_advertising": 0.0,
        "expense_other_fees": 0.0,
        "income_total": 0.0,
        "expense_total": 0.0,
        "amazon_pay_back": 0.0,
        "credit_card_deduction_usd": _to_float(credit_card_deduction_usd),
        "fob_cost_rmb": _to_float(fob_cost_rmb),
        "first_leg_cost_rmb": _to_float(first_leg_cost_rmb),
        "has_source_report": False,
    }


def _safe_project_name(project_name: str) -> str:
    """Remove filesystem-unsafe characters from project name."""
    sanitized = "".join(ch for ch in project_name.strip() if ch not in r'\/:*?"<>|')
    return sanitized or "unknown"


def _parse_transaction_datetime(value: Any) -> datetime:
    """Parse transaction datetime with multiple format support and timezone handling."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("transaction date is empty")

    parts = text.rsplit(" ", 1)
    tz_offset: int | None = None
    if len(parts) == 2 and parts[1] in TZ_OFFSET_BY_ABBR:
        tz_offset = TZ_OFFSET_BY_ABBR[parts[1]]
        text = parts[0]

    for fmt in (
        "%b %d, %Y %I:%M:%S %p",
        "%Y-%m-%d %H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
    ):
        try:
            parsed = datetime.strptime(text, fmt)
            if tz_offset is not None:
                tz = timezone(timedelta(hours=tz_offset))
                return parsed.replace(tzinfo=tz).astimezone(UTC)
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC)
        except ValueError:
            continue

    raise ValueError(f"invalid transaction date: {text}")


def _format_month_label(month: str) -> str:
    """Format YYYY-MM as Chinese month label (e.g., "2024年1月")."""
    try:
        y, m = month.split("-")
        return f"{y}年{int(m)}月"
    except Exception:
        return month


def _to_positive_ratio(numerator: float, denominator: float) -> float:
    """Calculate absolute value ratio."""
    base = abs(denominator)
    if base == 0:
        return 0.0
    return abs(numerator) / base


def _to_signed_ratio(numerator: float, denominator: float) -> float:
    """Calculate signed ratio."""
    if denominator == 0:
        return 0.0
    return numerator / denominator


def _group_sku_quantity(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Group rows by SKU and sum quantities."""
    grouped: dict[str, int] = defaultdict(int)
    for row in rows:
        sku = str(row.get("sku", "") or "")
        if not sku:
            continue
        grouped[sku] += int(_to_decimal(row.get("quantity") or 0))
    data = [{"sku": sku, "quantity": qty} for sku, qty in grouped.items()]
    data.sort(key=lambda item: item["quantity"], reverse=True)
    return data


# Re-export shared utilities for convenience
from app.utils.text_utils import normalize_text

__all__ = [
    "_month_to_date",
    "_month_to_str",
    "_add_months",
    "_month_range",
    "_normalize_key",
    "_to_decimal",
    "_to_float",
    "_round2",
    "_first_non_empty",
    "_empty_financial_row",
    "_safe_project_name",
    "_parse_transaction_datetime",
    "_format_month_label",
    "_to_positive_ratio",
    "_to_signed_ratio",
    "_group_sku_quantity",
    "normalize_text",
]
