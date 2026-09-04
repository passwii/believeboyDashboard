"""Market concentration and monopoly metrics."""

from __future__ import annotations

from typing import Any


# --- Concentration & Monopoly ---


def build_market_concentration(
    brand_counter: dict[str, int],
    total_brand_sales: int,
) -> dict[str, float]:
    """Calculate market concentration metrics (CR1/CR3/CR5/CR10, HHI)."""
    if total_brand_sales <= 0:
        return {'cr1': 0.0, 'cr3': 0.0, 'cr5': 0.0, 'cr10': 0.0, 'hhi': 0.0}

    sorted_sales = sorted(brand_counter.values(), reverse=True)
    shares = [value / total_brand_sales for value in sorted_sales]

    return {
        'cr1': round(float(sum(shares[:1])), 6),
        'cr3': round(float(sum(shares[:3])), 6),
        'cr5': round(float(sum(shares[:5])), 6),
        'cr10': round(float(sum(shares[:10])), 6),
        'hhi': round(float(sum((share * 100) ** 2 for share in shares)), 2),
    }


def risk_level_by_concentration(*, cr3: float, hhi: float) -> str:
    """Determine risk level from concentration metrics."""
    if cr3 >= 0.7 or hhi >= 2500:
        return 'high'
    if cr3 >= 0.45 or hhi >= 1500:
        return 'medium'
    return 'low'


def _aggregate_sales_share_pairs(
    pairs: list[tuple[str, int]],
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Aggregate sales-share pairs and return top N."""
    if not pairs:
        return []
    total_sales = sum(max(0, int(sales)) for _, sales in pairs)
    if total_sales <= 0:
        total_sales = 1
    sorted_pairs = sorted(pairs, key=lambda item: item[1], reverse=True)
    return [
        {
            'name': name,
            'monthly_sales': int(sales),
            'share': round(float(sales) / float(total_sales), 6),
        }
        for name, sales in sorted_pairs[:limit]
    ]


def build_brand_monopoly(
    brand_counter: dict[str, int],
    total_brand_sales: int,
) -> dict[str, Any]:
    """Calculate brand monopoly metrics."""
    concentration = build_market_concentration(brand_counter, total_brand_sales)
    risk_level = risk_level_by_concentration(
        cr3=float(concentration['cr3']),
        hhi=float(concentration['hhi']),
    )
    return {
        'brand_cr3': concentration['cr3'],
        'brand_cr5': concentration['cr5'],
        'brand_cr10': concentration['cr10'],
        'brand_hhi': concentration['hhi'],
        'risk_level': risk_level,
    }


def build_seller_monopoly(rows: list) -> dict[str, Any]:
    """Calculate seller monopoly metrics."""
    seller_counter: dict[str, int] = {}
    total_sales = 0
    amazon_sales = 0
    for item in rows:
        seller = (item.seller or 'Unknown').strip() or 'Unknown'
        sales = int(item.monthly_sales or 0)
        total_sales += sales
        seller_counter[seller] = seller_counter.get(seller, 0) + sales
        if item.is_amazon:
            amazon_sales += sales

    concentration = build_market_concentration(seller_counter, total_sales)
    top_sellers = _aggregate_sales_share_pairs(list(seller_counter.items()), limit=10)
    risk_level = risk_level_by_concentration(
        cr3=float(concentration['cr3']),
        hhi=float(concentration['hhi']),
    )
    return {
        'seller_count': len(seller_counter),
        'seller_cr1': concentration['cr1'],
        'seller_cr3': concentration['cr3'],
        'seller_cr5': concentration['cr5'],
        'seller_cr10': concentration['cr10'],
        'seller_hhi': concentration['hhi'],
        'amazon_seller_sales_share': round((amazon_sales / max(1, total_sales)), 6),
        'risk_level': risk_level,
        'top_sellers': [
            {
                'seller': entry['name'],
                'monthly_sales': entry['monthly_sales'],
                'share': entry['share'],
            }
            for entry in top_sellers
        ],
    }


def build_product_monopoly(rows: list) -> dict[str, Any]:
    """Calculate product (ASIN) monopoly metrics."""
    asin_counter: dict[str, int] = {}
    for item in rows:
        asin = (item.asin or '').strip().upper()
        if not asin:
            continue
        asin_counter[asin] = asin_counter.get(asin, 0) + int(item.monthly_sales or 0)

    total_sales = sum(asin_counter.values())
    sorted_sales = sorted(asin_counter.items(), key=lambda pair: pair[1], reverse=True)
    top100_sales = sum(max(0, int(sales)) for _, sales in sorted_sales[:100])
    top1_sales = int(sorted_sales[0][1]) if sorted_sales else 0
    top_summaries = _aggregate_sales_share_pairs(sorted_sales, limit=10)

    asin_top1_share = round((top1_sales / max(1, total_sales)), 6)
    asin_top3_share = round((sum(int(sales) for _, sales in sorted_sales[:3]) / max(1, total_sales)), 6)
    asin_top10_share = round((sum(int(sales) for _, sales in sorted_sales[:10]) / max(1, total_sales)), 6)
    top1_to_top100_ratio = round((top1_sales / max(1, top100_sales)), 6)

    if asin_top1_share >= 0.35 or asin_top3_share >= 0.65 or top1_to_top100_ratio >= 0.2:
        risk_level = 'high'
    elif asin_top1_share >= 0.2 or asin_top3_share >= 0.45 or top1_to_top100_ratio >= 0.12:
        risk_level = 'medium'
    else:
        risk_level = 'low'

    return {
        'asin_top1_share': asin_top1_share,
        'asin_top3_share': asin_top3_share,
        'asin_top10_share': asin_top10_share,
        'top1_to_top100_ratio': top1_to_top100_ratio,
        'risk_level': risk_level,
        'top_asins': [
            {
                'asin': entry['name'],
                'monthly_sales': entry['monthly_sales'],
                'share': entry['share'],
            }
            for entry in top_summaries
        ],
    }