"""Market growth, seasonality, and ASIN momentum metrics."""

from __future__ import annotations

from typing import Any

import numpy as np


def build_market_growth(trend_rows: list) -> dict[str, Any]:
    """Calculate market growth metrics."""
    from app.services.category.sales_trend import aggregate_market_monthly_sales

    monthly_totals = aggregate_market_monthly_sales(trend_rows)
    ordered = sorted(monthly_totals.items(), key=lambda item: item[0])
    if len(ordered) < 2:
        return {
            'trend_slope': 0.0,
            'last12_vs_prev12_growth': 0.0,
            'cagr_like_growth': 0.0,
            'growth_level': 'stable',
        }

    months = np.array(range(len(ordered)), dtype=float)
    sales = np.array([float(item[1]) for item in ordered], dtype=float)
    trend_slope = float(np.polyfit(months, sales, 1)[0]) if len(ordered) >= 2 else 0.0

    if len(sales) >= 24:
        prev12 = float(np.sum(sales[-24:-12]))
        last12 = float(np.sum(sales[-12:]))
    elif len(sales) >= 12:
        split = len(sales) // 2
        prev12 = float(np.sum(sales[:split]))
        last12 = float(np.sum(sales[split:]))
    else:
        prev12 = float(np.sum(sales[:-1]))
        last12 = float(sales[-1])
    last12_vs_prev12_growth = (last12 - prev12) / prev12 if prev12 > 0 else (1.0 if last12 > 0 else 0.0)

    first = float(sales[0])
    last = float(sales[-1])
    periods = max(1, len(sales) - 1)
    if first > 0:
        cagr_like_growth = (last / first) ** (12.0 / periods) - 1.0
    else:
        cagr_like_growth = 1.0 if last > 0 else 0.0

    if last12_vs_prev12_growth >= 0.08 or cagr_like_growth >= 0.1:
        growth_level = 'growing'
    elif last12_vs_prev12_growth <= -0.08 or cagr_like_growth <= -0.08:
        growth_level = 'shrinking'
    else:
        growth_level = 'stable'

    growth_anchor = max(last12_vs_prev12_growth, cagr_like_growth)
    if growth_anchor >= 0.25:
        growth_tier = 'explosive'
        radar_score = 96.0
    elif growth_anchor >= 0.12:
        growth_tier = 'fast_growing'
        radar_score = 84.0
    elif growth_anchor >= 0.03:
        growth_tier = 'growing'
        radar_score = 68.0
    elif growth_anchor > -0.03:
        growth_tier = 'stable'
        radar_score = 52.0
    elif growth_anchor > -0.12:
        growth_tier = 'softening'
        radar_score = 30.0
    else:
        growth_tier = 'shrinking'
        radar_score = 12.0

    return {
        'trend_slope': round(trend_slope, 4),
        'last12_vs_prev12_growth': round(float(last12_vs_prev12_growth), 6),
        'cagr_like_growth': round(float(cagr_like_growth), 6),
        'growth_level': growth_level,
        'growth_tier': growth_tier,
        'radar_score': radar_score,
        'tier_thresholds': [
            '爆发增长 >= 25%',
            '快速增长 12%-25%',
            '温和增长 3%-12%',
            '平稳 -3%~3%',
            '走弱 -12%~-3%',
            '收缩 < -12%',
        ],
    }


def build_seasonality(trend_rows: list) -> dict[str, Any]:
    """Calculate seasonality metrics."""
    from app.services.category.sales_trend import aggregate_market_monthly_sales

    monthly_totals = aggregate_market_monthly_sales(trend_rows)
    ordered = sorted(monthly_totals.items(), key=lambda item: item[0])
    if not ordered:
        return {
            'peak3_month_sales_share': 0.0,
            'monthly_sales_cv': 0.0,
            'seasonality_level': 'weak',
            'recommended_entry_months': [],
        }

    sales = [float(item[1]) for item in ordered]
    total_sales = float(sum(sales))
    peak3_month_sales_share = round(
        (sum(sorted(sales, reverse=True)[:3]) / total_sales) if total_sales > 0 else 0.0, 6
    )
    mean_sales = float(np.mean(sales)) if sales else 0.0
    monthly_sales_cv = round(
        (float(np.std(sales)) / mean_sales) if mean_sales > 0 else 0.0, 6
    )

    month_bucket: dict[int, float] = {}
    for year_month, value in ordered:
        month = int(year_month[-2:])
        month_bucket[month] = month_bucket.get(month, 0.0) + float(value)
    hot_months = [month for month, _ in sorted(month_bucket.items(), key=lambda item: item[1], reverse=True)[:3]]
    recommended_entry_months = []
    for month in hot_months:
        entry = month - 1 if month > 1 else 12
        text = f'{entry:02d}'
        if text not in recommended_entry_months:
            recommended_entry_months.append(text)

    if peak3_month_sales_share >= 0.45 or monthly_sales_cv >= 0.6:
        seasonality_level = 'strong'
    elif peak3_month_sales_share >= 0.32 or monthly_sales_cv >= 0.35:
        seasonality_level = 'moderate'
    else:
        seasonality_level = 'weak'

    if peak3_month_sales_share >= 0.58 or monthly_sales_cv >= 0.85:
        seasonality_tier = 'extreme'
        entry_friendliness_score = 12.0
    elif peak3_month_sales_share >= 0.45 or monthly_sales_cv >= 0.6:
        seasonality_tier = 'strong'
        entry_friendliness_score = 28.0
    elif peak3_month_sales_share >= 0.38 or monthly_sales_cv >= 0.45:
        seasonality_tier = 'elevated'
        entry_friendliness_score = 46.0
    elif peak3_month_sales_share >= 0.32 or monthly_sales_cv >= 0.35:
        seasonality_tier = 'moderate'
        entry_friendliness_score = 64.0
    elif peak3_month_sales_share >= 0.26 or monthly_sales_cv >= 0.22:
        seasonality_tier = 'mild'
        entry_friendliness_score = 82.0
    else:
        seasonality_tier = 'balanced'
        entry_friendliness_score = 94.0

    return {
        'peak3_month_sales_share': peak3_month_sales_share,
        'monthly_sales_cv': monthly_sales_cv,
        'seasonality_level': seasonality_level,
        'recommended_entry_months': recommended_entry_months,
        'seasonality_tier': seasonality_tier,
        'entry_friendliness_score': entry_friendliness_score,
        'tier_thresholds': [
            '全年均衡: Peak3 < 26% 且 CV < 0.22',
            '轻季节性: Peak3 26%-32% 或 CV 0.22-0.35',
            '中季节性: Peak3 32%-45% 或 CV 0.35-0.60',
            '强季节性: Peak3 45%-58% 或 CV 0.60-0.85',
            '极强季节性: Peak3 >= 58% 或 CV >= 0.85',
        ],
    }


def build_asin_momentum(trend_rows: list, *, limit: int = 30) -> list[dict[str, Any]]:
    """Calculate ASIN momentum metrics."""
    grouped: dict[str, list[tuple[str, int]]] = {}
    for item in trend_rows:
        asin = (item.asin or '').strip().upper()
        if not asin:
            continue
        grouped.setdefault(asin, []).append((item.year_month, int(item.monthly_sales or 0)))

    payload: list[dict[str, Any]] = []
    for asin, points in grouped.items():
        ordered = sorted(points, key=lambda entry: entry[0])
        sales = [value for _, value in ordered]
        if not sales:
            continue

        avg_sales = float(np.mean(sales))
        std_sales = float(np.std(sales))
        sales_cv = (std_sales / avg_sales) if avg_sales > 0 else 0.0

        yoy_growth = 0.0
        if len(sales) >= 13:
            baseline = float(sales[-13])
            latest = float(sales[-1])
            if baseline > 0:
                yoy_growth = (latest - baseline) / baseline
            elif latest > 0:
                yoy_growth = 1.0

        recent_3m_momentum = 0.0
        if len(sales) >= 6:
            latest_avg = float(np.mean(sales[-3:]))
            previous_avg = float(np.mean(sales[-6:-3]))
            if previous_avg > 0:
                recent_3m_momentum = (latest_avg - previous_avg) / previous_avg
            elif latest_avg > 0:
                recent_3m_momentum = 1.0

        payload.append(
            {
                'asin': asin,
                'avg_monthly_sales': round(avg_sales, 2),
                'sales_cv': round(sales_cv, 6),
                'yoy_growth': round(float(yoy_growth), 6),
                'recent_3m_momentum': round(float(recent_3m_momentum), 6),
            }
        )

    payload.sort(key=lambda item: item['avg_monthly_sales'], reverse=True)
    return payload[:limit]