"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.math_utils import DECIMAL_ZERO, round_ratio, safe_ratio
from app.utils.country import normalize_country
from .helpers import _build_narrative_section, _build_purchased_product_lookup, _ensure_project_access, _filter_rows_by_campaigns, _matches_dimension, _normalize_dimension, _resolve_related_campaigns, _serialize_decimal
from .loaders import _load_budget_rows, _load_product_rows, _load_purchased_product_rows
from .metrics import classify_budget_action, classify_budget_next_step, classify_product_next_action, grade_product
def build_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    purchased_product_rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    purchased_lookup = _build_purchased_product_lookup(purchased_product_rows)
    normalized_sku = _normalize_dimension(sku)

    grouped: dict[tuple[str, str], dict[str, object]] = {}
    for row in rows:
        if not _matches_dimension(row.ad_sku, normalized_sku):
            continue
        key = ((row.ad_sku or '').strip() or '-', (row.ad_asin or '').strip() or '-')
        bucket = grouped.setdefault(
            key,
            {
                'ad_sku': key[0],
                'ad_asin': key[1],
                'campaign_count': set(),
                'impressions': 0,
                'clicks': 0,
                'spend': DECIMAL_ZERO,
                'sales_7d': DECIMAL_ZERO,
                'orders_7d': 0,
                'units_7d': 0,
            },
        )
        cast_set = bucket['campaign_count']
        if isinstance(cast_set, set):
            cast_set.add((row.campaign_name or '').strip() or '-')
        bucket['impressions'] = int(bucket['impressions']) + int(row.impressions or 0)
        bucket['clicks'] = int(bucket['clicks']) + int(row.clicks or 0)
        bucket['spend'] = Decimal(bucket['spend']) + Decimal(row.spend or 0)
        bucket['sales_7d'] = Decimal(bucket['sales_7d']) + Decimal(row.sales_7d or 0)
        bucket['orders_7d'] = int(bucket['orders_7d']) + int(row.orders_7d or 0)
        bucket['units_7d'] = int(bucket['units_7d']) + int(row.units_7d or 0)

    items = []
    for bucket in grouped.values():
        lookup_key = (str(bucket['ad_sku']), str(bucket['ad_asin']))
        cross_sell = purchased_lookup.get(
            lookup_key,
            {
                'cross_sell_asin_count': 0,
                'cross_sell_orders_7d': 0,
                'cross_sell_sales_7d': 0.0,
                'top_purchased_asin': '-',
                'cross_sell_action': '暂无关联转化',
            },
        )
        impressions = int(bucket['impressions'])
        clicks = int(bucket['clicks'])
        spend = Decimal(bucket['spend'])
        sales = Decimal(bucket['sales_7d'])
        orders = int(bucket['orders_7d'])
        ctr = safe_ratio(Decimal(clicks), impressions)
        cpc = safe_ratio(spend, clicks)
        acos = safe_ratio(spend, sales)
        cvr = safe_ratio(Decimal(orders), clicks)
        grade = grade_product(orders=orders, acos=acos, ctr=ctr, clicks=clicks)
        campaign_count = bucket['campaign_count']
        items.append(
            {
                'ad_sku': bucket['ad_sku'],
                'ad_asin': bucket['ad_asin'],
                'campaign_count': len(campaign_count) if isinstance(campaign_count, set) else 0,
                'primary_campaign': sorted(campaign_count)[0] if isinstance(campaign_count, set) and campaign_count else '-',
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
                'grade': grade,
                'cross_sell_asin_count': int(cross_sell['cross_sell_asin_count']),
                'cross_sell_orders_7d': int(cross_sell['cross_sell_orders_7d']),
                'cross_sell_sales_7d': float(cross_sell['cross_sell_sales_7d']),
                'top_purchased_asin': str(cross_sell['top_purchased_asin']),
                'cross_sell_action': str(cross_sell['cross_sell_action']),
                'next_action': classify_product_next_action(
                    grade=grade,
                    ctr=ctr,
                    clicks=clicks,
                    orders=orders,
                    cross_sell_action=str(cross_sell['cross_sell_action']),
                ),
            }
        )

    items.sort(key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)
    high_grade_count = sum(1 for item in items if str(item['grade']) in {'主推', '潜力'})
    cross_sell_winner_count = sum(1 for item in items if str(item['cross_sell_action']) == '放大关联')
    total_cross_sell_sales = sum((Decimal(str(item['cross_sell_sales_7d'])) for item in items), DECIMAL_ZERO)
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': 'SKU 数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的广告 SKU',
            },
            {
                'label': '主推/潜力',
                'value': str(high_grade_count),
                'helper': '值得继续放量的 SKU 数量',
            },
            {
                'label': '关联销售额',
                'value': f'${_serialize_decimal(total_cross_sell_sales):,.2f}',
                'helper': '来自已购买商品报表的其他 SKU 销售额',
            },
            {
                'label': '关联放大量',
                'value': str(cross_sell_winner_count),
                'helper': '存在明显交叉销售贡献的 SKU',
            },
        ],
        'items': items,
    }


def build_budget(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_budget_rows(
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

    items = []
    for row in rows:
        budget = Decimal(row.budget or 0)
        suggested_budget = Decimal(row.suggested_budget or 0)
        utilization = Decimal(row.budget_utilization_rate or 0)
        spend = Decimal(row.spend or 0)
        sales = Decimal(row.sales_7d or 0)
        orders = int(row.orders_7d or 0)
        acos = Decimal(row.acos or 0)
        budget_gap = suggested_budget - budget

        action = classify_budget_action(utilization=utilization, orders=orders, acos=acos, spend=spend)

        items.append(
            {
                'campaign_name': (row.campaign_name or '').strip() or '-',
                'status': row.status or '-',
                'budget': _serialize_decimal(budget),
                'suggested_budget': _serialize_decimal(suggested_budget),
                'budget_gap': _serialize_decimal(budget_gap if budget_gap > DECIMAL_ZERO else DECIMAL_ZERO),
                'budget_utilization_rate': round_ratio(utilization),
                'missed_impressions_min': int(row.missed_impressions_min or 0),
                'missed_impressions_max': int(row.missed_impressions_max or 0),
                'missed_clicks_min': int(row.missed_clicks_min or 0),
                'missed_clicks_max': int(row.missed_clicks_max or 0),
                'missed_sales_min': _serialize_decimal(Decimal(row.missed_sales_min or 0)),
                'missed_sales_max': _serialize_decimal(Decimal(row.missed_sales_max or 0)),
                'spend': _serialize_decimal(spend),
                'sales_7d': _serialize_decimal(sales),
                'orders_7d': orders,
                'acos': round_ratio(acos),
                'action': action,
                'next_step': classify_budget_next_step(action),
            }
        )

    items.sort(
        key=lambda item: (
            float(item['budget_gap']),
            float(item['missed_sales_max']),
            1 if str(item['action']) == '优先加预算' else 0,
        ),
        reverse=True,
    )
    add_budget_count = sum(1 for item in items if str(item['action']) == '优先加预算')
    optimize_first_count = sum(1 for item in items if str(item['action']) == '先优化再加预算')
    observe_count = sum(1 for item in items if str(item['action']) == '观察预算')
    top_budget_item = items[0] if items else None
    budget_pressure_items = [item for item in items if float(item['budget_gap']) > 0 and int(item['orders_7d']) > 0]
    optimize_before_scale_items = [item for item in items if str(item['action']) == '先优化再加预算']
    budget_narrative_sections = [
        _build_narrative_section(
            title='预算层结论',
            summary=(
                '当前预算页已经出现明确承接缺口，部分有效活动没能完整在线。'
                if budget_pressure_items
                else '当前预算层整体平稳，预算不是当前最明显的限制项。'
            ),
            evidence=[
                f'当前共有 {len(items)} 条预算记录，其中优先加预算 {add_budget_count} 条。',
                *(
                    [f"当前预算缺口最大的活动是 {top_budget_item['campaign_name']}，预算差额 {float(top_budget_item['budget_gap']):.2f} 美元。"]
                    if top_budget_item is not None
                    else []
                ),
            ],
            action='先把有限预算给到有效活动，再回头处理低效活动，避免平均分配预算。',
            drill_to='budget',
        ),
        _build_narrative_section(
            title='是否直接加预算',
            summary=(
                '并不是所有预算缺口都应直接补，当前有一部分活动需要先优化再决定。'
                if optimize_before_scale_items
                else '当前预算候选活动大多可以直接进入补预算判断。'
            ),
            evidence=(
                [f'当前有 {len(optimize_before_scale_items)} 条预算记录属于“先优化再加预算”。']
                if optimize_before_scale_items
                else ['当前没有明显需要先优化词路和入口再决定预算的活动。']
            ),
            action='对“先优化再加预算”的活动，优先回看搜索词、投放入口和广告位质量。',
            drill_to='search-terms',
        ),
        _build_narrative_section(
            title='预算动作建议',
            summary='预算动作必须和活动质量联动，预算页本身不单独决定是否放量。',
            evidence=[
                '有单且 ACOS 可控的活动，预算缺口才有意义。',
                '高花费无单或 ACOS 失控活动，即使建议预算更高，也不应直接追加。',
            ],
            action='补预算前先确认活动等级，再把预算、词路和广告位作为一组动作一起处理。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '预算活动数',
                'value': str(len(items)),
                'helper': '当前筛选条件下的预算条目',
            },
            {
                'label': '优先加预算',
                'value': str(add_budget_count),
                'helper': '建议今天直接补预算的活动',
            },
            {
                'label': '先优化再加',
                'value': str(optimize_first_count),
                'helper': '需要先控浪费再决定预算的活动',
            },
            {
                'label': '继续观察',
                'value': str(observe_count),
                'helper': '当前只需要跟踪的预算条目',
            },
        ],
        'narrative_sections': budget_narrative_sections,
        'items': items,
    }


