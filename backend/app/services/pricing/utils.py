from __future__ import annotations

import math
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from app.services.pricing.constants import MONEY_QUANT


def _decimal(value: object) -> Decimal:
    return Decimal(str(value))


def _money(value: object) -> Decimal:
    return _money_decimal(_decimal(value))


def _money_decimal(value: Decimal) -> Decimal:
    return _quantize(value, MONEY_QUANT)


def _ratio(value: Decimal) -> Decimal:
    return _quantize(value, Decimal("0.000001"))


def _ratio_decimal(value: Decimal) -> Decimal:
    return _quantize(value, Decimal("0.0001"))


def _quantize(value: Decimal, precision: Decimal) -> Decimal:
    return value.quantize(precision, rounding=ROUND_HALF_UP)


def _ceil_positive(value: Decimal) -> int:
    if value <= 0:
        return 0
    return int(math.ceil(float(value)))


def _to_iso(value: datetime | None) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return ""
