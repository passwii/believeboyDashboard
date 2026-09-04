from __future__ import annotations

from decimal import Decimal

from sqlalchemy.orm import Session

from app.services.pricing.constants import (
    CM_PER_INCH,
    CUBIC_IN_PER_CUBIC_FT,
    DIM_DIVISOR,
    KG_PER_LB,
    METRIC_QUANT,
    OZ_PER_LB,
    RATE_QUANT,
    RETURN_COMMISSION_RELIEF_RATE,
    TIER_LABELS,
    VAT_RATE_MAP,
    VOLUME_FT_QUANT,
)
from app.services.pricing.core import _resolve_price_band, _resolve_size_tier
from app.services.pricing.fees import (
    _resolve_fba_fee,
    _resolve_inbound_config_fee,
    _resolve_storage_fee,
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


def _compute_pricing(
    payload: object, db: Session
) -> dict[str, object]:
    length_cm = _decimal(getattr(payload, "package_length_cm", 0))
    width_cm = _decimal(getattr(payload, "package_width_cm", 0))
    height_cm = _decimal(getattr(payload, "package_height_cm", 0))
    weight_kg = _decimal(getattr(payload, "weight_kg", 0))
    sale_price_usd = _money(getattr(payload, "sale_price_usd", 0))
    fob_product_cost_rmb = _money(getattr(payload, "fob_product_cost_rmb", 0))
    first_leg_cost_rmb, shipping_cost_warning = _resolve_first_leg_cost_rmb(payload, db)
    commission_rate = _ratio(_decimal(getattr(payload, "commission_rate", 0.15)))
    advertising_rate = _ratio(_decimal(getattr(payload, "advertising_rate", 0)))
    return_loss_rate = _ratio(_decimal(getattr(payload, "return_loss_rate", 0)))
    storage_months = _quantize(_decimal(getattr(payload, "storage_months", 1)), Decimal("0.01"))

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
        dimensional_weight_lb=dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)
    fulfillment_fee_usd, fulfillment_rule = _resolve_fba_fee(
        size_tier, chargeable_weight_lb, chargeable_weight_oz, price_band
    )
    inbound_fee_usd, inbound_rule, inbound_warnings = _resolve_inbound_config_fee(
        size_tier=size_tier,
        chargeable_weight_lb=chargeable_weight_lb,
        chargeable_weight_oz=chargeable_weight_oz,
        inbound_placement_mode=getattr(payload, "inbound_placement_mode", "single_destination"),
    )
    storage_fee_usd, storage_rule = _resolve_storage_fee(
        size_tier=size_tier,
        volume_cubic_ft=volume_cubic_ft,
        storage_months=storage_months,
    )

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd
        * commission_rate
        * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)
    total_fee_usd = _money_decimal(
        referral_fee_usd
        + advertising_fee_usd
        + return_loss_usd
        + fulfillment_fee_usd
        + inbound_fee_usd
        + storage_fee_usd
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd)
        if sale_price_usd > 0
        else Decimal("0")
    )

    country_upper = (getattr(payload, "country", "") or "").upper()
    vat_rate = VAT_RATE_MAP.get(country_upper)
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

    warnings = list(inbound_warnings)
    if shipping_cost_warning:
        warnings.append(shipping_cost_warning)

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
            "inbound_placement_mode": getattr(payload, "inbound_placement_mode", "single_destination"),
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
        "fulfillment_fee_rule_label": fulfillment_rule,
        "inbound_config_fee_rule_label": inbound_rule,
        "storage_fee_rule_label": storage_rule,
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "fba_fulfillment_fee_usd": fulfillment_fee_usd,
            "inbound_config_fee_usd": inbound_fee_usd,
            "storage_fee_usd": storage_fee_usd,
            "total_fee_usd": total_fee_usd,
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


def _compute_eu_pricing(
    payload: object, db: Session
) -> dict[str, object]:
    length_cm = _decimal(getattr(payload, "package_length_cm", 0))
    width_cm = _decimal(getattr(payload, "package_width_cm", 0))
    height_cm = _decimal(getattr(payload, "package_height_cm", 0))
    weight_kg = _decimal(getattr(payload, "weight_kg", 0))
    sale_price_usd = _money(getattr(payload, "sale_price_usd", 0))
    fob_product_cost_rmb = _money(getattr(payload, "fob_product_cost_rmb", 0))
    first_leg_cost_rmb = _money(getattr(payload, "first_leg_cost_rmb", 0))
    commission_rate = _ratio(_decimal(getattr(payload, "commission_rate", 0.15)))
    advertising_rate = _ratio(_decimal(getattr(payload, "advertising_rate", 0)))
    return_loss_rate = _ratio(_decimal(getattr(payload, "return_loss_rate", 0)))
    delivery_fee_usd = _money(getattr(payload, "delivery_fee_usd", 0))
    inbound_config_fee_manual = _money(getattr(payload, "inbound_config_fee_usd", 0))
    storage_fee_manual = _money(getattr(payload, "storage_fee_usd", 0))

    currency_by_country = {"DE": "EUR", "UK": "GBP"}
    target_currency = currency_by_country.get((getattr(payload, "country", "") or "").upper())
    if target_currency is None:
        raise ValueError(f"不支持的欧洲站点国家: {getattr(payload, 'country', '')}")

    usd_to_rmb_rate, rate_source = _resolve_exchange_rate_to_rmb(
        db,
        manual_rate=getattr(payload, "usd_to_rmb_rate", None),
        currency=target_currency,
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
        dimensional_weight_lb=dimensional_weight_lb,
    )
    chargeable_weight_oz = chargeable_weight_lb * OZ_PER_LB
    price_band, price_band_label = _resolve_price_band(sale_price_usd)

    ddp_cost_rmb = _money_decimal(fob_product_cost_rmb + first_leg_cost_rmb)
    ddp_cost_usd = _money_decimal(ddp_cost_rmb / usd_to_rmb_rate)
    referral_fee_usd = _money_decimal(
        sale_price_usd
        * commission_rate
        * (Decimal("1") - (return_loss_rate * RETURN_COMMISSION_RELIEF_RATE))
    )
    advertising_fee_usd = _money_decimal(sale_price_usd * advertising_rate)
    return_loss_usd = _money_decimal(sale_price_usd * return_loss_rate)
    total_fee_usd = _money_decimal(
        referral_fee_usd
        + advertising_fee_usd
        + return_loss_usd
        + delivery_fee_usd
        + inbound_config_fee_manual
        + storage_fee_manual
    )
    payout_usd = _money_decimal(sale_price_usd - total_fee_usd)
    profit_usd = _money_decimal(payout_usd - ddp_cost_usd)
    profit_rate = (
        _ratio_decimal(profit_usd / sale_price_usd)
        if sale_price_usd > 0
        else Decimal("0")
    )

    country_upper = (getattr(payload, "country", "") or "").upper()
    vat_rate = VAT_RATE_MAP.get(country_upper)
    vat_usd = Decimal("0")
    profit_after_vat_usd_dec: Decimal | None = None
    profit_after_vat_rate_dec: Decimal | None = None
    vat_rate_label = ""
    if vat_rate is not None:
        vat_usd = _money_decimal(sale_price_usd * vat_rate / (Decimal("1") + vat_rate))
        profit_after_vat = payout_usd - vat_usd - ddp_cost_usd
        profit_after_vat_usd_dec = _money_decimal(profit_after_vat)
        profit_after_vat_rate_dec = (
            _ratio_decimal(profit_after_vat_usd_dec / sale_price_usd)
            if sale_price_usd > 0
            else Decimal("0")
        )
        vat_rate_label = f"{country_upper} VAT {int(vat_rate * 100)}%"

    warnings: list[str] = []
    if vat_rate_label:
        warnings.append(f"含{vat_rate_label}")

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
            "storage_months": Decimal("1"),
            "inbound_placement_mode": "single_destination",
            "delivery_fee_usd": delivery_fee_usd,
            "inbound_config_fee_manual_usd": inbound_config_fee_manual,
            "storage_fee_manual_usd": storage_fee_manual,
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
        "fulfillment_fee_rule_label": "手动填写",
        "inbound_config_fee_rule_label": "手动填写",
        "storage_fee_rule_label": "手动填写",
        "fees_decimal": {
            "referral_fee_usd": referral_fee_usd,
            "advertising_fee_usd": advertising_fee_usd,
            "return_loss_usd": return_loss_usd,
            "fba_fulfillment_fee_usd": delivery_fee_usd,
            "inbound_config_fee_usd": inbound_config_fee_manual,
            "storage_fee_usd": storage_fee_manual,
            "total_fee_usd": total_fee_usd,
            "platform_fee_usd": referral_fee_usd,
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
