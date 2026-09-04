"""Data quality and dimension profile metrics."""

from __future__ import annotations

from collections import Counter
from typing import Any


def build_data_quality(dataset, rows: list) -> dict[str, Any]:
    """Calculate data quality metrics."""
    warnings = dataset.quality_warnings if isinstance(dataset.quality_warnings, dict) else {}
    missing_trend_for_asin_count = int(warnings.get('missing_trend_for_asin_count') or 0)
    invalid_price_count = int(warnings.get('invalid_price_count') or 0)
    invalid_fba_fee_count = int(warnings.get('invalid_fba_fee_count') or 0)
    duplicate_asin_count = int(warnings.get('duplicate_asin_count') or 0)
    missing_fba_fee_count = sum(1 for item in rows if item.fba_fee_usd is None)
    missing_seller_country_count = sum(1 for item in rows if not (item.seller_country_region or '').strip())
    missing_brand_count = sum(1 for item in rows if not (item.brand or '').strip())
    unknown_fulfillment_count = sum(
        1
        for item in rows
        if not (item.fulfillment_method or '').strip() or (item.fulfillment_method or '').strip() == '未知'
    )

    base = max(1, int(dataset.row_count_products or 0))
    completeness_penalty = (
        (missing_fba_fee_count / base) * 0.35
        + (missing_seller_country_count / base) * 0.25
        + (missing_brand_count / base) * 0.2
        + (missing_trend_for_asin_count / base) * 0.2
    )
    validity_penalty = (
        (invalid_price_count / base) * 0.55
        + (invalid_fba_fee_count / base) * 0.45
    )
    consistency_penalty = (
        (duplicate_asin_count / base) * 0.6
        + (unknown_fulfillment_count / base) * 0.4
    )
    coverage_penalty = (missing_trend_for_asin_count / base)

    completeness_score = max(0.0, 100.0 * (1.0 - min(1.0, completeness_penalty)))
    validity_score = max(0.0, 100.0 * (1.0 - min(1.0, validity_penalty)))
    consistency_score = max(0.0, 100.0 * (1.0 - min(1.0, consistency_penalty)))
    coverage_score = max(0.0, 100.0 * (1.0 - min(1.0, coverage_penalty)))
    score = (
        completeness_score * 0.3
        + validity_score * 0.3
        + consistency_score * 0.2
        + coverage_score * 0.2
    )
    warning_density = round(
        (
            missing_trend_for_asin_count
            + invalid_price_count
            + invalid_fba_fee_count
            + duplicate_asin_count
            + missing_fba_fee_count
            + missing_seller_country_count
            + missing_brand_count
            + unknown_fulfillment_count
        )
        / base,
        4,
    )

    if score >= 92:
        level = 'excellent'
    elif score >= 82:
        level = 'good'
    elif score >= 68:
        level = 'fair'
    else:
        level = 'poor'

    return {
        'score': round(score, 2),
        'missing_trend_for_asin_count': missing_trend_for_asin_count,
        'invalid_price_count': invalid_price_count,
        'invalid_fba_fee_count': invalid_fba_fee_count,
        'duplicate_asin_count': duplicate_asin_count,
        'missing_fba_fee_count': missing_fba_fee_count,
        'missing_seller_country_count': missing_seller_country_count,
        'missing_brand_count': missing_brand_count,
        'unknown_fulfillment_count': unknown_fulfillment_count,
        'completeness_score': round(completeness_score, 2),
        'validity_score': round(validity_score, 2),
        'consistency_score': round(consistency_score, 2),
        'coverage_score': round(coverage_score, 2),
        'level': level,
        'warning_density': warning_density,
        'summary': (
            f"完整性 {completeness_score:.1f}，有效性 {validity_score:.1f}，一致性 {consistency_score:.1f}，"
            f"覆盖度 {coverage_score:.1f}。每个样本平均警报 {warning_density:.2f} 个。"
        ),
    }


def build_dimension_profiles(rows: list) -> list[dict[str, Any]]:
    """Build dimension coverage profiles."""
    from collections import Counter

    total = len(rows)
    if total <= 0:
        return []

    counters: dict[str, Counter[str]] = {}
    coverage_counts: Counter[str] = Counter()
    for item in rows:
        dimensions = dict(item.extracted_dimensions or {})
        for key, value in dimensions.items():
            if not value:
                continue
            coverage_counts[key] += 1
            counters.setdefault(key, Counter())[value] += 1

    dimension_labels = {
        'blade_material': 'Blade Material',
        'product_material': 'Material',
        'color': 'Color',
        'size': 'Size',
    }

    profiles: list[dict[str, Any]] = []
    for key, count in coverage_counts.items():
        value_counter = counters.get(key, Counter())
        profiles.append(
            {
                'key': key,
                'label': dimension_labels.get(key, key.replace('_', ' ').title()),
                'coverage': round((count / total), 6),
                'distinct_count': len(value_counter),
                'top_values': [
                    {
                        'value': value,
                        'count': int(value_count),
                        'share': round((value_count / max(1, count)), 6),
                    }
                    for value, value_count in value_counter.most_common(10)
                ],
            }
        )
    profiles.sort(key=lambda entry: (entry['coverage'], entry['distinct_count']), reverse=True)
    return profiles