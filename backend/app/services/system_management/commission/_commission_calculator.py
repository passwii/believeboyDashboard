"""
佣金比例计算逻辑。
"""
from __future__ import annotations

from decimal import Decimal

from app.services.system_management.shared import _normalize_rate_decimal


OPERATOR_BONUS_RATIO_TIERS: tuple[tuple[Decimal, Decimal], ...] = (
    (Decimal("10000"), Decimal("0.12")),
    (Decimal("50000"), Decimal("0.14")),
    (Decimal("150000"), Decimal("0.16")),
    (Decimal("450000"), Decimal("0.18")),
)
ASSISTANT_BONUS_RATIO = Decimal("0.02")


def _resolve_factory_commission(
    commission_basis: str | None,
    configured_commission_rate: Decimal | None,
    income_total_usd: Decimal,
    amazon_pay_back_usd: Decimal,
) -> tuple[Decimal, Decimal, Decimal]:
    """根据 commission_basis 计算工厂佣金比例、基础金额和佣金金额。

    Returns:
        (commission_rate, base_amount_usd, commission_usd)
    """
    from app.utils.math_utils import max as _max, round_money

    normalized_income = _max(income_total_usd, Decimal("0"))
    normalized_payback = _max(amazon_pay_back_usd, Decimal("0"))

    if commission_basis == "cash_received":
        payback_ratio = (
            (normalized_payback / normalized_income)
            if normalized_income > 0
            else Decimal("0")
        )
        if payback_ratio < Decimal("0.4"):
            commission_rate = Decimal("0")
        elif payback_ratio < Decimal("0.5"):
            commission_rate = Decimal("0.07")
        elif payback_ratio < Decimal("0.6"):
            commission_rate = Decimal("0.10")
        elif payback_ratio < Decimal("0.7"):
            commission_rate = Decimal("0.13")
        else:
            commission_rate = Decimal("0.15")
        base_amount_usd = normalized_payback
    else:
        commission_rate = _normalize_rate_decimal(configured_commission_rate)
        base_amount_usd = normalized_income

    commission_usd = round_money(base_amount_usd * commission_rate)
    return commission_rate, base_amount_usd, commission_usd


def _resolve_operator_bonus_ratio(income_total_usd: Decimal) -> Decimal:
    """根据收入金额计算运营人员奖金比例。"""
    normalized_income = max(income_total_usd, Decimal("0"))
    for max_inclusive, ratio in OPERATOR_BONUS_RATIO_TIERS:
        if normalized_income <= max_inclusive:
            return ratio
    return Decimal("0.20")


def _build_default_bonus_ratios(
    *,
    income_total_usd: Decimal,
    operator_names: list[str],
    assistant_names: list[str],
) -> dict[tuple[str, str], Decimal]:
    """构建默认奖金比例映射。"""
    ratio_map: dict[tuple[str, str], Decimal] = {}
    operator_ratio = _resolve_operator_bonus_ratio(income_total_usd)
    assistant_ratio = ASSISTANT_BONUS_RATIO

    if operator_names:
        split_ratio = operator_ratio / Decimal(len(operator_names))
        for person_name in operator_names:
            ratio_map[(person_name, "operator")] = split_ratio

    if assistant_names:
        split_ratio = assistant_ratio / Decimal(len(assistant_names))
        for person_name in assistant_names:
            ratio_map[(person_name, "assistant")] = split_ratio

    return ratio_map