from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from app.utils.math_utils import round_money, safe_ratio


def _bucket_key(target_date: date, sku: str) -> tuple[str, str]:
    return target_date.isoformat(), sku


@dataclass
class _MetricBucket:
    asin: str | None = None
    order_qty: int = 0
    sales_amount: Decimal = field(default_factory=lambda: Decimal("0"))
    impressions: int = 0
    clicks: int = 0
    ad_spend: Decimal = field(default_factory=lambda: Decimal("0"))
    ad_orders: int = 0
    available_qty: int = 0
    page_views: int = 0
    units_ordered: int = 0
    sessions: int = 0
    business_sales_amount: Decimal = field(default_factory=lambda: Decimal("0"))


def _get_or_create_bucket(
    buckets: dict[tuple[str, str], _MetricBucket], target_date: date, sku: str
) -> _MetricBucket:
    return buckets.setdefault(_bucket_key(target_date, sku), _MetricBucket())


def _set_asin_if_blank(bucket: _MetricBucket, asin: str | None) -> None:
    normalized = (asin or "").strip() or None
    if bucket.asin is None and normalized is not None:
        bucket.asin = normalized


def _aggregate_buckets(
    detail_buckets: dict[tuple[str, str], _MetricBucket],
    sku_filter: str | None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    detail_rows: list[dict[str, object]] = []
    summary_map: dict[str, dict[str, object]] = {}
    for (day_text, bucket_sku), bucket in sorted(
        detail_buckets.items(), key=lambda item: (item[0][0], item[0][1])
    ):
        if sku_filter is not None and bucket_sku != sku_filter:
            continue

        page_views = int(bucket.page_views)
        units_ordered = int(bucket.units_ordered)
        detail_row = {
            "date": day_text,
            "sku": bucket_sku,
            "asin": bucket.asin,
            "order_qty": int(bucket.order_qty),
            "sales_amount": round_money(bucket.sales_amount),
            "impressions": int(bucket.impressions),
            "clicks": int(bucket.clicks),
            "cpc": round_money(safe_ratio(bucket.ad_spend, bucket.clicks)),
            "ad_spend": round_money(bucket.ad_spend),
            "ad_orders": int(bucket.ad_orders),
            "available_qty": int(bucket.available_qty),
            "page_views": page_views,
            "units_ordered": units_ordered,
            "sessions": int(bucket.sessions),
            "ordered_sales_amount": round_money(bucket.business_sales_amount),
            "conversion_rate": round_money(safe_ratio(Decimal(units_ordered), page_views)) if page_views > 0 else 0.0,
        }
        detail_rows.append(detail_row)

        summary = summary_map.setdefault(
            day_text,
            {
                "date": day_text,
                "order_qty": 0,
                "sales_amount": Decimal("0"),
                "impressions": 0,
                "clicks": 0,
                "ad_spend": Decimal("0"),
                "ad_orders": 0,
                "available_qty": 0,
                "page_views": 0,
                "units_ordered": 0,
                "sessions": 0,
                "ordered_sales_amount": Decimal("0"),
            },
        )
        summary["order_qty"] = int(summary["order_qty"]) + int(bucket.order_qty)
        summary["sales_amount"] = Decimal(summary["sales_amount"]) + bucket.sales_amount
        summary["impressions"] = int(summary["impressions"]) + int(bucket.impressions)
        summary["clicks"] = int(summary["clicks"]) + int(bucket.clicks)
        summary["ad_spend"] = Decimal(summary["ad_spend"]) + bucket.ad_spend
        summary["ad_orders"] = int(summary["ad_orders"]) + int(bucket.ad_orders)
        summary["available_qty"] = int(summary["available_qty"]) + int(bucket.available_qty)
        summary["page_views"] = int(summary["page_views"]) + int(bucket.page_views)
        summary["units_ordered"] = int(summary["units_ordered"]) + int(bucket.units_ordered)
        summary["sessions"] = int(summary["sessions"]) + int(bucket.sessions)
        summary["ordered_sales_amount"] = Decimal(summary["ordered_sales_amount"]) + bucket.business_sales_amount

    summary_rows = [
        {
            "date": item["date"],
            "order_qty": int(item["order_qty"]),
            "sales_amount": round_money(Decimal(item["sales_amount"])),
            "impressions": int(item["impressions"]),
            "clicks": int(item["clicks"]),
            "cpc": round_money(safe_ratio(Decimal(item["ad_spend"]), int(item["clicks"]))),
            "ad_spend": round_money(Decimal(item["ad_spend"])),
            "ad_orders": int(item["ad_orders"]),
            "available_qty": int(item["available_qty"]),
            "page_views": int(item["page_views"]),
            "units_ordered": int(item["units_ordered"]),
            "sessions": int(item["sessions"]),
            "ordered_sales_amount": round_money(Decimal(item["ordered_sales_amount"])),
            "conversion_rate": round_money(safe_ratio(Decimal(item["units_ordered"]), int(item["page_views"]))) if int(item["page_views"]) > 0 else 0.0,
        }
        for item in sorted(summary_map.values(), key=lambda row: str(row["date"]))
    ]
    return detail_rows, summary_rows
