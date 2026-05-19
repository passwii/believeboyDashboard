"""金额、比率等数学计算工具。

本模块提供统一的小数精度处理函数，供所有 service 层使用。
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any

# ─── 常量 ────────────────────────────────────────────────────────────────────

DECIMAL_ZERO = Decimal("0")
TWO_DP = Decimal("0.01")
FOUR_DP = Decimal("0.0001")

# ─── 极值函数 ────────────────────────────────────────────────────────────────


def max(a: Decimal | Any, b: Decimal | Any) -> Decimal:
    """比较两个值，返回较大者（支持 Decimal 和 None）。"""
    if not isinstance(a, Decimal):
        a = Decimal(str(a)) if a is not None else DECIMAL_ZERO
    if not isinstance(b, Decimal):
        b = Decimal(str(b)) if b is not None else DECIMAL_ZERO
    return a if a >= b else b


def min(a: Decimal | Any, b: Decimal | Any) -> Decimal:
    """比较两个值，返回较小者（支持 Decimal 和 None）。"""
    if not isinstance(a, Decimal):
        a = Decimal(str(a)) if a is not None else DECIMAL_ZERO
    if not isinstance(b, Decimal):
        b = Decimal(str(b)) if b is not None else DECIMAL_ZERO
    return a if a <= b else b


# ─── 金额计算 ────────────────────────────────────────────────────────────────


def round_money(value: Decimal | Any) -> float:
    """四舍五入到分 (2位小数)。"""
    if value is None:
        return 0.0
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return float(value.quantize(TWO_DP, rounding=ROUND_HALF_UP))


def round_ratio(value: Decimal | Any) -> float:
    """四舍五入到万分位 (4位小数)。"""
    if value is None:
        return 0.0
    if not isinstance(value, Decimal):
        value = Decimal(str(value))
    return float(value.quantize(FOUR_DP, rounding=ROUND_HALF_UP))


def safe_ratio(numerator: Decimal | Any, denominator: Decimal | int | Any) -> Decimal:
    """安全除法，分母 <= 0 时返回 0。"""
    if not isinstance(numerator, Decimal):
        numerator = Decimal(str(numerator)) if numerator is not None else DECIMAL_ZERO
    if not isinstance(denominator, Decimal):
        if isinstance(denominator, int):
            if denominator <= 0:
                return DECIMAL_ZERO
        else:
            try:
                denominator = Decimal(str(denominator))
            except (InvalidOperation, ValueError):
                return DECIMAL_ZERO
    if isinstance(denominator, Decimal) and denominator <= 0:
        return DECIMAL_ZERO
    return numerator / denominator


def decimal_to_float(value: Decimal | None, digits: int = 2) -> float | None:
    """Decimal 转 float，保留指定小数位。"""
    if value is None:
        return None
    quant = Decimal("1").scaleb(-digits)
    return float(value.quantize(quant, rounding=ROUND_HALF_UP))


def to_float(value: Any) -> float:
    """Convert any value to float, returning 0.0 for None/unparseable values."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def safe_div(numerator: float, denominator: float) -> float:
    """Safe division returning 0.0 when denominator is zero."""
    if denominator == 0:
        return 0.0
    return numerator / denominator


def int_to_decimal(value: int | None) -> Decimal:
    """int/None 转 Decimal。"""
    if value is None:
        return DECIMAL_ZERO
    return Decimal(value)


def round_decimal(value: Decimal, digits: int = 4) -> Decimal:
    """ Decimal 保留指定位数。"""
    quant = Decimal("1").scaleb(-digits)
    return value.quantize(quant, rounding=ROUND_HALF_UP)


def round_decimal_to_int(value: Decimal) -> int:
    """ Decimal 四舍五入到整数。"""
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))