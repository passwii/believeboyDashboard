"""Main analysis entry points for ad analysis.

Contains the high-level build_* functions that implement the core business logic.
Extracted from ad_analysis_service.py (stage 3 refactor).
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    AdUploadBudgetRow,
    AdUploadCampaignRow,
    AdUploadFile,
    AdUploadInvalidTrafficRow,
    AdUploadPlacementRow,
    AdUploadPurchasedProductRow,
    AdUploadSearchTermRow,
    AdUploadSearchTermShareRow,
    AdUploadTargetRow,
    AdUploadTimeTrendRow,
)
from app.services import project_service
from app.utils.date_utils import build_previous_period
from app.utils.math_utils import DECIMAL_ZERO, round_money, round_ratio, safe_ratio

from .helpers import (
    _build_campaign_budget_lookup,
    _build_campaign_cross_sell_lookup,
    _build_purchased_product_items,
    _build_purchased_product_lookup,
    _build_time_trend_summary,
    _resolve_related_campaigns,
    _serialize_decimal,
    _normalize_dimension,
    _matches_dimension,
    _filter_rows_by_campaigns,
    _ensure_project_access,
    _build_issue_card,
    _build_narrative_section,
)
from .loaders import (
    _load_campaign_rows,
    _load_budget_rows,
    _load_product_rows,
    _load_placement_rows,
    _load_search_term_rows,
    _load_search_term_share_rows,
    _load_invalid_traffic_rows,
    _load_target_rows,
    _load_time_trend_rows,
    _load_purchased_product_rows,
)
from .metrics import (
    grade_campaign,
    grade_product,
    classify_campaign_next_action,
    classify_search_term_action,
    classify_target_action,
    classify_budget_action,
    classify_budget_next_step,
    classify_placement_action,
    classify_placement_next_step,
    classify_traffic_risk,
    classify_traffic_next_action,
    classify_cross_sell_action,
    classify_product_next_action,
)
from app.utils.country import normalize_country


def build_overview(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, Any]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    previous_date_from, previous_date_to = build_previous_period(date_from=date_from, date_to=date_to)

    campaign_rows = _load_campaign_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    budget_rows = _load_budget_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    product_rows = _load_product_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    placement_rows = _load_placement_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    search_term_rows = _load_search_term_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    invalid_traffic_rows = _load_invalid_traffic_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    time_trend_rows = _load_time_trend_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    purchased_product_rows = _load_purchased_product_rows(db, project_id=project_id, country=normalized_country, date_from=date_from, date_to=date_to)
    previous_campaign_rows = (
        _load_campaign_rows(db, project_id=project_id, country=normalized_country, date_from=previous_date_from, date_to=previous_date_to)
        if previous_date_from is not None and previous_date_to is not None
        else []
    )
    trend_summary = _build_time_trend_summary(time_trend_rows)
    cross_sell_items = _build_purchased_product_items(purchased_product_rows)

    total_impressions = sum(int(row.impressions or 0) for row in campaign_rows)
    total_clicks = sum(int(row.clicks or 0) for row in campaign_rows)
    total_orders = sum(int(row.orders_7d or 0) for row in campaign_rows)
    total_spend = sum((Decimal(row.spend or 0) for row in campaign_rows), DECIMAL_ZERO)
    total_sales = sum((Decimal(row.sales_7d or 0) for row in campaign_rows), DECIMAL_ZERO)
    total_cross_sell_sales = sum((Decimal(str(item['other_sku_sales_7d'])) for item in cross_sell_items), DECIMAL_ZERO)
    total_cross_sell_orders = sum(int(item['other_sku_orders_7d']) for item in cross_sell_items)
    previous_total_clicks = sum(int(row.clicks or 0) for row in previous_campaign_rows)
    previous_total_orders = sum(int(row.orders_7d or 0) for row in previous_campaign_rows)
    previous_total_spend = sum((Decimal(row.spend or 0) for row in previous_campaign_rows), DECIMAL_ZERO)
    previous_total_sales = sum((Decimal(row.sales_7d or 0) for row in previous_campaign_rows), DECIMAL_ZERO)

    ctr = safe_ratio(Decimal(total_clicks), total_impressions)
    cpc = safe_ratio(total_spend, total_clicks)
    acos = safe_ratio(total_spend, total_sales)
    roas = safe_ratio(total_sales, total_spend)
    comparison_raw = _build_period_comparison_safe(
        current_start=date_from, current_end=date_to,
        previous_start=previous_date_from, previous_end=previous_date_to,
        current_spend=total_spend, previous_spend=previous_total_spend,
        current_clicks=total_clicks, previous_clicks=previous_total_clicks,
        current_sales=total_sales, previous_sales=previous_total_sales,
        current_orders=total_orders, previous_orders=previous_total_orders,
    )

    issue_cards: list[dict[str, str]] = []
    if total_clicks > 0 and total_orders == 0 and total_spend >= Decimal('10'):
        issue_cards.append(_build_issue_card(title='高花费无单', level='high', summary='当前汇总层出现明显点击消耗，但还没有形成订单转化。', drill_to='campaigns', next_step='先下钻活动页，收紧高花费无单活动，再联动搜索词排查浪费点。'))
    if total_impressions > 0 and ctr < Decimal('0.005'):
        issue_cards.append(_build_issue_card(title='点击率偏低', level='medium', summary='当前 CTR 偏低，建议优先检查广告位、主图和关键词精准度。', drill_to='placements', next_step='先看广告位和投放入口，再决定是调 placement 还是回到素材与词路。'))
    budget_limited_rows = [row for row in budget_rows if Decimal(row.budget_utilization_rate or 0) < Decimal('0.95') and (int(row.orders_7d or 0) > 0 or Decimal(row.sales_7d or 0) > DECIMAL_ZERO)]
    if budget_limited_rows:
        issue_cards.append(_build_issue_card(title='存在预算受限活动', level='medium', summary=f'当前识别到 {len(budget_limited_rows)} 个有单或有销售额但预算在线时间不足的活动。', drill_to='budget', next_step='进入预算页，优先处理有订单或有关联销售的预算缺口活动。'))
    waste_terms = [row for row in search_term_rows if int(row.clicks or 0) >= 3 and int(row.orders_7d or 0) == 0]
    if waste_terms:
        issue_cards.append(_build_issue_card(title='存在浪费搜索词', level='medium', summary=f'当前识别到 {len(waste_terms)} 个达到观察门槛但未出单的搜索词。', drill_to='search-terms', next_step='进入搜索词页，优先处理达到否词或降价门槛的词。'))
    high_risk_traffic_rows = [row for row in invalid_traffic_rows if Decimal(row.invalid_click_rate or 0) >= Decimal('0.2') or Decimal(row.invalid_impression_rate or 0) >= Decimal('0.35')]
    if high_risk_traffic_rows:
        issue_cards.append(_build_issue_card(title='流量质量异常', level='high', summary=f'当前识别到 {len(high_risk_traffic_rows)} 个无效流量偏高的活动，建议优先排查异常入口。', drill_to='traffic-quality', next_step='先定位异常活动，再回到投放入口和广告位检查是否有异常流量来源。'))
    weak_placement_rows = [row for row in placement_rows if int(row.clicks or 0) >= 3 and int(row.orders_7d or 0) == 0 and Decimal(row.spend or 0) >= Decimal('3')]
    if weak_placement_rows:
        issue_cards.append(_build_issue_card(title='存在低效广告位', level='medium', summary=f'当前识别到 {len(weak_placement_rows)} 条高点击未出单的广告位明细，建议结合广告位页下钻。', drill_to='placements', next_step='进入广告位页，优先下调高点击无单的位置系数。'))
    if len(trend_summary) >= 2:
        latest_day = trend_summary[-1]
        previous_day = trend_summary[-2]
        latest_spend = Decimal(str(latest_day['spend']))
        previous_spend_dec = Decimal(str(previous_day['spend']))
        if latest_spend >= Decimal('20') and latest_spend > previous_spend_dec * Decimal('1.5'):
            issue_cards.append(_build_issue_card(title='单日花费突增', level='medium', summary=f"{latest_day['report_date']} 花费较上一日抬升 {Decimal(str(latest_day['spend_change_ratio'])) * Decimal('100'):.2f}%，建议回看活动和预算变更。", drill_to='time-trend', next_step='先确认趋势页的异常日期，再回到活动页看是否有放量或预算变化。'))
    high_cross_sell_items = [item for item in cross_sell_items if str(item['action']) == '放大关联']
    if high_cross_sell_items:
        issue_cards.append(_build_issue_card(title='存在关联购买放大量', level='medium', summary=f'当前识别到 {len(high_cross_sell_items)} 个广告 SKU 明显带动其他商品成交，可结合 SKU 页继续加码。', drill_to='products', next_step='进入 SKU 页，优先对能带动交叉销售的 SKU 做预算和承接优化。'))

    top_campaigns = sorted([{'campaign_name': row.campaign_name or '-', 'spend': _serialize_decimal(Decimal(row.spend or 0)), 'sales_7d': _serialize_decimal(Decimal(row.sales_7d or 0)), 'orders_7d': int(row.orders_7d or 0), 'acos': round_ratio(Decimal(row.acos or 0))} for row in campaign_rows], key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)[:5]
    top_products = sorted([{'ad_sku': row.ad_sku or '-', 'ad_asin': row.ad_asin or '-', 'spend': _serialize_decimal(Decimal(row.spend or 0)), 'sales_7d': _serialize_decimal(Decimal(row.sales_7d or 0)), 'orders_7d': int(row.orders_7d or 0), 'acos': round_ratio(Decimal(row.acos or 0))} for row in product_rows], key=lambda item: (float(item['spend']), float(item['sales_7d'])), reverse=True)[:5]
    top_waste_terms = sorted([{'search_term': row.search_term or '-', 'campaign_name': row.campaign_name or '-', 'clicks': int(row.clicks or 0), 'spend': _serialize_decimal(Decimal(row.spend or 0)), 'orders_7d': int(row.orders_7d or 0)} for row in waste_terms], key=lambda item: (float(item['spend']), int(item['clicks'])), reverse=True)[:5]

    low_ctr_product_rows = [row for row in product_rows if int(row.impressions or 0) >= 100 and Decimal(row.ctr or 0) < Decimal('0.005')]
    high_click_low_order_products = [row for row in product_rows if int(row.clicks or 0) >= 5 and int(row.orders_7d or 0) == 0 and Decimal(row.spend or 0) >= Decimal('5')]
    high_spend_campaign = top_campaigns[0] if top_campaigns else None
    high_spend_product = top_products[0] if top_products else None

    narrative_sections: list[dict[str, Any]] = []
    scale_or_efficiency_summary = '当前广告整体'
    scale_or_efficiency_evidence = [
        f"花费 {_serialize_decimal(total_spend):,.2f} 美元，销售额 {_serialize_decimal(total_sales):,.2f} 美元，订单 {total_orders} 单。",
        f"CTR {round_ratio(ctr) * 100:.2f}%，CPC {_serialize_decimal(cpc):,.2f} 美元，ACOS {round_ratio(acos) * 100:.2f}%。",
    ]
    if total_sales > DECIMAL_ZERO and acos <= Decimal('0.35'):
        scale_or_efficiency_summary += '处于可放量区间，效率仍在可控范围内。'
    elif total_sales > DECIMAL_ZERO:
        scale_or_efficiency_summary += '仍有产出，但效率承压，需要先控浪费再扩量。'
    elif total_spend > DECIMAL_ZERO:
        scale_or_efficiency_summary += '已有消耗但产出不足，当前更像是控损阶段。'
    else:
        scale_or_efficiency_summary += '尚未形成有效投放规模。'
    if high_spend_campaign is not None:
        scale_or_efficiency_evidence.append(f"当前高消耗活动是 {high_spend_campaign['campaign_name']}，花费 {float(high_spend_campaign['spend']):.2f} 美元。")
    narrative_sections.append(_build_narrative_section(title='总体结论', summary=f"{scale_or_efficiency_summary}{(' ' + str(comparison_raw['summary'])) if comparison_raw is not None and comparison_raw.get('summary') else ''}", evidence=scale_or_efficiency_evidence, action='先确认整体是在放量提效还是放量失效，再决定往活动还是承接层继续下钻。', drill_to='campaigns'))

    management_evidence: list[str] = []
    management_summary = '管理运营层目前没有出现明显的预算、广告位或流量质量异常。'
    management_action = '保持当前活动结构，继续观察趋势和核心活动。'
    management_drill = 'campaigns'
    if budget_limited_rows:
        management_evidence.append(f"有 {len(budget_limited_rows)} 个活动预算在线时间不足但仍有订单或销售额。")
        management_summary = '管理运营层的主要问题先看预算受限，增长没有被完全接住。'
        management_action = '优先给有效活动补预算，再回查是否还有低效活动同步放量。'
        management_drill = 'budget'
    if weak_placement_rows:
        management_evidence.append(f"有 {len(weak_placement_rows)} 条广告位明细出现高点击无单。")
        management_summary = '管理运营层同时存在广告位效率分化，位置结构正在拖累整体效率。'
        management_action = '优先回看高点击无单的广告位，避免首页或商品页继续低效消耗。'
        management_drill = 'placements'
    if high_risk_traffic_rows:
        management_evidence.append(f"有 {len(high_risk_traffic_rows)} 个活动出现高无效点击或高无效曝光。")
        management_summary = '管理运营层还有流量质量风险，不能把问题全部归因给商品承接。'
        management_action = '先排查异常入口和异常广告位，再做常规调价。'
        management_drill = 'traffic-quality'
    narrative_sections.append(_build_narrative_section(title='管理层归因', summary=management_summary, evidence=management_evidence or ['预算、广告位、流量质量三层目前都没有触发明显异常信号。'], action=management_action, drill_to=management_drill))

    traffic_evidence: list[str] = []
    traffic_summary = '来源层暂时没有明显的浪费词集中问题。'
    traffic_action = '继续观察搜索词结构，重点看新词与高份额缺口词。'
    if top_waste_terms:
        first_waste_term = top_waste_terms[0]
        traffic_summary = '来源层已经出现明确浪费点，部分搜索词正在消耗但没有带来订单。'
        traffic_evidence.append(f"浪费最高的搜索词是 {first_waste_term['search_term']}，花费 {float(first_waste_term['spend']):.2f} 美元，点击 {int(first_waste_term['clicks'])} 次。")
        traffic_evidence.append(f"当前共识别到 {len(waste_terms)} 个达到观察门槛但未出单的搜索词。")
        traffic_action = '优先做否词、降价或拆精确承接，避免继续用低质量词放量。'
    narrative_sections.append(_build_narrative_section(title='来源层归因', summary=traffic_summary, evidence=traffic_evidence or ['当前搜索词层没有出现集中性的高花费无单词。'], action=traffic_action, drill_to='search-terms'))

    product_evidence: list[str] = []
    product_summary = '商品承接层暂时没有形成强烈异常，流量与成交大体匹配。'
    product_action = '继续观察高消耗 SKU 的点击与转化，确认是否需要做素材或页面优化。'
    if low_ctr_product_rows:
        product_evidence.append(f"有 {len(low_ctr_product_rows)} 个 SKU 曝光已达到观察门槛，但 CTR 仍低于 0.50%。")
        product_summary = '商品承接层已经出现点击承接偏弱，部分 SKU 曝光能拿到但点不进来。'
        product_action = '优先优化主图、标题和价格表达，再决定是否继续加量。'
    if high_click_low_order_products:
        product_evidence.append(f"有 {len(high_click_low_order_products)} 个 SKU 已出现高点击低转化。")
        product_summary = '商品承接层不仅有点击承接问题，还有转化承接问题。'
        product_action = '先排查落地页竞争力、评价和变体价格带，再决定是否控量。'
    if high_cross_sell_items:
        product_evidence.append(f"有 {len(high_cross_sell_items)} 个广告 SKU 正在明显带动关联购买。")
        if product_summary.startswith('商品承接层暂时没有'):
            product_summary = '商品承接层整体不错，且部分 SKU 已经带动关联购买。'
        product_action = '把能带动关联成交的 SKU 列为优先保量对象，同时补足关联页面承接。'
    if high_spend_product is not None:
        product_evidence.append(f"当前高消耗 SKU 是 {high_spend_product['ad_sku']}，花费 {float(high_spend_product['spend']):.2f} 美元。")
    narrative_sections.append(_build_narrative_section(title='承接层归因', summary=product_summary, evidence=product_evidence or ['推广商品和已购买商品层暂时没有出现明显承接异常。'], action=product_action, drill_to='products'))

    return {
        'project_id': project_id,
        'country': normalized_country,
        'metrics': [
            {'label': 'Spend', 'value': _serialize_decimal(total_spend), 'display_value': f'${_serialize_decimal(total_spend):,.2f}', 'helper': '广告总花费'},
            {'label': 'Sales 7d', 'value': _serialize_decimal(total_sales), 'display_value': f'${_serialize_decimal(total_sales):,.2f}', 'helper': '7天销售额'},
            {'label': 'Orders 7d', 'value': float(total_orders), 'display_value': str(total_orders), 'helper': '7天订单数'},
            {'label': 'CTR', 'value': round_ratio(ctr), 'display_value': f'{round_ratio(ctr) * 100:.2f}%', 'helper': '点击率'},
            {'label': 'CPC', 'value': round_money(cpc), 'display_value': f'${round_money(cpc):,.2f}', 'helper': '单次点击成本'},
            {'label': 'ACOS', 'value': round_ratio(acos), 'display_value': f'{round_ratio(acos) * 100:.2f}%', 'helper': '广告投入产出比'},
            {'label': 'ROAS', 'value': round_ratio(roas), 'display_value': f'{round_ratio(roas):.2f}', 'helper': '广告投资回报率'},
            {'label': 'Trend Days', 'value': float(len(trend_summary)), 'display_value': str(len(trend_summary)), 'helper': '当前筛选范围内已入库的趋势天数'},
            {'label': 'Cross-sell Sales 7d', 'value': _serialize_decimal(total_cross_sell_sales), 'display_value': f'${_serialize_decimal(total_cross_sell_sales):,.2f}', 'helper': f'关联购买销售额 / 订单 {total_cross_sell_orders}'},
        ],
        'issue_cards': issue_cards,
        'narrative_sections': narrative_sections,
        'comparison': comparison_raw,
        'top_campaigns': top_campaigns,
        'top_products': top_products,
        'top_waste_terms': top_waste_terms,
        'trend_summary': trend_summary[-7:],
        'top_cross_sell_products': cross_sell_items[:5],
    }


def _build_period_comparison_safe(**kwargs) -> dict | None:
    from app.utils.period_comparison import build_period_comparison
    try:
        return build_period_comparison(**kwargs)
    except Exception:
        return None