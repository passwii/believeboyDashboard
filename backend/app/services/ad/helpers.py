"""Shared helper functions used across the ad analysis sub-package.

Extracted from ad_analysis_service.py (stage 3 refactor).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Hashable

from app.services import project_service


def _normalize_dimension(value: str | None) -> str | None:
    """Normalize a dimension value (SKU, ASIN, search term, etc.)."""
    normalized = (value or "").strip().lower()
    return normalized or None


def _matches_dimension(value: str | None, expected: str | None) -> bool:
    if expected is None:
        return True
    return _normalize_dimension(value) == expected


def _pick_latest_row(rows: list[Any], *, date_attr: str = "report_end_date") -> Any | None:
    """Pick the row with the latest date (and highest id as tiebreaker)."""
    latest_row = None
    latest_key: tuple[date, int] | None = None
    for row in rows:
        row_date = getattr(row, date_attr, None) or date.min
        row_id = int(getattr(row, "id", 0) or 0)
        row_key = (row_date, row_id)
        if latest_key is None or row_key > latest_key:
            latest_key = row_key
            latest_row = row
    return latest_row


def _serialize_decimal(value: Decimal) -> float:
    """Convert Decimal to float for JSON serialization."""
    from app.utils.math_utils import round_money

    return round_money(value)


def _filter_rows_by_campaigns(
    rows: list[Any],
    campaign_names: set[str] | None,
) -> list[Any]:
    if campaign_names is None:
        return rows
    return [row for row in rows if ((getattr(row, "campaign_name", None) or "").strip() or "-") in campaign_names]


def _ensure_project_access(
    db, *, project_id: int, operator: str | None, is_admin: bool
) -> None:
    from app.services import project_service

    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=is_admin,
    )


def _build_issue_card(
    *,
    title: str,
    level: str,
    summary: str,
    drill_to: str,
    next_step: str,
) -> dict[str, str]:
    return {
        "title": title,
        "level": level,
        "summary": summary,
        "drill_to": drill_to,
        "next_step": next_step,
    }


def _build_narrative_section(
    *,
    title: str,
    summary: str,
    evidence: list[str],
    action: str | None = None,
    drill_to: str | None = None,
) -> dict[str, Any]:
    return {
        "title": title,
        "summary": summary,
        "evidence": evidence,
        "action": action,
        "drill_to": drill_to,
    }


def _build_time_trend_summary(
    rows: list[Any],
) -> list[dict[str, Any]]:
    from app.utils.math_utils import DECIMAL_ZERO, round_ratio

    grouped: dict[str, dict[str, Decimal | int]] = {}
    for row in rows:
        key = row.report_start_date.isoformat()
        bucket = grouped.setdefault(
            key,
            {
                "clicks": 0,
                "spend": DECIMAL_ZERO,
            },
        )
        bucket["clicks"] = int(bucket["clicks"]) + int(row.clicks or 0)
        bucket["spend"] = Decimal(bucket["spend"]) + Decimal(row.spend or 0)

    summary: list[dict[str, Any]] = []
    running_spend = DECIMAL_ZERO
    previous_spend = DECIMAL_ZERO
    for report_date in sorted(grouped):
        bucket = grouped[report_date]
        clicks = int(bucket["clicks"])
        spend = Decimal(bucket["spend"])
        running_spend += spend
        cpc = spend / clicks if clicks > 0 else DECIMAL_ZERO
        spend_change_ratio = round_ratio(
            (spend - previous_spend) / previous_spend
            if previous_spend > 0
            else DECIMAL_ZERO
        )
        summary.append(
            {
                "report_date": report_date,
                "clicks": clicks,
                "spend": _serialize_decimal(spend),
                "cpc": _serialize_decimal(cpc),
                "running_spend": _serialize_decimal(running_spend),
                "spend_change_ratio": spend_change_ratio,
            }
        )
        previous_spend = spend

    return summary


def _resolve_related_campaigns(
    db,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    search_term: str | None = None,
    placement: str | None = None,
) -> set[str] | None:
    from app.services.ad.loaders import (
        _load_product_rows,
        _load_purchased_product_rows,
        _load_search_term_rows,
        _load_placement_rows,
    )
    from app.utils.parsers import _normalize_sku as _ns

    normalized = (campaign or "").strip()
    campaign_names: set[str] | None = {normalized} if normalized else None

    normalized_sku = _normalize_dimension(sku)
    if normalized_sku is not None:
        product_rows = _load_product_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        purchased_rows = _load_purchased_product_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        sku_campaigns = {
            ((row.campaign_name or "").strip() or "-")
            for row in [*product_rows, *purchased_rows]
            if _matches_dimension(getattr(row, "ad_sku", None), normalized_sku)
        }
        campaign_names = sku_campaigns if campaign_names is None else campaign_names & sku_campaigns

    normalized_search_term = _normalize_dimension(search_term)
    if normalized_search_term is not None:
        search_rows = _load_search_term_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        term_campaigns = {
            ((row.campaign_name or "").strip() or "-")
            for row in search_rows
            if _matches_dimension(row.search_term, normalized_search_term)
        }
        campaign_names = term_campaigns if campaign_names is None else campaign_names & term_campaigns

    normalized_placement = _normalize_dimension(placement)
    if normalized_placement is not None:
        placement_rows = _load_placement_rows(
            db,
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
        placement_campaigns = {
            ((row.campaign_name or "").strip() or "-")
            for row in placement_rows
            if _matches_dimension(row.placement, normalized_placement)
        }
        campaign_names = placement_campaigns if campaign_names is None else campaign_names & placement_campaigns

    return campaign_names


def _build_campaign_budget_lookup(
    rows: list[Any],
) -> dict[str, dict[str, Any]]:
    """Build a lookup dict {campaign_name: {budget_gap, utilization_rate, ...}} from budget rows."""
    from app.utils.math_utils import DECIMAL_ZERO, round_ratio

    grouped: dict[str, list[Any]] = {}
    for row in rows:
        campaign_name = (row.campaign_name or "").strip() or "-"
        grouped.setdefault(campaign_name, []).append(row)

    lookup: dict[str, dict[str, Any]] = {}
    for key, bucket in grouped.items():
        latest_row = _pick_latest_row(bucket)
        if latest_row is None:
            continue
        budget_gap = max(
            Decimal(latest_row.suggested_budget or 0) - Decimal(latest_row.budget or 0),
            DECIMAL_ZERO,
        )
        lookup[key] = {
            "budget_gap": _serialize_decimal(budget_gap),
            "budget_utilization_rate": round_ratio(
                Decimal(latest_row.budget_utilization_rate or 0)
            ),
            "missed_sales_max": _serialize_decimal(
                Decimal(latest_row.missed_sales_max or 0)
            ),
        }
    return lookup


def _build_campaign_cross_sell_lookup(
    rows: list[Any],
) -> dict[str, dict[str, Any]]:
    """Build a lookup dict {campaign_name: {cross_sell_orders_7d, cross_sell_sales_7d, ...}}."""
    from app.utils.math_utils import DECIMAL_ZERO

    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        campaign_name = (row.campaign_name or "").strip() or "-"
        bucket = grouped.setdefault(
            campaign_name,
            {
                "cross_sell_orders_7d": 0,
                "cross_sell_sales_7d": DECIMAL_ZERO,
            },
        )
        bucket["cross_sell_orders_7d"] = (
            int(bucket["cross_sell_orders_7d"]) + int(row.other_sku_orders_7d or 0)
        )
        bucket["cross_sell_sales_7d"] = (
            Decimal(bucket["cross_sell_sales_7d"])
            + Decimal(row.other_sku_sales_7d or 0)
        )

    lookup: dict[str, dict[str, Any]] = {}
    for key, bucket in grouped.items():
        sales = Decimal(bucket["cross_sell_sales_7d"])
        orders = int(bucket["cross_sell_orders_7d"])
        from .metrics import classify_cross_sell_action

        lookup[key] = {
            "cross_sell_orders_7d": orders,
            "cross_sell_sales_7d": _serialize_decimal(sales),
            "cross_sell_action": classify_cross_sell_action(sales=sales, orders=orders),
        }
    return lookup


def _build_purchased_product_items(
    rows: list[Any],
) -> list[dict[str, Any]]:
    """Build a list of purchased product items with cross-sell classification."""
    from app.utils.math_utils import DECIMAL_ZERO

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        purchased_asin = (row.purchased_asin or "").strip() or "-"
        ad_sku = (row.ad_sku or "").strip() or "-"
        key = (purchased_asin, ad_sku)
        bucket = grouped.setdefault(
            key,
            {
                "purchased_asin": purchased_asin,
                "ad_sku": ad_sku,
                "campaigns": set(),
                "other_sku_units_7d": 0,
                "other_sku_orders_7d": 0,
                "other_sku_sales_7d": DECIMAL_ZERO,
            },
        )
        campaigns = bucket["campaigns"]
        if isinstance(campaigns, set):
            campaigns.add((row.campaign_name or "").strip() or "-")
        bucket["other_sku_units_7d"] = (
            int(bucket["other_sku_units_7d"]) + int(row.other_sku_units_7d or 0)
        )
        bucket["other_sku_orders_7d"] = (
            int(bucket["other_sku_orders_7d"]) + int(row.other_sku_orders_7d or 0)
        )
        bucket["other_sku_sales_7d"] = (
            Decimal(bucket["other_sku_sales_7d"])
            + Decimal(row.other_sku_sales_7d or 0)
        )

    items = []
    for bucket in grouped.values():
        sales = Decimal(bucket["other_sku_sales_7d"])
        orders = int(bucket["other_sku_orders_7d"])
        units = int(bucket["other_sku_units_7d"])
        campaigns = bucket["campaigns"]
        from .metrics import classify_cross_sell_action

        items.append(
            {
                "purchased_asin": str(bucket["purchased_asin"]),
                "ad_sku": str(bucket["ad_sku"]),
                "campaign_count": len(campaigns) if isinstance(campaigns, set) else 0,
                "other_sku_units_7d": units,
                "other_sku_orders_7d": orders,
                "other_sku_sales_7d": _serialize_decimal(sales),
                "action": classify_cross_sell_action(sales=sales, orders=orders),
            }
        )

    items.sort(
        key=lambda item: (float(item["other_sku_sales_7d"]), int(item["other_sku_orders_7d"])),
        reverse=True,
    )
    return items


def _build_purchased_product_lookup(
    rows: list[Any],
) -> dict[tuple[str, str], dict[str, Any]]:
    """Build a lookup dict {(ad_sku, ad_asin): {...}} for cross-sell data."""
    from app.utils.math_utils import DECIMAL_ZERO

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        ad_sku = (row.ad_sku or "").strip() or "-"
        ad_asin = (row.ad_asin or "").strip() or "-"
        key = (ad_sku, ad_asin)
        bucket = grouped.setdefault(
            key,
            {
                "cross_sell_asin_count": set(),
                "cross_sell_orders_7d": 0,
                "cross_sell_sales_7d": DECIMAL_ZERO,
                "top_purchased_asin": "-",
                "top_purchased_sales_7d": DECIMAL_ZERO,
            },
        )
        purchased_asin = (row.purchased_asin or "").strip() or "-"
        asins = bucket["cross_sell_asin_count"]
        if isinstance(asins, set):
            asins.add(purchased_asin)
        bucket["cross_sell_orders_7d"] = (
            int(bucket["cross_sell_orders_7d"]) + int(row.other_sku_orders_7d or 0)
        )
        bucket["cross_sell_sales_7d"] = (
            Decimal(bucket["cross_sell_sales_7d"])
            + Decimal(row.other_sku_sales_7d or 0)
        )
        row_sales = Decimal(row.other_sku_sales_7d or 0)
        if row_sales >= Decimal(bucket["top_purchased_sales_7d"]):
            bucket["top_purchased_sales_7d"] = row_sales
            bucket["top_purchased_asin"] = purchased_asin

    lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for key, bucket in grouped.items():
        sales = Decimal(bucket["cross_sell_sales_7d"])
        orders = int(bucket["cross_sell_orders_7d"])
        asins = bucket["cross_sell_asin_count"]
        from .metrics import classify_cross_sell_action

        lookup[key] = {
            "cross_sell_asin_count": len(asins) if isinstance(asins, set) else 0,
            "cross_sell_orders_7d": orders,
            "cross_sell_sales_7d": _serialize_decimal(sales),
            "top_purchased_asin": str(bucket["top_purchased_asin"]),
            "cross_sell_action": classify_cross_sell_action(sales=sales, orders=orders),
        }
    return lookup