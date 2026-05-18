from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.services.pricing.constants import (
    CM_PER_INCH,
    CUBIC_IN_PER_CUBIC_FT,
    DIM_DIVISOR,
    KG_PER_LB,
    METRIC_QUANT,
    MONEY_QUANT,
    OZ_PER_LB,
    PRICE_BANDS,
    RATE_QUANT,
    RETURN_COMMISSION_RELIEF_RATE,
    TIER_LABELS,
    VOLUME_FT_QUANT,
)
from app.services.pricing.inbound import _resolve_exchange_rate_to_rmb, _resolve_first_leg_cost_rmb
from app.services.pricing.utils import (
    _decimal,
    _money,
    _money_decimal,
    _quantize,
    _ratio,
    _ratio_decimal,
)
from app.services.pricing.core import _resolve_price_band, _resolve_size_tier


def _compute_fbm_pricing(
    payload: object, db: Session
) -> dict[str, object]:
    length_cm = _decimal(getattr(payload, "package_length_cm", 0))
    width_cm = _decimal(getattr(payload, "package_width_cm", 0))
    height_cm = _decimal(getattr(payload, "package_height_cm", 0))
    weight_kg = _decimal(getattr(payload, "weight_kg", 0))
    sale_price_usd = _money(getattr(payload, "sale_price_usd", 0))
    fob_product_cost_rmb = _money(getattr(payload, "fob_product_cost_rmb", 0))
    full_container_quantity = _money(getattr(payload, "full_container_quantity", 0))
    full_container_price_rmb = _money(getattr(payload, "full_container_price_rmb", 0))

    first_leg_cost_rmb, _ = _resolve_first_leg_cost_rmb(payload, db)
    commission_rate = _ratio(_decimal(getattr(payload, "commission_rate", 0.15)))
    advertising_rate = _ratio(_decimal(getattr(payload, "advertising_rate", 0)))
    return_loss_rate = _ratio(_decimal(getattr(payload, "return_loss_rate", 0)))
    storage_months = _quantize(_decimal(getattr(payload, "storage_months", 1)), MONEY_QUANT)
    delivery_fee_usd = _money(getattr(payload, "delivery_fee_usd", 0))

    usd_to_rmb_rate, rate_source = _resolve_exchange_rate_to_rmb(
        db,
        manual_rate=getattr(payload, "usd_to_rmb_rate", None),
        currency="USD",
    )

    sides_in = sorted(
        [length_cm / CM_PER_INCH, width_cm / CM_PER_INCH, height_cm / CM_PER_INCH],
        reverse=True,
    )
    longest_side_in, middle_side_in, shortest_side_in = sides_in
    length_plus_girth_in = longest_side_in + (middle_side_in + shortest_side_in) * 2
    volume_cubic_in = longest_side_in * middle_side_in * shortest_side_in
    volume_cubic_ft = volume_cubic_in / CUBIC_IN_PER_CUBIC_FT
    product_weight_lb = weight_kg / KG_PER_LB
    product_weight_oz = product_weight_lb * OZ_PER_LB
    dimensional_weight_lb = volume_cubic_in / DIM_DIVISOR

    size_tier, size_rule, chargeable_weight_lb = _resolve_size_tier(
        longest_side_in=longest_side_in,
        middle_side_in=middle_side_in,
        shortest_side_in=shortest_side_in,
        length_plus_girth_in=length_plus_girth_in,
        product_weight_lb=product_weight_lb,
        dimensional_weight_lb= dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd * commission_rate * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)

    full_container_fee = (
        _money_decimal(full_container_price_rmb / full_container_quantity)
        if full_container_quantity > 0
        else Decimal("0")
    )
    total_fee_usd = _money_decimal(
        referral_fee_usd + advertising_fee_usd + return_loss_usd + delivery_fee_usd
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd) if sale_price_usd > 0 else Decimal("0")
    )

    warnings: list[str] = []
    vat_rate_map: dict[str, Decimal] = {"DE": Decimal("0.19"), "UK": Decimal("0.20")}
    country_upper = (getattr(payload, "country", "") or "").upper()
    vat_rate = vat_rate_map.get(country_upper)
    vat_usd = Decimal("0")
    profit_after_vat_usd_dec: Decimal | None = None
    profit_after_vat_rate_dec: Decimal | None = None
    if vat_rate is not None:
        vat_usd = _money_decimal(sale_price_usd * vat_rate / (Decimal("1") + vat_rate))
        profit_after_vat = payout_usd - vat_usd - ddp_cost_usd
        profit_after_vat_usd_dec = _money_decimal(profit_after_vat)
        profit_after_vat_rate_dec = (
            _ratio_decimal(profit_after_vat_usd_dec / sale_price_usd)
            if sale_price_usd > 0
            else Decimal("0")
        )

    inbound_placement_mode = getattr(payload, "inbound_placement_mode", "single_destination")

    return {
        "inputs": {
            "package_length_cm": _quantize(length_cm, METRIC_QUANT),
            "package_width_cm": _quantize(width_cm, METRIC_QUANT),
            "package_height_cm": _quantize(height_cm, METRIC_QUANT),
            "weight_kg": _quantize(weight_kg, METRIC_QUANT),
            "fob_product_cost_rmb": fob_product_cost_rmb,
            "first_leg_cost_rmb": first_leg_cost_rmb,
            "sale_price_usd": sale_price_usd,
            "commission_rate": commission_rate,
            "advertising_rate": advertising_rate,
            "return_loss_rate": return_loss_rate,
            "storage_months": storage_months,
            "inbound_placement_mode": inbound_placement_mode,
        },
        "size_tier": size_tier,
        "size_tier_label": TIER_LABELS[size_tier],
        "price_band": price_band,
        "price_band_label": price_band_label,
        "usd_to_rmb_rate": _quantize(usd_to_rmb_rate, RATE_QUANT),
        "usd_to_rmb_rate_source": rate_source,
        "dimensions_decimal": {
            "longest_side_in": _quantize(longest_side_in, METRIC_QUANT),
            "middle_side_in": _quantize(middle_side_in, METRIC_QUANT),
            "shortest_side_in": _quantize(shortest_side_in, METRIC_QUANT),
            "length_plus_girth_in": _quantize(length_plus_girth_in, METRIC_QUANT),
            "volume_cubic_in": _quantize(volume_cubic_in, METRIC_QUANT),
            "volume_cubic_ft": _quantize(volume_cubic_ft, VOLUME_FT_QUANT),
        },
        "weights_decimal": {
            "product_weight_lb": _quantize(product_weight_lb, METRIC_QUANT),
            "product_weight_oz": _quantize(product_weight_oz, METRIC_QUANT),
            "dimensional_weight_lb": _quantize(dimensional_weight_lb, METRIC_QUANT),
            "chargeable_weight_lb": _quantize(chargeable_weight_lb, METRIC_QUANT),
            "chargeable_weight_oz": _quantize(chargeable_weight_oz, METRIC_QUANT),
        },
        "weights": {
            "chargeable_weight_rule": size_rule,
        },
        "fulfillment_fee_rule_label": "FBM / 无FBA履约费",
        "inbound_config_fee_rule_label": "FBM / 无入库配置费",
        "storage_fee_rule_label": "FBM / 无仓储费",
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "delivery_fee_usd": delivery_fee_usd,
            "fba_fulfillment_fee_usd": Decimal("0"),
            "inbound_config_fee_usd": Decimal("0"),
            "storage_fee_usd": Decimal("0"),
            "total_fee_usd": total_fee_usd,
            "full_container_fee_rmb": full_container_fee,
        },
        "profit_decimal": {
            "ddp_cost_rmb": ddp_cost_rmb,
            "ddp_cost_usd": ddp_cost_usd,
            "payout_usd": payout_usd,
            "profit_usd": profit_usd,
            "profit_rate": profit_rate,
            "vat_usd": vat_usd,
            "profit_after_vat_usd": profit_after_vat_usd_dec,
            "profit_after_vat_rate": profit_after_vat_rate_dec,
        },
        "commission_rate": commission_rate,
        "warnings": warnings,
    }
