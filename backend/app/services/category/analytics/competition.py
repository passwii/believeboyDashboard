"""China seller competition and supply complexity metrics."""

from __future__ import annotations

from collections import Counter
from typing import Any

# BLF-1036: numpy imported lazily (boot chain: endpoints.category_research
# → category.analytics); only the metric builders need it.


def is_china_seller(item) -> bool:
    """Check if seller is from China."""
    country_region = (item.seller_country_region or '').strip().lower()
    if country_region in {'cn', 'china', '中国', '中国大陆', 'mainland china', 'hong kong', '香港', '中国香港'}:
        return True

    seller_text = (item.seller or '').lower()
    bbx_raw = getattr(item, 'raw_row', {}) or {}
    bbx_text = (str(bbx_raw.get('BBX卖家属性', bbx_raw.get('卖家属性', '')))).strip().lower()
    combined = f'{seller_text} {bbx_text}'
    keywords = [
        '中国', 'china', 'chinese', 'cn seller', 'mainland',
        '香港', 'hong kong', 'shenzhen', 'guangdong', '义乌',
    ]
    return any(keyword in combined for keyword in keywords)


def is_amazon_seller(seller: str | None, bbx_attr: str | None) -> bool:
    """Check if seller is Amazon."""
    seller_text = (seller or '').strip().lower()
    bbx_text = (bbx_attr or '').strip().lower()
    if '亚马逊自营' in (bbx_attr or ''):
        return True
    return (
        ('amazon' in seller_text)
        or ('amazon' in bbx_text)
        or ('亚马逊' in (seller or ''))
        or ('亚马逊' in (bbx_attr or ''))
    )


def build_china_seller_competition(rows: list) -> dict[str, Any]:
    """Calculate China seller competition metrics."""
    import numpy as np

    seller_set: set[str] = set()
    china_seller_set: set[str] = set()
    total_sales = 0
    china_sales = 0
    for item in rows:
        seller = (item.seller or 'Unknown').strip() or 'Unknown'
        seller_set.add(seller)
        sales = int(item.monthly_sales or 0)
        total_sales += sales
        if is_china_seller(item):
            china_seller_set.add(seller)
            china_sales += sales

    count_share = round((len(china_seller_set) / max(1, len(seller_set))), 6)
    sales_share = round((china_sales / max(1, total_sales)), 6)
    if count_share >= 0.7 or sales_share >= 0.7:
        risk_level = 'high'
    elif count_share >= 0.5 or sales_share >= 0.5:
        risk_level = 'medium'
    else:
        risk_level = 'low'

    return {
        'china_seller_count': len(china_seller_set),
        'china_seller_count_share': count_share,
        'china_seller_sales_share': sales_share,
        'risk_level': risk_level,
    }


def build_supply_complexity(
    rows: list,
    *,
    fulfillment_counter: Counter[str],
    prices: list[float],
) -> dict[str, float]:
    """Calculate supply complexity metrics."""
    import numpy as np

    total_fulfillment = sum(int(value) for value in fulfillment_counter.values())
    active_counts = [int(value) for value in fulfillment_counter.values() if int(value) > 0]

    if total_fulfillment <= 0 or len(active_counts) <= 1:
        fulfillment_mix_score = 0.0
    else:
        shares = np.array(active_counts, dtype=float) / float(total_fulfillment)
        entropy = float(-np.sum(shares * np.log(shares)))
        max_entropy = float(np.log(len(active_counts)))
        fulfillment_mix_score = (entropy / max_entropy) * 100 if max_entropy > 0 else 0.0

    fee_ratios: list[float] = []
    for item in rows:
        if item.fba_fee_usd is None or item.price_usd is None:
            continue
        price = float(item.price_usd)
        if price <= 0:
            continue
        fee_ratios.append(float(item.fba_fee_usd) / price)
    avg_fee_ratio = float(np.mean(fee_ratios)) if fee_ratios else 0.0
    fba_fee_pressure_score = min(100.0, avg_fee_ratio * 500)

    if len(prices) < 2:
        price_dispersion_score = 0.0
    else:
        mean_price = float(np.mean(prices))
        price_dispersion_score = min(100.0, (float(np.std(prices)) / mean_price) * 100) if mean_price > 0 else 0.0

    score = (fulfillment_mix_score * 0.4) + (fba_fee_pressure_score * 0.4) + (price_dispersion_score * 0.2)

    if score >= 75:
        complexity_level = 'very_high'
    elif score >= 58:
        complexity_level = 'high'
    elif score >= 40:
        complexity_level = 'medium'
    elif score >= 24:
        complexity_level = 'low'
    else:
        complexity_level = 'very_low'

    radar_score = round(max(0.0, 100.0 - score), 2)
    return {
        'score': round(score, 2),
        'fulfillment_mix_score': round(fulfillment_mix_score, 2),
        'fba_fee_pressure_score': round(fba_fee_pressure_score, 2),
        'price_dispersion_score': round(price_dispersion_score, 2),
        'complexity_level': complexity_level,
        'radar_score': radar_score,
        'level_thresholds': [
            '极低复杂度 < 24',
            '低复杂度 24-40',
            '中复杂度 40-58',
            '高复杂度 58-75',
            '极高复杂度 >= 75',
        ],
        'explanation_lines': [
            f'履约混合度 {round(fulfillment_mix_score, 2)} / 100，越高代表 FBA/FBM/SFP 等结构越分散，运营打法越复杂。',
            f'FBA 费用压力 {round(fba_fee_pressure_score, 2)} / 100，基于平均 FBA 费用占售价比例估算，越高代表费用侵蚀越明显。',
            f'价格离散度 {round(price_dispersion_score, 2)} / 100，基于价格标准差 / 平均价，越高代表同类产品价格带更分裂。',
        ],
    }