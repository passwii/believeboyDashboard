from __future__ import annotations

from decimal import Decimal

from app.services.pricing.constants import (
    LARGE_OVERSIZE_INBOUND_FEES,
    LARGE_STANDARD_FIXED_FEES,
    LARGE_STANDARD_INBOUND_FEES,
    OVERSIZE_STORAGE_RATE,
    SMALL_OVERSIZE_INBOUND_FEES,
    SMALL_STANDARD_FEES,
    SMALL_STANDARD_INBOUND_FEES,
    STANDARD_STORAGE_RATE,
    TIER_LABELS,
)
from app.services.pricing.utils import (
    _ceil_positive,
    _money_decimal,
)


def _resolve_fba_fee(
    size_tier: str,
    chargeable_weight_lb: Decimal,
    chargeable_weight_oz: Decimal,
    price_band: str,
) -> tuple[Decimal, str]:
    price_band_index = {"lt_10": 0, "between_10_50": 1, "gt_50": 2}[price_band]

    if size_tier == "small_standard":
        for upper_oz, fees, label in SMALL_STANDARD_FEES:
            if chargeable_weight_oz <= upper_oz:
                return Decimal(fees[price_band_index]), f"{TIER_LABELS[size_tier]} / {label}"

    if size_tier == "large_standard":
        for upper_lb, fees, label in LARGE_STANDARD_FIXED_FEES:
            if chargeable_weight_lb <= upper_lb:
                return Decimal(fees[price_band_index]), f"{TIER_LABELS[size_tier]} / {label}"
        base_fee = Decimal(("6.15", "6.97", "7.23")[price_band_index])
        increments = _ceil_positive((chargeable_weight_oz - Decimal("48")) / Decimal("4"))
        return _money_decimal(base_fee + Decimal(increments) * Decimal("0.08")), f"{TIER_LABELS[size_tier]} / 3 至 20 磅"

    if size_tier == "small_oversize":
        return _tier_fee_with_first_pound(
            base=Decimal(("6.78", "7.55", "7.55")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "large_oversize":
        return _tier_fee_with_first_pound(
            base=Decimal(("8.58", "9.35", "9.35")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_0_50":
        return _tier_fee_with_first_pound(
            base=Decimal(("25.56", "26.33", "26.33")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            increment=Decimal("0.38"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_50_70":
        return _tier_fee_with_threshold(
            base=Decimal(("36.55", "37.32", "37.32")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            threshold_lb=Decimal("51"),
            increment=Decimal("0.75"),
            tier_label=TIER_LABELS[size_tier],
        )

    if size_tier == "oversize_70_150":
        return _tier_fee_with_threshold(
            base=Decimal(("50.55", "51.32", "51.32")[price_band_index]),
            chargeable_weight_lb=chargeable_weight_lb,
            threshold_lb=Decimal("71"),
            increment=Decimal("0.75"),
            tier_label=TIER_LABELS[size_tier],
        )

    return _tier_fee_with_threshold(
        base=Decimal(("194.18", "194.95", "194.95")[price_band_index]),
        chargeable_weight_lb=chargeable_weight_lb,
        threshold_lb=Decimal("151"),
        increment=Decimal("0.19"),
        tier_label=TIER_LABELS["oversize_150_plus"],
    )


def _resolve_inbound_config_fee(
    *,
    size_tier: str,
    chargeable_weight_lb: Decimal,
    chargeable_weight_oz: Decimal,
    inbound_placement_mode: str,
) -> tuple[Decimal, str, list[str]]:
    if inbound_placement_mode == "amazon_optimized_split":
        return Decimal("0.00"), "亚马逊优化的货件拆分 / 发往五个或更多地点 / 无费用", []

    if size_tier == "small_standard":
        for upper_oz, fee, label in SMALL_STANDARD_INBOUND_FEES:
            if chargeable_weight_oz <= upper_oz:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "large_standard":
        for upper_lb, fee, label in LARGE_STANDARD_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "small_oversize":
        for upper_lb, fee, label in SMALL_OVERSIZE_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    if size_tier == "large_oversize":
        for upper_lb, fee, label in LARGE_OVERSIZE_INBOUND_FEES:
            if chargeable_weight_lb <= upper_lb:
                return fee, f"{TIER_LABELS[size_tier]} / 单点入仓 / {label}", []

    oversize_tiers = {"oversize_0_50", "oversize_50_70", "oversize_70_150", "oversize_150_plus"}
    if size_tier in oversize_tiers:
        return Decimal("0.00"), f"{TIER_LABELS[size_tier]} / 超大件无入库配置费", []

    return (
        Decimal("0.00"),
        f"{TIER_LABELS[size_tier]} / 当前未提供入库配置费规则，暂按 $0 计",
        [f"{TIER_LABELS[size_tier]} 当前未提供入库配置费阶梯，系统暂按 $0 计算。"],
    )


def _resolve_storage_fee(
    *, size_tier: str, volume_cubic_ft: Decimal, storage_months: Decimal
) -> tuple[Decimal, str]:
    is_standard = size_tier in {"small_standard", "large_standard"}
    rate = STANDARD_STORAGE_RATE if is_standard else OVERSIZE_STORAGE_RATE
    fee = _money_decimal(volume_cubic_ft * rate * storage_months)
    label = "标准尺寸 / 非危险品 / 非旺季" if is_standard else "大件商品 / 非危险品 / 非旺季"
    return fee, f"{label} / ${rate} / 立方英尺 / 月"


def _tier_fee_with_first_pound(
    *, base: Decimal, chargeable_weight_lb: Decimal, increment: Decimal, tier_label: str
) -> tuple[Decimal, str]:
    increments = _ceil_positive(chargeable_weight_lb - Decimal("1"))
    return _money_decimal(base + Decimal(increments) * increment), f"{tier_label} / 0 至 50 磅"


def _tier_fee_with_threshold(
    *,
    base: Decimal,
    chargeable_weight_lb: Decimal,
    threshold_lb: Decimal,
    increment: Decimal,
    tier_label: str,
) -> tuple[Decimal, str]:
    increments = _ceil_positive(chargeable_weight_lb - threshold_lb)
    return _money_decimal(base + Decimal(increments) * increment), tier_label
