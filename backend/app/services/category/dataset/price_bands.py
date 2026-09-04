"""Price band calculation functions."""

from __future__ import annotations

from collections import Counter
from typing import Any

import pandas as pd
from sqlalchemy.orm import Session

from app.models import CategoryResearchProductDetail, CategoryResearchSalesTrend


def resolve_price_band_spec(
    *,
    standard: str | None = None,
    breaks_text: str | None = None,
    prices: list[float] | None = None,
) -> dict[str, Any]:
    """Resolve price band specification from various input methods."""
    from app.services.category.product_detail import (
        _PRICE_BAND_PRESETS,
        auto_price_breaks,
        nice_price_step,
        parse_price_breaks_text,
    )

    method = 'manual_custom'
    name = 'custom'
    description = '手动设置价格带断点'
    breaks: list[float] = []

    if standard and standard in _PRICE_BAND_PRESETS:
        breaks = list(_PRICE_BAND_PRESETS[standard])
        name = str(standard)
        method = 'preset'
        description = f'预设断点 {name}'
    elif breaks_text:
        breaks = parse_price_breaks_text(breaks_text)
        name = 'custom'
        method = 'manual_custom'
        description = '手动设置价格带断点'
    elif prices:
        raw_breaks = auto_price_breaks(prices, max_breaks=8)
        breaks = [nice_price_step(raw_breaks[0])]
        for value in raw_breaks[1:]:
            breaks.append(nice_price_step(value))
        name = 'scientific_refined'
        method = 'scientific_refined'
        description = '基于数据分布自动生成断点'

    bands = []
    prev_lower = 0.0
    for i, upper in enumerate(breaks):
        key = f'band_{i}'
        bands.append({
            'key': key,
            'label': f'${prev_lower:.0f}-${upper:.0f}',
            'lower': prev_lower,
            'upper': upper,
        })
        prev_lower = upper
    bands.append({
        'key': f'band_{len(breaks)}',
        'label': f'${prev_lower:.0f}+',
        'lower': prev_lower,
        'upper': None,
    })

    return {
        'name': name,
        'method': method,
        'description': description,
        'breaks': breaks,
        'bands': bands,
    }


def build_fixed_price_bands(prices: list[float], *, spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Build sample distribution across fixed price bands."""
    from app.services.category.product_detail import resolve_price_band

    counter = {str(item['label']): 0 for item in spec['bands']}
    for price in prices:
        label = resolve_price_band(float(price), spec=spec)
        counter[label] += 1
    return [{'label': key, 'count': int(value)} for key, value in counter.items()]


def build_quantile_price_bands(prices: list[float]) -> list[dict[str, Any]]:
    """Build quantile-based price bands."""
    if not prices:
        return []

    series = pd.Series(prices)
    quantiles = series.quantile([0.25, 0.5, 0.75, 1.0]).tolist()
    p25, p50, p75, p100 = [float(item) for item in quantiles]

    counter = {'Q1': 0, 'Q2': 0, 'Q3': 0, 'Q4': 0}
    for value in prices:
        if value <= p25:
            counter['Q1'] += 1
        elif value <= p50:
            counter['Q2'] += 1
        elif value <= p75:
            counter['Q3'] += 1
        else:
            counter['Q4'] += 1

    min_price = float(series.min())
    return [
        {'label': 'Q1', 'min_price': min_price, 'max_price': p25, 'count': int(counter['Q1'])},
        {'label': 'Q2', 'min_price': p25, 'max_price': p50, 'count': int(counter['Q2'])},
        {'label': 'Q3', 'min_price': p50, 'max_price': p75, 'count': int(counter['Q3'])},
        {'label': 'Q4', 'min_price': p75, 'max_price': p100, 'count': int(counter['Q4'])},
    ]


def build_price_stats(prices: list[float]) -> dict[str, float]:
    """Build price statistics (mean, median, percentiles)."""
    if not prices:
        return {'mean': 0.0, 'median': 0.0, 'p25': 0.0, 'p75': 0.0}

    series = pd.Series(prices)
    return {
        'mean': round(float(series.mean()), 2),
        'median': round(float(series.median()), 2),
        'p25': round(float(series.quantile(0.25)), 2),
        'p75': round(float(series.quantile(0.75)), 2),
    }


def price_sales_correlation(rows: list[CategoryResearchProductDetail]) -> float:
    """Calculate Pearson correlation between price and sales."""
    import numpy as np

    values: list[tuple[float, float]] = []
    for item in rows:
        if item.price_usd is None:
            continue
        values.append((float(item.price_usd), float(item.monthly_sales or 0)))
    if len(values) < 2:
        return 0.0

    price_vec = np.array([value[0] for value in values], dtype=float)
    sales_vec = np.array([value[1] for value in values], dtype=float)

    if np.std(price_vec) == 0 or np.std(sales_vec) == 0:
        return 0.0

    correlation = np.corrcoef(price_vec, sales_vec)[0, 1]
    if np.isnan(correlation):
        return 0.0
    return float(correlation)


def build_fba_fee_distribution(rows: list[CategoryResearchProductDetail]) -> list[dict[str, Any]]:
    """Build FBA fee distribution across ratio buckets."""
    counter = {
        '0-5%': 0,
        '5-10%': 0,
        '10-15%': 0,
        '15%+': 0,
        '未知': 0,
    }
    for item in rows:
        if item.fba_fee_usd is None or item.price_usd is None or float(item.price_usd) <= 0:
            counter['未知'] += 1
            continue
        ratio = float(item.fba_fee_usd) / float(item.price_usd)
        if ratio < 0.05:
            counter['0-5%'] += 1
        elif ratio < 0.10:
            counter['5-10%'] += 1
        elif ratio < 0.15:
            counter['10-15%'] += 1
        else:
            counter['15%+'] += 1
    return [{'label': label, 'count': int(count)} for label, count in counter.items()]