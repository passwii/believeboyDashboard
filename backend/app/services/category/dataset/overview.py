"""Dataset overview aggregation.

Builds complete dataset overview with all metrics.
"""

from __future__ import annotations

from collections import Counter
from typing import Any
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    CategoryResearchDataset,
    CategoryResearchProductDetail,
    CategoryResearchSalesTrend,
)


def _build_launch_month_distribution(rows: list[CategoryResearchProductDetail]) -> list[dict[str, Any]]:
    """Build distribution of products by launch month."""
    from collections import defaultdict
    month_counter: dict[str, int] = defaultdict(int)
    for item in rows:
        if item.launch_date:
            month_key = f"{item.launch_date.year:04d}-{item.launch_date.month:02d}"
            month_counter[month_key] += 1
    return [
        {'label': key, 'count': int(count)}
        for key, count in sorted(month_counter.items(), key=lambda x: x[0], reverse=True)
    ]


def get_dataset_overview(
    db: Session,
    dataset_id: int,
    *,
    price_band_standard: str | None = None,
    price_band_breaks: str | None = None,
) -> dict[str, Any]:
    """Build complete dataset overview with all metrics."""
    import numpy as np

    from app.services.category.analytics import (
        build_market_concentration,
        build_brand_monopoly,
        build_seller_monopoly,
        build_product_monopoly,
        build_china_seller_competition,
        build_market_growth,
        build_seasonality,
        build_review_research,
        build_price_band_opportunities,
        build_new_product_opportunity,
        build_supply_complexity,
        build_asin_momentum,
        build_data_quality,
        build_dimension_profiles,
        build_dimension_blocks,
        build_metric_definitions,
        build_action_recommendations,
        build_signals,
    )
    from app.services.category.product_detail import (
        build_dimension_price_band_analysis,
        build_brand_price_band_analysis,
        resolve_price_band_spec,
    )

    dataset = db.get(CategoryResearchDataset, dataset_id)
    if dataset is None:
        raise ValueError('Dataset not found')

    rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(CategoryResearchProductDetail.dataset_id == dataset_id)
        ).scalars().all()
    )
    trend_rows = list(
        db.execute(
            select(CategoryResearchSalesTrend).where(CategoryResearchSalesTrend.dataset_id == dataset_id)
        ).scalars().all()
    )
    asins = sorted(
        {
            str(item.asin)
            for item in trend_rows
            if item
        }
    )

    prices = [float(item.price_usd) for item in rows if item.price_usd is not None]
    monthly_sales_values = [int(item.monthly_sales or 0) for item in rows]
    monthly_revenue_values = [float(item.monthly_revenue_usd or 0) for item in rows]
    total_monthly_sales = int(sum(monthly_sales_values))
    total_monthly_revenue = float(sum(monthly_revenue_values))
    amazon_count = sum(1 for item in rows if item.is_amazon)

    brand_counter: dict[str, int] = {}
    for item in rows:
        brand = (item.brand or 'Unknown').strip() or 'Unknown'
        brand_counter[brand] = brand_counter.get(brand, 0) + int(item.monthly_sales or 0)
    total_brand_sales = sum(brand_counter.values())
    brand_sales_share = [
        {
            'brand': brand,
            'monthly_sales': int(sales),
            'share': round((sales / total_brand_sales) if total_brand_sales else 0.0, 6),
        }
        for brand, sales in sorted(brand_counter.items(), key=lambda pair: pair[1], reverse=True)[:10]
    ]

    listing_age_distribution_counter: Counter[str] = Counter()
    for item in rows:
        age = item.listing_age_days
        if age is None:
            listing_age_distribution_counter['未知'] += 1
        elif age <= 90:
            listing_age_distribution_counter['0-90天'] += 1
        elif age <= 180:
            listing_age_distribution_counter['91-180天'] += 1
        elif age <= 365:
            listing_age_distribution_counter['181-365天'] += 1
        else:
            listing_age_distribution_counter['365天+'] += 1

    from app.services.category.dataset.price_bands import (
        build_fixed_price_bands,
        build_quantile_price_bands,
        build_price_stats,
        price_sales_correlation,
        build_fba_fee_distribution,
        resolve_price_band_spec as _resolve_price_band_spec,
    )

    launch_month_distribution = _build_launch_month_distribution(rows)
    fulfillment_counter: Counter[str] = Counter()
    for item in rows:
        key = (item.fulfillment_method or '未知').strip() or '未知'
        fulfillment_counter[key] += 1

    price_band_spec = _resolve_price_band_spec(standard=price_band_standard, breaks_text=price_band_breaks, prices=prices)
    fixed_price_bands = build_fixed_price_bands(prices, spec=price_band_spec)
    quantile_price_bands = build_quantile_price_bands(prices)
    price_stats = build_price_stats(prices)

    correlation = price_sales_correlation(rows)

    fba_fee_distribution = build_fba_fee_distribution(rows)

    points = [
        {
            'asin': item.asin,
            'price_usd': float(item.price_usd),
            'monthly_sales': int(item.monthly_sales or 0),
        }
        for item in rows
        if item.price_usd is not None
    ]
    points = sorted(points, key=lambda entry: entry['monthly_sales'], reverse=True)[:300]

    market_concentration = build_market_concentration(brand_counter, total_brand_sales)
    brand_monopoly = build_brand_monopoly(brand_counter, total_brand_sales)
    seller_monopoly = build_seller_monopoly(rows)
    product_monopoly = build_product_monopoly(rows)
    china_seller_competition = build_china_seller_competition(rows)
    market_growth = build_market_growth(trend_rows)
    seasonality = build_seasonality(trend_rows)
    review_research = build_review_research(rows)
    price_band_opportunities = build_price_band_opportunities(
            rows,
            total_monthly_sales=total_monthly_sales,
            total_monthly_revenue=total_monthly_revenue,
            spec=price_band_spec,
    )
    dimension_price_band_analysis = build_dimension_price_band_analysis(rows, spec=price_band_spec)
    brand_price_band_analysis = build_brand_price_band_analysis(rows, spec=price_band_spec)
    new_product_opportunity = build_new_product_opportunity(rows, total_monthly_sales=total_monthly_sales)
    supply_complexity = build_supply_complexity(
            rows,
            fulfillment_counter=fulfillment_counter,
            prices=prices,
    )
    asin_momentum = build_asin_momentum(trend_rows)
    data_quality = build_data_quality(dataset, rows)

    advanced_metrics = {
        'market_concentration': market_concentration,
        'brand_monopoly': brand_monopoly,
        'seller_monopoly': seller_monopoly,
        'product_monopoly': product_monopoly,
        'china_seller_competition': china_seller_competition,
        'market_growth': market_growth,
        'seasonality': seasonality,
        'review_research': review_research,
        'price_band_opportunities': price_band_opportunities,
        'price_band_standard': price_band_spec['name'],
        'price_band_method': price_band_spec['method'],
        'price_band_method_description': price_band_spec['description'],
        'price_band_breaks': price_band_spec['breaks'],
        'price_correlation_score': round(max(0.0, 100.0 - (abs(correlation) * 100.0)), 2),
        'dimension_price_band_analysis': dimension_price_band_analysis,
        'brand_price_band_analysis': brand_price_band_analysis,
        'new_product_opportunity': new_product_opportunity,
        'supply_complexity': supply_complexity,
        'asin_momentum': asin_momentum,
        'data_quality': data_quality,
    }
    advanced_metrics['dimension_blocks'] = build_dimension_blocks(advanced_metrics)
    advanced_metrics['metric_definitions'] = build_metric_definitions(advanced_metrics)
    advanced_metrics['action_recommendations'] = build_action_recommendations(advanced_metrics)
    advanced_metrics['signals'] = build_signals(advanced_metrics)
    advanced_metrics['dimension_profiles'] = build_dimension_profiles(rows)

    return {
        'dataset': dataset,
        'kpis': {
            'sample_count': len(rows),
            'brand_count': len({(item.brand or '').strip() for item in rows if (item.brand or '').strip()}),
            'average_price_usd': round(float(np.mean(prices)) if prices else 0.0, 2),
            'total_monthly_sales': total_monthly_sales,
            'total_monthly_revenue_usd': round(total_monthly_revenue, 2),
            'amazon_share': round((amazon_count / len(rows)) if rows else 0.0, 6),
        },
        'brand_sales_share': brand_sales_share,
        'listing_age_distribution': [
            {'label': label, 'count': int(count)}
            for label, count in listing_age_distribution_counter.items()
        ],
        'launch_month_distribution': launch_month_distribution,
        'fulfillment_distribution': [
            {'label': label, 'count': int(count)}
            for label, count in fulfillment_counter.items()
        ],
        'fixed_price_bands': fixed_price_bands,
        'quantile_price_bands': quantile_price_bands,
        'price_stats': price_stats,
        'price_sales_correlation': round(correlation, 6),
        'fba_fee_distribution': fba_fee_distribution,
        'price_sales_points': points,
        'available_asins': asins,
        'advanced_metrics': advanced_metrics,
    }