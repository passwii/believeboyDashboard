"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.math_utils import DECIMAL_ZERO, round_ratio, safe_ratio
from app.utils.country import normalize_country
from .helpers import _ensure_project_access, _filter_rows_by_campaigns, _matches_dimension, _normalize_dimension, _resolve_related_campaigns, _serialize_decimal
from .loaders import _load_target_rows
from .metrics import classify_target_action
def build_targets(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    target_text: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_target_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    campaign_scope = _resolve_related_campaigns(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
        sku=sku,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    normalized_target_text = _normalize_dimension(target_text)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.target_text, normalized_target_text):
            continue
        target_text = (row.target_text or '').strip() or '-'
        match_type = (row.match_type or '').strip() or '-'
        key = (target_text, match_type)
        bucket = grouped.setdefault(
            key,
            {
                'target_text': target_text,
                'match_type': match_type,
                'campaigns': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'top_of_search_impression_share': DECIMAL_ZERO,
            },
        )
        campaigns = bucket['campaigns']
        if isinstance(campaigns, set):
            campaigns.add((row.campaign_name or '').strip() or '-')
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['top_of_search_impression_share'] = max(
            Decimal(bucket['top_of_search_impression_share']),
            Decimal(row.top_of_search_impression_share or 0),
        )

    items = []
    for bucket in grouped.values():
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = safe_ratio(Decimal(clicks), impressions)
        cpc = safe_ratio(spend, clicks)
        acos = safe_ratio(spend, sales)
        cvr = safe_ratio(Decimal(orders), clicks)
        top_share = Decimal(bucket['top_of_search_impression_share'])

        action = classify_target_action(
            orders=orders,
            acos=acos,
            clicks=clicks,
            ctr=ctr,
            top_share=top_share,
        )

        campaigns = bucket['campaigns']
        items.append(
            {
                'target_text': str(bucket['target_text']),
                'match_type': str(bucket['match_type']),
                'campaign_count': len(campaigns) if isinstance(campaigns, set) else 0,
                'primary_campaign': sorted(campaigns)[0] if isinstance(campaigns, set) and campaigns else '-',
                'impressions': impressions,
                'clicks': clicks,
                'ctr': round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'cvr_7d': round_ratio(cvr),
                'acos': round_ratio(acos),
                'top_of_search_impression_share': round_ratio(top_share),
                'action': action,
            }
        )

    items.sort(key=lambda item: (float(item['spend']), int(item['clicks'])), reverse=True)
    keep_scale_count = sum(1 for item in items if str(item['action']) == '保留放量')
    isolate_count = sum(1 for item in items if str(item['action']) == '降价/隔离')
    top_slot_gap_count = sum(
        1
        for item in items
        if float(item['ctr']) >= 0.01 and float(item['top_of_search_impression_share']) < 0.01
    )
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '投放入口数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的入口维度数量',
            },
            {
                'label': '保留放量',
                'value': str(keep_scale_count),
                'helper': '表现稳定、值得继续承接的入口',
            },
            {
                'label': '隔离候选',
                'value': str(isolate_count),
                'helper': '高消耗低转化、需要控价的入口',
            },
            {
                'label': '首页缺口',
                'value': str(top_slot_gap_count),
                'helper': 'CTR 不差但首页曝光份额偏低的入口',
            },
        ],
        'items': items,
    }


