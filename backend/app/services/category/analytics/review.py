"""Review research, price band opportunities, and new product opportunity metrics."""

from __future__ import annotations

from typing import Any

# BLF-1036: numpy imported lazily (boot chain: endpoints.category_research).


def build_review_research(rows: list) -> dict[str, Any]:
    """Calculate review and rating metrics."""
    import numpy as np
    review_values = [max(0, int(item.review_count or 0)) for item in rows]
    rating_values = [float(item.rating) for item in rows if item.rating is not None]

    if not review_values:
        return {
            'average_rating': 0.0,
            'review_median': 0.0,
            'review_p75': 0.0,
            'review_top10_share': 0.0,
            'low_review_product_share': 0.0,
            'low_review_threshold': 100,
            'bottom_quartile_product_share': 0.0,
            'rating_band_distribution': [],
            'review_segment_distribution': [],
        }

    total_reviews = float(sum(review_values))
    sorted_reviews = sorted(review_values, reverse=True)
    top10_reviews = float(sum(sorted_reviews[:10]))
    low_review_threshold = 100
    low_review_count = sum(1 for value in review_values if value < low_review_threshold)
    bottom_quartile_cutoff = float(np.percentile(review_values, 25)) if review_values else 0.0
    bottom_quartile_count = sum(1 for value in review_values if value <= bottom_quartile_cutoff)

    rating_bands = [
        ('1.0-1.5', 1.0, 1.5),
        ('1.5-2.0', 1.5, 2.0),
        ('2.0-2.5', 2.0, 2.5),
        ('2.5-3.0', 2.5, 3.0),
        ('3.0-3.5', 3.0, 3.5),
        ('3.5-4.0', 3.5, 4.0),
        ('4.0-4.5', 4.0, 4.5),
        ('4.5-5.0', 4.5, 5.01),
    ]
    rating_distribution: list[dict[str, Any]] = []
    for label, lower, upper in rating_bands:
        count = 0
        for value in rating_values:
            if lower <= value < upper:
                count += 1
        rating_distribution.append({'label': label, 'count': count})

    positive_reviews = sorted({value for value in review_values if value > 0})
    if positive_reviews:
        quantiles = [float(np.percentile(positive_reviews, q)) for q in range(10, 100, 10)]
        rounded = sorted({max(1, int(round(value))) for value in quantiles})
    else:
        rounded = []
    boundaries = [0]
    for value in rounded:
        if value > boundaries[-1]:
            boundaries.append(value)
    if not boundaries or boundaries[-1] < max(review_values):
        boundaries.append(max(review_values))

    review_segments: list[dict[str, Any]] = []
    for index in range(len(boundaries) - 1):
        lower = boundaries[index]
        upper = boundaries[index + 1]
        if index == len(boundaries) - 2:
            label = f'{lower}+'
            segment_rows = [item for item in rows if max(0, int(item.review_count or 0)) >= lower]
        else:
            label = f'{lower}-{max(lower, upper - 1)}'
            segment_rows = [
                item
                for item in rows
                if lower <= max(0, int(item.review_count or 0)) < upper
            ]
        review_segments.append(
            {
                'label': label,
                'count': len(segment_rows),
                'monthly_sales': int(sum(int(item.monthly_sales or 0) for item in segment_rows)),
            }
        )

    return {
        'average_rating': round(float(np.mean(rating_values)) if rating_values else 0.0, 2),
        'review_median': round(float(np.median(review_values)), 2),
        'review_p75': round(float(np.percentile(review_values, 75)), 2),
        'review_top10_share': round((top10_reviews / total_reviews) if total_reviews > 0 else 0.0, 6),
        'low_review_product_share': round((low_review_count / len(review_values)), 6),
        'low_review_threshold': low_review_threshold,
        'bottom_quartile_product_share': round((bottom_quartile_count / len(review_values)), 6),
        'rating_band_distribution': rating_distribution,
        'review_segment_distribution': review_segments,
    }


def build_price_band_opportunities(
    rows: list,
    *,
    total_monthly_sales: int,
    total_monthly_revenue: float,
    spec: dict[str, Any],
) -> list[dict[str, Any]]:
    """Calculate opportunities across price bands."""
    from app.services.category.product_detail import resolve_price_band

    labels = [str(item['label']) for item in spec['bands']]
    buckets: dict[str, dict[str, float]] = {
        label: {
            'count': 0,
            'monthly_sales': 0,
            'monthly_revenue_usd': 0.0,
            'rating_sum': 0.0,
            'rating_count': 0,
            'review_count_sum': 0.0,
        }
        for label in labels
    }

    for item in rows:
        if item.price_usd is None:
            continue
        label = resolve_price_band(float(item.price_usd), spec=spec)
        entry = buckets[label]
        entry['count'] += 1
        entry['monthly_sales'] += int(item.monthly_sales or 0)
        entry['monthly_revenue_usd'] += float(item.monthly_revenue_usd or 0)
        entry['review_count_sum'] += float(item.review_count or 0)
        if item.rating is not None:
            entry['rating_sum'] += float(item.rating)
            entry['rating_count'] += 1

    total_sales = max(1, total_monthly_sales)
    total_revenue = max(1e-9, total_monthly_revenue)

    payload: list[dict[str, Any]] = []
    for label in labels:
        entry = buckets[label]
        count = int(entry['count'])
        rating_count = int(entry['rating_count'])
        payload.append(
            {
                'label': label,
                'count': count,
                'monthly_sales': int(entry['monthly_sales']),
                'monthly_revenue_usd': round(float(entry['monthly_revenue_usd']), 2),
                'sales_share': round(float(entry['monthly_sales']) / total_sales, 6),
                'revenue_share': round(float(entry['monthly_revenue_usd']) / total_revenue, 6),
                'average_rating': round((float(entry['rating_sum']) / rating_count) if rating_count > 0 else 0.0, 4),
                'average_review_count': round((float(entry['review_count_sum']) / count) if count > 0 else 0.0, 2),
            }
        )
    return payload


def build_new_product_opportunity(
    rows: list,
    *,
    total_monthly_sales: int,
) -> dict[str, float]:
    """Calculate new product opportunity metrics."""
    import numpy as np

    if not rows:
        return {
            'new_product_count': 0,
            'new_product_share': 0.0,
            'new_product_sales_share': 0.0,
            'new_product_avg_monthly_sales': 0.0,
            'new_product_median_price_usd': 0.0,
        }

    new_rows = [item for item in rows if item.is_new_90d]
    new_sales = sum(int(item.monthly_sales or 0) for item in new_rows)
    new_prices = [float(item.price_usd) for item in new_rows if item.price_usd is not None]
    new_sales_values = [int(item.monthly_sales or 0) for item in new_rows]

    new_product_share = round(len(new_rows) / len(rows), 6)
    new_product_sales_share = round(new_sales / max(1, total_monthly_sales), 6)
    opportunity_signal = max(new_product_share, new_product_sales_share * 1.15)

    if opportunity_signal >= 0.25:
        opportunity_level = 'very_high'
        radar_score = 92.0
    elif opportunity_signal >= 0.16:
        opportunity_level = 'high'
        radar_score = 76.0
    elif opportunity_signal >= 0.08:
        opportunity_level = 'medium'
        radar_score = 58.0
    elif opportunity_signal >= 0.04:
        opportunity_level = 'low'
        radar_score = 36.0
    else:
        opportunity_level = 'very_low'
        radar_score = 18.0

    return {
        'new_product_count': len(new_rows),
        'new_product_share': new_product_share,
        'new_product_sales_share': new_product_sales_share,
        'new_product_avg_monthly_sales': round(float(np.mean(new_sales_values)) if new_sales_values else 0.0, 2),
        'new_product_median_price_usd': round(float(np.median(new_prices)) if new_prices else 0.0, 2),
        'opportunity_level': opportunity_level,
        'radar_score': radar_score,
        'level_thresholds': [
            '极高 >= 25%',
            '高 16%-25%',
            '中 8%-16%',
            '低 4%-8%',
            '极低 < 4%',
            '判定取新品数量占比与新品销量占比的综合信号。',
        ],
    }