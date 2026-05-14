"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.math_utils import DECIMAL_ZERO, round_ratio, safe_ratio
from app.utils.country import normalize_country
from .helpers import _build_narrative_section, _ensure_project_access, _filter_rows_by_campaigns, _matches_dimension, _normalize_dimension, _resolve_related_campaigns, _serialize_decimal
from .loaders import _load_search_term_rows, _load_search_term_share_rows
from .metrics import classify_search_term_action
def build_search_terms(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    search_term: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_search_term_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    share_rows = _load_search_term_share_rows(
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
        search_term=search_term,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    share_rows = _filter_rows_by_campaigns(share_rows, campaign_scope)
    normalized_search_term = _normalize_dimension(search_term)

    share_by_term: dict[tuple[str, str, str], dict[str, Decimal | int]] = {}
    for row in share_rows:
        search_term_key = _normalize_dimension(row.search_term)
        if search_term_key is None:
            continue
        match_type_key = _normalize_dimension(row.match_type) or '-'
        campaign_key = _normalize_dimension(row.campaign_name) or '-'
        key = (search_term_key, match_type_key, campaign_key)
        current = share_by_term.setdefault(
            key,
            {
                'impression_share': DECIMAL_ZERO,
                'impression_rank': 0,
            },
        )
        share_value = Decimal(row.impression_share or 0)
        rank_value = int(row.impression_rank or 0)
        if share_value > Decimal(current['impression_share']):
            current['impression_share'] = share_value
        if rank_value > 0 and (int(current['impression_rank']) == 0 or rank_value < int(current['impression_rank'])):
            current['impression_rank'] = rank_value

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.search_term, normalized_search_term):
            continue
        search_term = (row.search_term or '').strip() or '-'
        match_type = (row.match_type or '').strip() or '-'
        key = (search_term, match_type)
        bucket = grouped.setdefault(
            key,
            {
                'search_term': search_term,
                'match_type': match_type,
                'campaigns': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
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

    items = []
    for bucket in grouped.values():
        search_term = str(bucket['search_term'])
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = safe_ratio(Decimal(clicks), impressions)
        cpc = safe_ratio(spend, clicks)
        acos = safe_ratio(spend, sales)
        cvr = safe_ratio(Decimal(orders), clicks)
        campaigns = bucket['campaigns']
        campaign_keys = sorted(_normalize_dimension(name) or '-' for name in campaigns) if isinstance(campaigns, set) else []
        share_key = None
        if len(campaign_keys) == 1:
            share_key = (
                _normalize_dimension(search_term) or '-',
                _normalize_dimension(str(bucket['match_type'])) or '-',
                campaign_keys[0],
            )
        share_info = share_by_term.get(share_key, {}) if share_key is not None else {}
        impression_share = Decimal(share_info.get('impression_share', DECIMAL_ZERO))
        impression_rank = int(share_info.get('impression_rank', 0))
        action = classify_search_term_action(
            orders=orders,
            impression_share=impression_share,
            acos=acos,
            clicks=clicks,
        )
        items.append(
            {
                'search_term': search_term,
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
                'impression_share': round_ratio(impression_share),
                'impression_rank': impression_rank,
                'action': action,
            }
        )

    items.sort(key=lambda item: (float(item['spend']), int(item['clicks'])), reverse=True)
    expand_count = sum(1 for item in items if str(item['action']) in {'提竞价争份额', '加词放量'})
    negative_count = sum(1 for item in items if str(item['action']) == '否词/降价')
    share_gap_count = sum(
        1
        for item in items
        if int(item['orders_7d']) >= 1 and float(item['impression_share']) > 0 and float(item['impression_share']) < 0.08
    )
    top_term = items[0] if items else None
    waste_term_count = sum(1 for item in items if str(item['action']) == '否词/降价')
    low_ctr_terms = sum(1 for item in items if int(item['impressions']) >= 100 and float(item['ctr']) < 0.005)
    search_term_narrative_sections = [
        _build_narrative_section(
            title='搜索词层结论',
            summary=(
                '当前搜索词层兼有扩量词和浪费词，需要同时做放量与控损。'
                if expand_count > 0 and waste_term_count > 0
                else '当前搜索词层以扩量机会为主。'
                if expand_count > 0
                else '当前搜索词层以控浪费为主。'
                if waste_term_count > 0
                else '当前搜索词层暂时较平稳。'
            ),
            evidence=[
                f'当前共识别到 {len(items)} 个搜索词，其中扩量候选 {expand_count} 个，否词候选 {waste_term_count} 个。',
                *(
                    [f"当前高消耗词是 {top_term['search_term']}，花费 {float(top_term['spend']):.2f} 美元，ACOS {float(top_term['acos']) * 100:.2f}%."]
                    if top_term is not None
                    else []
                ),
            ],
            action='先区分该词是值得继续抢份额，还是已经到达否词/降价门槛。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='份额归因',
            summary=(
                '搜索词层存在明确份额缺口，部分有订单词还没有拿到足够曝光。'
                if share_gap_count > 0
                else '搜索词层暂时没有明显份额缺口，当前更应先看词效而不是盲目提价。'
            ),
            evidence=(
                [f'当前有 {share_gap_count} 个已有订单词的展示量份额仍低于 8%。']
                if share_gap_count > 0
                else ['当前有订单词的份额没有集中落在明显偏低区间。']
            ),
            action='对已验证能转化的词，优先做提竞价、拉精确或拆单独活动承接。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='点击与转化判断',
            summary=(
                '部分词虽然能拿到曝光，但点击承接偏弱。'
                if low_ctr_terms > 0
                else '当前搜索词问题更多集中在转化而不是点击。'
            ),
            evidence=(
                [f'当前有 {low_ctr_terms} 个词曝光达到观察门槛但 CTR 仍低于 0.50%。']
                if low_ctr_terms > 0
                else ['主要问题词更多表现为点击后未转化，而不是展示后无人点击。']
            ),
            action='点击差先看词意图和广告位，转化差再回到商品承接层检查页面竞争力。',
            drill_to='products',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '搜索词数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的有效搜索词',
            },
            {
                'label': '扩量候选',
                'value': str(expand_count),
                'helper': '建议提竞价或加词放量的搜索词',
            },
            {
                'label': '否词候选',
                'value': str(negative_count),
                'helper': '达到降价或否词门槛的搜索词',
            },
            {
                'label': '份额缺口',
                'value': str(share_gap_count),
                'helper': '已有订单但展示量份额仍偏低的搜索词',
            },
        ],
        'narrative_sections': search_term_narrative_sections,
        'items': items,
    }


