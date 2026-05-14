"""Product detail analytics for category research.

Handles price band analysis, dimension-based analysis, and related calculations.
"""

from __future__ import annotations

from typing import Any


# --- Constants ---

_PRICE_BAND_PRESETS: dict[str, list[float]] = {
    'default': [50.0, 100.0, 150.0],
    'value': [30.0, 60.0, 100.0, 150.0],
    'premium': [100.0, 150.0, 200.0, 300.0],
}


# --- Price Band Functions ---

def nice_price_step(raw_step: float) -> float:
    """Round price step to nice number (1/2/2.5/5/10 × 10^k)."""
    import math
    if raw_step <= 0:
        return 1.0
    magnitude = math.pow(10, math.floor(math.log10(raw_step)))
    normalized = raw_step / magnitude
    if normalized < 1.5:
        result = 1.0
    elif normalized < 3.5:
        result = 2.0
    elif normalized < 7.5:
        result = 5.0
    else:
        result = 10.0
    return result * magnitude


def auto_price_breaks(prices: list[float], *, max_breaks: int = 8) -> list[float]:
    """Generate price breaks using Freedman-Diaconis style algorithm."""
    import math
    if len(prices) < 3:
        return []

    sorted_prices = sorted(prices)
    n = len(sorted_prices)
    q1_idx = n // 4
    q3_idx = (3 * n) // 4
    q1 = sorted_prices[q1_idx]
    q3 = sorted_prices[q3_idx]
    iqr = q3 - q1

    if iqr > 0:
        fd_width = 2 * iqr / math.pow(n, 1 / 3)
    else:
        fd_width = (sorted_prices[-1] - sorted_prices[0]) / math.pow(n, 1 / 3)

    full_range = sorted_prices[-1] - sorted_prices[0]
    target_width = max(fd_width, full_range / max_breaks) if max_breaks > 0 else fd_width

    if target_width <= 0:
        return []

    nice_step = nice_price_step(target_width)
    breaks = []
    current = math.ceil(sorted_prices[0] / nice_step) * nice_step
    while current < sorted_prices[-1] and len(breaks) < max_breaks:
        if current > sorted_prices[0]:
            breaks.append(current)
        current += nice_step

    return breaks


def parse_price_breaks_text(breaks_text: str) -> list[float]:
    """Parse price breaks from comma-separated text."""
    result: list[float] = []
    for part in breaks_text.split(','):
        part = part.strip()
        if not part:
            continue
        try:
            value = float(part.replace('$', '').replace(',', ''))
            if value > 0 and value not in result:
                result.append(value)
        except ValueError:
            continue
    return sorted(result)


def resolve_price_band(price_usd: float, *, spec: dict[str, Any]) -> str:
    """Resolve price band label for given price."""
    bands = spec['bands']
    for band in bands:
        lower = float(band['lower'])
        upper = float(band['upper']) if band['upper'] is not None else None
        if upper is None:
            if price_usd >= lower:
                return str(band['label'])
        elif lower <= price_usd < upper:
            return str(band['label'])
    return str(bands[-1]['label'])


# --- Dimension Analysis ---

def build_dimension_price_band_analysis(
    rows: list,
    *,
    spec: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build dimension-price-band cross analysis."""
    from collections import defaultdict

    dimension_band_counter: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    dimension_totals: dict[str, int] = defaultdict(int)

    for item in rows:
        if item.price_usd is None:
            continue
        price_label = resolve_price_band(float(item.price_usd), spec=spec)
        dimensions = dict(item.extracted_dimensions or {})
        for key, value in dimensions.items():
            if value:
                dimension_band_counter[key][f'{value}||{price_label}'] += 1
                dimension_totals[key] += 1

    result: list[dict[str, Any]] = []
    for dim_key, band_counts in dimension_band_counter.items():
        top_values: list[dict[str, Any]] = []
        for key, count in sorted(band_counts.items(), key=lambda x: x[1], reverse=True)[:10]:
            value, band_label = key.split('||')
            top_values.append({
                'value': value,
                'price_band': band_label,
                'count': count,
            })
        result.append({
            'dimension_key': dim_key,
            'total_samples': dimension_totals[dim_key],
            'top_combinations': top_values,
        })

    return result


def build_brand_price_band_analysis(
    rows: list,
    *,
    spec: dict[str, Any],
) -> list[dict[str, Any]]:
    """Build brand-price-band cross analysis."""
    from collections import defaultdict

    brand_band_sales: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    brand_totals: dict[str, int] = defaultdict(int)

    for item in rows:
        if item.price_usd is None:
            continue
        price_label = resolve_price_band(float(item.price_usd), spec=spec)
        brand = (item.brand or 'Unknown').strip() or 'Unknown'
        brand_band_sales[brand][price_label] += int(item.monthly_sales or 0)
        brand_totals[brand] += int(item.monthly_sales or 0)

    result: list[dict[str, Any]] = []
    for brand, band_sales in sorted(brand_band_sales.items(), key=lambda x: x[1].get('总计', 0), reverse=True)[:20]:
        total_sales = brand_totals[brand]
        price_bands: list[dict[str, Any]] = []
        for band in spec['bands']:
            label = str(band['label'])
            sales = band_sales.get(label, 0)
            price_bands.append({
                'band': label,
                'sales': sales,
                'share': round(sales / max(1, total_sales), 6),
            })
        result.append({
            'brand': brand,
            'total_sales': total_sales,
            'price_bands': price_bands,
        })

    return result
