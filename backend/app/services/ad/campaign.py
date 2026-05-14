"""Campaign analysis functions for ad analysis.

Extracted from ad_analysis_service.py (stage 3 refactor).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.models import AdUploadCampaignRow
from app.utils.math_utils import DECIMAL_ZERO, round_money, round_ratio, safe_ratio

from .helpers import (
    _resolve_related_campaigns,
    _filter_rows_by_campaigns,
    _build_campaign_budget_lookup,
    _build_campaign_cross_sell_lookup,
    _build_narrative_section,
    _build_issue_card,
    _serialize_decimal,
    _ensure_project_access,
    _pick_latest_row,
)
from .loaders import (
    _load_campaign_rows,
    _load_budget_rows,
    _load_product_rows,
    _load_purchased_product_rows,
)
from .metrics import (
    grade_campaign,
    classify_campaign_next_action,
    classify_cross_sell_action,
)
from app.utils.country import normalize_country


def build_campaigns(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    search_term: str | None = None,
    placement: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, Any]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_campaign_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
        search_term=search_term,
        placement=placement,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    budget_rows = _load_budget_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    budget_rows = _filter_rows_by_campaigns(budget_rows, campaign_scope)
    purchased_product_rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
    )
    purchased_product_rows = _filter_rows_by_campaigns(purchased_product_rows, campaign_scope)
    budget_lookup = _build_campaign_budget_lookup(budget_rows)
    cross_sell_lookup = _build_campaign_cross_sell_lookup(purchased_product_rows)

    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = (row.campaign_name or "").strip() or "-"
        bucket = grouped.setdefault(
            key,
            {
                "campaign_name": key,
                "status": row.status or "-",
                "targeting_type": row.targeting_type or "-",
                "bidding_strategy": row.bidding_strategy or "-",
                "latest_row": row,
                "impressions": 0,
                "clicks": 0,
                "spend": DECIMAL_ZERO,
                "sales_7d": DECIMAL_ZERO,
                "orders_7d": 0,
            },
        )
        latest_row = bucket["latest_row"]
        if isinstance(latest_row, AdUploadCampaignRow):
            if (row.report_end_date, int(row.id or 0)) >= (latest_row.report_end_date, int(latest_row.id or 0)):
                bucket["latest_row"] = row
                bucket["status"] = row.status or "-"
                bucket["targeting_type"] = row.targeting_type or "-"
                bucket["bidding_strategy"] = row.bidding_strategy or "-"
        bucket["impressions"] = int(bucket["impressions"]) + int(row.impressions or 0)
        bucket["clicks"] = int(bucket["clicks"]) + int(row.clicks or 0)
        bucket["spend"] = Decimal(bucket["spend"]) + Decimal(row.spend or 0)
        bucket["sales_7d"] = Decimal(bucket["sales_7d"]) + Decimal(row.sales_7d or 0)
        bucket["orders_7d"] = int(bucket["orders_7d"]) + int(row.orders_7d or 0)

    items = []
    for bucket in grouped.values():
        campaign_name = str(bucket["campaign_name"])
        budget_info = budget_lookup.get(
            campaign_name,
            {
                "budget_gap": 0.0,
                "budget_utilization_rate": 0.0,
                "missed_sales_max": 0.0,
            },
        )
        cross_sell_info = cross_sell_lookup.get(
            campaign_name,
            {
                "cross_sell_orders_7d": 0,
                "cross_sell_sales_7d": 0.0,
                "cross_sell_action": "\u6682\u65e0\u5173\u8054\u8f6c\u5316",
            },
        )
        spend = Decimal(bucket["spend"])
        sales = Decimal(bucket["sales_7d"])
        clicks = int(bucket["clicks"])
        impressions = int(bucket["impressions"])
        orders = int(bucket["orders_7d"])
        ctr = safe_ratio(Decimal(clicks), impressions)
        cpc = safe_ratio(spend, clicks)
        acos = safe_ratio(spend, sales)
        roas = safe_ratio(sales, spend)
        grade = grade_campaign(orders=orders, acos=acos, clicks=clicks, spend=spend)
        budget_gap = Decimal(str(budget_info["budget_gap"]))
        cross_sell_sales = Decimal(str(cross_sell_info["cross_sell_sales_7d"]))
        latest_row = bucket["latest_row"]
        latest_budget = Decimal(latest_row.budget or 0) if isinstance(latest_row, AdUploadCampaignRow) else DECIMAL_ZERO
        items.append(
            {
                "campaign_name": campaign_name,
                "status": bucket["status"],
                "targeting_type": bucket["targeting_type"],
                "bidding_strategy": bucket["bidding_strategy"],
                "budget": _serialize_decimal(latest_budget),
                "impressions": impressions,
                "clicks": clicks,
                "ctr": round_ratio(ctr),
                "cpc": _serialize_decimal(cpc),
                "spend": _serialize_decimal(spend),
                "sales_7d": _serialize_decimal(sales),
                "orders_7d": orders,
                "acos": round_ratio(acos),
                "roas": round_ratio(roas),
                "grade": grade,
                "budget_gap": float(budget_info["budget_gap"]),
                "budget_utilization_rate": float(budget_info["budget_utilization_rate"]),
                "missed_sales_max": float(budget_info["missed_sales_max"]),
                "cross_sell_orders_7d": int(cross_sell_info["cross_sell_orders_7d"]),
                "cross_sell_sales_7d": float(cross_sell_info["cross_sell_sales_7d"]),
                "cross_sell_action": str(cross_sell_info["cross_sell_action"]),
                "next_action": classify_campaign_next_action(
                    grade=grade,
                    budget_gap=budget_gap,
                    cross_sell_sales=cross_sell_sales,
                    orders=orders,
                    spend=spend,
                ),
            }
        )

    items.sort(key=lambda item: (float(item["spend"]), float(item["sales_7d"])), reverse=True)
    high_grade_count = sum(1 for item in items if str(item["grade"]) in {"A", "B"})
    budget_candidate_count = sum(
        1
        for item in items
        if float(item["budget_gap"]) > 0 and (int(item["orders_7d"]) > 0 or float(item["cross_sell_sales_7d"]) > 0)
    )
    cross_sell_winner_count = sum(1 for item in items if str(item["cross_sell_action"]) == "\u653e\u5927\u5173\u8054")
    top_campaign = items[0] if items else None
    low_efficiency_campaigns = [
        item for item in items
        if (str(item["grade"]) in {"C", "D"}) or (float(item["spend"]) >= 10 and int(item["orders_7d"]) == 0)
    ]
    budget_gap_campaigns = [item for item in items if float(item["budget_gap"]) > 0 and int(item["orders_7d"]) > 0]
    cross_sell_campaigns = [item for item in items if str(item["cross_sell_action"]) == "\u653e\u5927\u5173\u8054"]
    campaign_narrative_sections = [
        _build_narrative_section(
            title="\u6d3b\u52a8\u5c42\u7ed3\u8bba",
            summary=(
                "\u5f53\u524d\u6d3b\u52a8\u5c42\u4ee5\u7a33\u5b9a\u653e\u91cf\u4e3a\u4e3b\u3002"
                if high_grade_count > 0 and len(low_efficiency_campaigns) == 0
                else "\u5f53\u524d\u6d3b\u52a8\u5c42\u5b58\u5728\u660e\u663e\u5206\u5316\uff0c\u90e8\u5206\u6d3b\u52a8\u53ef\u4ee5\u653e\u91cf\uff0c\u90e8\u5206\u6d3b\u52a8\u9700\u8981\u4f18\u5148\u63a7\u635f\u3002"
            ),
            evidence=[
                f"\u5f53\u524d\u5171\u6709 {len(items)} \u4e2a\u6d3b\u52a8\uff0c\u5176\u4e2d A/B \u7ea7\u6d3b\u52a8 {high_grade_count} \u4e2a\u3002",
                *(
                    [f"\u5f53\u524d\u9ad8\u6d88\u8017\u6d3b\u52a8\u662f {top_campaign['campaign_name']}\uff0c\u82b1\u8d39 {float(top_campaign['spend']):.2f} \u7f8e\u5143\uff0cACOS {float(top_campaign['acos']) * 100:.2f}%."]
                    if top_campaign is not None
                    else []
                ),
                *(
                    [f"\u5f53\u524d\u6709 {len(low_efficiency_campaigns)} \u4e2a\u6d3b\u52a8\u5df2\u8fdb\u5165\u4f4e\u6548\u6216\u9ad8\u82b1\u8d39\u65e0\u5355\u533a\u95f4\u3002"]
                    if low_efficiency_campaigns
                    else []
                ),
            ],
            action="\u5148\u4fdd\u4f4f A/B \u7ea7\u6d3b\u52a8\u7684\u91cf\uff0c\u518d\u628a C/D \u7ea7\u6d3b\u52a8\u62c9\u56de\u6d3b\u52a8\u3001\u641c\u7d22\u8bcd\u3001\u5e7f\u544a\u4f4d\u9010\u5c42\u63a7\u6d6a\u8d39\u3002",
            drill_to="campaigns",
        ),
        _build_narrative_section(
            title="\u9884\u7b97\u5f52\u56e0",
            summary=(
                "\u6d3b\u52a8\u5c42\u5f53\u524d\u5b58\u5728\u9884\u7b97\u627f\u63a5\u95f4\u9699\uff0c\u90e8\u5206\u6709\u6548\u6d3b\u52a8\u6ca1\u6709\u5b8c\u6574\u5728\u7ebf\u3002"
                if budget_gap_campaigns
                else "\u6d3b\u52a8\u5c42\u5f53\u524d\u6ca1\u6709\u660e\u663e\u9884\u7b97\u627f\u63a5\u95f4\u9699\uff0c\u9884\u7b97\u4e0d\u662f\u9996\u8981\u77db\u76fe\u3002"
            ),
            evidence=(
                [f"\u5f53\u524d\u6709 {len(budget_gap_campaigns)} \u4e2a\u6709\u8ba2\u5355\u6d3b\u52a8\u4ecd\u5b58\u5728\u9884\u7b97\u7f3a\u53e3\u3002"]
                if budget_gap_campaigns
                else ["\u5f53\u524d\u9ad8\u8d28\u91cf\u6d3b\u52a8\u6ca1\u6709\u51fa\u73b0\u660e\u663e\u9884\u7b97\u4e0d\u8db3\u4fe1\u53f7\u3002"]
            ),
            action="\u9884\u7b97\u53ea\u4f18\u5148\u7ed9\u6709\u5355\u4e14 ACOS \u53ef\u63a7\u7684\u6d3b\u52a8\uff0c\u5176\u4ed6\u6d3b\u52a8\u5148\u4f18\u5316\u8bcd\u8def\u548c\u5165\u53e3\u3002",
            drill_to="budget",
        ),
        _build_narrative_section(
            title="\u5173\u8054\u653e\u91cf\u5224\u65ad",
            summary=(
                "\u90e8\u5206\u6d3b\u52a8\u4e0d\u4ec5\u81ea\u8eab\u51fa\u5355\uff0c\u8fd8\u5728\u5e26\u52a8\u5176\u4ed6\u5546\u54c1\u6210\u4ea4\u3002"
                if cross_sell_campaigns
                else "\u5f53\u524d\u6d3b\u52a8\u5c42\u7684\u5173\u8054\u6210\u4ea4\u653e\u5927\u8fd8\u4e0d\u660e\u663e\uff0c\u4e3b\u8981\u5148\u770b\u4e3b\u5546\u54c1\u81ea\u8eab\u6548\u7387\u3002"
            ),
            evidence=(
                [f"\u5f53\u524d\u6709 {len(cross_sell_campaigns)} \u4e2a\u6d3b\u52a8\u51fa\u73b0\u660e\u663e\u5173\u8054\u5e26\u5355\u3002"]
                if cross_sell_campaigns
                else ["\u5df2\u8d2d\u5546\u54c1\u5c42\u6682\u65f6\u6ca1\u6709\u770b\u5230\u660e\u663e\u7684\u6d3b\u52a8\u7ea7\u5173\u8054\u6210\u4ea4\u6269\u6563\u3002"]
            ),
            action="\u5bf9\u80fd\u5e26\u52a8\u5173\u8054\u6210\u4ea4\u7684\u6d3b\u52a8\u4f18\u5148\u4fdd\u9884\u7b97\uff0c\u5e76\u628a\u5bf9\u5e94 SKU \u5217\u5165\u627f\u63a5\u4f18\u5316\u540d\u5355\u3002",
            drill_to="products",
        ),
    ]
    return {
        "project_id": project_id,
        "country": normalized_country,
        "summary_cards": [
            {
                "label": "\u6d3b\u52a8\u6570",
                "value": str(len(items)),
                "helper": "\u5f53\u524d\u7b5b\u9009\u6761\u4ef6\u4e0b\u7684\u6d3b\u52a8\u6570\u91cf",
            },
            {
                "label": "A/B \u6d3b\u52a8",
                "value": str(high_grade_count),
                "helper": "\u8fbe\u5230\u7a33\u5b9a\u653e\u91cf\u6216\u6301\u7eed\u89c2\u5bdf\u6807\u51c6\u7684\u6d3b\u52a8",
            },
            {
                "label": "\u9884\u7b97\u5019\u9009",
                "value": str(budget_candidate_count),
                "helper": "\u6709\u9884\u7b97\u7f3a\u53e3\u4e14\u4ecd\u6709\u4ea7\u51fa\u7a7a\u95f4\u7684\u6d3b\u52a8",
            },
            {
                "label": "\u5173\u8054\u653e\u91cf",
                "value": str(cross_sell_winner_count),
                "helper": "\u5e26\u52a8\u5176\u4ed6\u5546\u54c1\u6210\u4ea4\u7684\u6d3b\u52a8",
            },
        ],
        "narrative_sections": campaign_narrative_sections,
        "items": items,
    }