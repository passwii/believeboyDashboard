"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.math_utils import round_ratio
from app.utils.country import normalize_country
from .helpers import _build_narrative_section, _ensure_project_access, _filter_rows_by_campaigns, _resolve_related_campaigns
from .loaders import _load_invalid_traffic_rows
from .metrics import classify_traffic_next_action, classify_traffic_risk
def build_traffic_quality(
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
    rows = _load_invalid_traffic_rows(
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
        invalid_impression_rate = Decimal(row.invalid_impression_rate or 0)
        invalid_click_rate = Decimal(row.invalid_click_rate or 0)
        risk_level = classify_traffic_risk(
            invalid_click_rate=invalid_click_rate,
            invalid_impression_rate=invalid_impression_rate,
        )

        items.append(
            {
                'campaign_name': (row.campaign_name or '').strip() or '-',
                'status': row.status or '-',
                'total_impressions': int(row.total_impressions or 0),
                'valid_impressions': int(row.valid_impressions or 0),
                'invalid_impressions': int(row.invalid_impressions or 0),
                'invalid_impression_rate': round_ratio(invalid_impression_rate),
                'total_clicks': int(row.total_clicks or 0),
                'valid_clicks': int(row.valid_clicks or 0),
                'invalid_clicks': int(row.invalid_clicks or 0),
                'invalid_click_rate': round_ratio(invalid_click_rate),
                'risk_level': risk_level,
                'next_step': classify_traffic_next_action(risk_level),
            }
        )

    items.sort(
        key=lambda item: (float(item['invalid_click_rate']), float(item['invalid_impression_rate'])),
        reverse=True,
    )
    high_risk_count = sum(1 for item in items if str(item['risk_level']) == '高风险')
    medium_risk_count = sum(1 for item in items if str(item['risk_level']) == '中风险')
    normal_count = sum(1 for item in items if str(item['risk_level']) == '正常')
    max_invalid_click_rate = max((float(item['invalid_click_rate']) for item in items), default=0.0)
    top_risk_item = items[0] if items else None
    traffic_narrative_sections = [
        _build_narrative_section(
            title='流量质量结论',
            summary=(
                '当前流量质量层存在明显异常，需要优先排查异常入口。'
                if high_risk_count > 0
                else '当前流量质量层有轻度波动，但还没有到需要立即收紧的程度。'
                if medium_risk_count > 0
                else '当前流量质量层整体稳定，没有看到明显异常流量。'
            ),
            evidence=[
                f'当前高风险活动 {high_risk_count} 个，中风险活动 {medium_risk_count} 个，正常活动 {normal_count} 个。',
                *(
                    [f"当前最高无效点击率来自 {top_risk_item['campaign_name']}，无效点击率 {float(top_risk_item['invalid_click_rate']) * 100:.2f}%。"]
                    if top_risk_item is not None
                    else []
                ),
            ],
            action='先确认异常是否集中在少数活动，再回查投放入口和广告位，而不是直接全账户降价。',
            drill_to='traffic-quality',
        ),
        _build_narrative_section(
            title='异常流量怎么排查',
            summary='无效点击和无效曝光要分开看，不能一概当成转化差处理。',
            evidence=[
                '无效点击率高，优先怀疑入口质量或异常点击。',
                '无效曝光率高，优先怀疑展示位置、投放面过宽或低意图流量。',
            ],
            action='先定位活动，再依次排查投放对象、搜索词和广告位，确认异常流量来自哪里。',
            drill_to='targets',
        ),
        _build_narrative_section(
            title='和转化问题的边界',
            summary='流量质量异常没有排清之前，不能把问题直接归因为商品承接差。',
            evidence=[
                '如果无效点击先偏高，后续 ACOS、CVR 的恶化可能只是表象。',
                '只有在流量质量基本稳定后，商品承接层的诊断才更可信。',
            ],
            action='高风险活动先做异常流量隔离，确认流量正常后再进入商品页和搜索词页优化转化。',
            drill_to='campaigns',
        ),
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'summary_cards': [
            {
                'label': '高风险活动',
                'value': str(high_risk_count),
                'helper': '优先排查异常入口和异常广告位',
            },
            {
                'label': '中风险活动',
                'value': str(medium_risk_count),
                'helper': '需要继续跟踪的流量异常活动',
            },
            {
                'label': '正常活动',
                'value': str(normal_count),
                'helper': '当前无明显流量异常的活动',
            },
            {
                'label': '最高无效点击率',
                'value': f'{max_invalid_click_rate * 100:.2f}%',
                'helper': '用于快速判断当前最差入口',
            },
        ],
        'narrative_sections': traffic_narrative_sections,
        'items': items,
    }


