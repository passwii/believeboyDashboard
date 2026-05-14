"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.math_utils import DECIMAL_ZERO, round_ratio, safe_ratio
from app.utils.country import normalize_country
from .helpers import _build_narrative_section, _ensure_project_access, _filter_rows_by_campaigns, _matches_dimension, _normalize_dimension, _resolve_related_campaigns, _serialize_decimal
from .loaders import _load_placement_rows
from .metrics import classify_placement_action, classify_placement_next_step
def build_placements(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    placement: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_placement_rows(
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
        placement=placement,
    )
    rows = _filter_rows_by_campaigns(rows, campaign_scope)
    normalized_placement = _normalize_dimension(placement)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.placement, normalized_placement):
            continue
        campaign_name = (row.campaign_name or '').strip() or '-'
        placement_name = (row.placement or '').strip() or '-'
        key = (campaign_name, placement_name)
        bucket = grouped.setdefault(
            key,
            {
                'campaign_name': campaign_name,
                'placement': placement_name,
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'units_7d': 0,
            },
        )
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['units_7d'] = int(bucket['units_7d']) + int(row.units_7d or 0)

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
        roas = safe_ratio(sales, spend)
        cvr = safe_ratio(Decimal(orders), clicks)

        action = classify_placement_action(
            orders=orders,
            cvr=cvr,
            acos=acos,
            clicks=clicks,
            ctr=ctr,
        )

        items.append(
            {
                'campaign_name': bucket['campaign_name'],
                'placement': bucket['placement'],
                'impressions': impressions,
                'clicks': clicks,
                'ctr': round_ratio(ctr),
                'cpc': _serialize_decimal(cpc),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'units_7d': int(bucket['units_7d']),
                'cvr_7d': round_ratio(cvr),
                'acos': round_ratio(acos),
                'roas': round_ratio(roas),
                'action': action,
                'next_step': classify_placement_next_step(action),
            }
        )

    items.sort(key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)
    raise_count = sum(1 for item in items if str(item['action']) == '可提高系数')
    down_count = sum(1 for item in items if str(item['action']) == '谨慎降价')
    weak_count = sum(1 for item in items if str(item['action']) == '流量偏弱')
    top_placement_item = items[0] if items else None
    scale_placement_items = [item for item in items if str(item['action']) == '可提高系数']
    down_placement_items = [item for item in items if str(item['action']) == '谨慎降价']
    placement_narrative_sections = [
        _build_narrative_section(
            title='广告位层结论',
            summary=(
                '当前广告位层已经出现明显分化，不同位置不能再用同一套出价策略处理。'
                if scale_placement_items or down_placement_items
                else '当前广告位层暂时没有明显分化，位置不是当前最强归因。'
            ),
            evidence=[
                f'当前共有 {len(items)} 条“活动 × 广告位”记录，其中可提高系数 {raise_count} 条，谨慎降价 {down_count} 条。',
                *(
                    [f"当前高消耗广告位记录是 {top_placement_item['campaign_name']} / {top_placement_item['placement']}，花费 {float(top_placement_item['spend']):.2f} 美元。"]
                    if top_placement_item is not None
                    else []
                ),
            ],
            action='不要把首页、其余搜索位、商品页混成同一类策略，先按活动 × 广告位分别判断。',
            drill_to='placements',
        ),
        _build_narrative_section(
            title='提系数与降系数判断',
            summary=(
                '当前既有值得提系数的位置，也有应该优先控价的位置。'
                if scale_placement_items and down_placement_items
                else '当前主要以争取更多高质量位置为主。'
                if scale_placement_items
                else '当前主要以控制低效位置消耗为主。'
                if down_placement_items
                else '当前广告位动作以持续观察为主。'
            ),
            evidence=[
                *([f'当前有 {len(scale_placement_items)} 条广告位记录进入“可提高系数”区间。'] if scale_placement_items else []),
                *([f'当前有 {len(down_placement_items)} 条广告位记录进入“谨慎降价”区间。'] if down_placement_items else []),
                *(['当前没有位置层的极端异常，更多是常规跟踪。'] if not scale_placement_items and not down_placement_items else []),
            ],
            action='对高转化位置提系数，对高点击无单位置先降价，再回到活动和词路看是否是入口跑偏。',
            drill_to='placements',
        ),
        _build_narrative_section(
            title='位置问题怎么归因',
            summary='广告位问题不能脱离活动和商品承接单独判断。',
            evidence=[
                '同一个广告位在不同活动里可能表现完全不同。',
                '首页贵不一定错，核心是贵得值不值，要同时看 CVR、ACOS 和承接商品竞争力。',
            ],
            action='如果某位置持续高点击无单，先回查对应活动、搜索词和 SKU 承接，而不是一刀切降低全部系数。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '广告位数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的广告位维度',
            },
            {
                'label': '提高系数',
                'value': str(raise_count),
                'helper': '值得争取更多曝光的位置',
            },
            {
                'label': '谨慎降价',
                'value': str(down_count),
                'helper': '高点击低转化、需要控价的位置',
            },
            {
                'label': '流量偏弱',
                'value': str(weak_count),
                'helper': '曝光有量但点击承接差的位置',
            },
        ],
        'narrative_sections': placement_narrative_sections,
        'items': items,
    }


