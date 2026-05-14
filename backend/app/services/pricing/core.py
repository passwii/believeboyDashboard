from __future__ import annotations

from decimal import Decimal

from app.services.pricing.constants import PRICE_BANDS, TIER_LABELS


def _resolve_price_band(sale_price_usd: Decimal) -> tuple[str, str]:
    if sale_price_usd < Decimal("10"):
        return PRICE_BANDS[0]
    if sale_price_usd <= Decimal("50"):
        return PRICE_BANDS[1]
    return PRICE_BANDS[2]


def _resolve_size_tier(
    *,
    longest_side_in: Decimal,
    middle_side_in: Decimal,
    shortest_side_in: Decimal,
    length_plus_girth_in: Decimal,
    product_weight_lb: Decimal,
    dimensional_weight_lb: Decimal,
) -> tuple[str, str, Decimal]:
    if (
        longest_side_in <= Decimal("15")
        and middle_side_in <= Decimal("12")
        and shortest_side_in <= Decimal("0.75")
        and product_weight_lb <= Decimal("1")
    ):
        return "small_standard", "商品重量", product_weight_lb

    large_standard_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("18")
        and middle_side_in <= Decimal("14")
        and shortest_side_in <= Decimal("8")
        and large_standard_weight <= Decimal("20")
    ):
        return "large_standard", "商品重量与体积重量取大值", large_standard_weight

    small_oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("37")
        and middle_side_in <= Decimal("28")
        and shortest_side_in <= Decimal("20")
        and length_plus_girth_in <= Decimal("130")
        and small_oversize_weight <= Decimal("50")
    ):
        return "small_oversize", "商品重量与体积重量取大值", small_oversize_weight

    large_oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if (
        longest_side_in <= Decimal("59")
        and middle_side_in <= Decimal("33")
        and shortest_side_in <= Decimal("33")
        and length_plus_girth_in <= Decimal("130")
        and large_oversize_weight <= Decimal("50")
    ):
        return "large_oversize", "商品重量与体积重量取大值", large_oversize_weight

    if product_weight_lb > Decimal("150"):
        return "oversize_150_plus", "商品重量", product_weight_lb

    oversize_weight = max(product_weight_lb, dimensional_weight_lb)
    if oversize_weight <= Decimal("50"):
        return "oversize_0_50", "商品重量与体积重量取大值", oversize_weight
    if oversize_weight <= Decimal("70"):
        return "oversize_50_70", "商品重量与体积重量取大值", oversize_weight
    return "oversize_70_150", "商品重量与体积重量取大值", oversize_weight
