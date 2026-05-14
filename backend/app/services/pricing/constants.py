from __future__ import annotations

from decimal import Decimal

CM_PER_INCH = Decimal("2.54")
KG_PER_LB = Decimal("0.45359237")
OZ_PER_LB = Decimal("16")
DIM_DIVISOR = Decimal("139")
CUBIC_IN_PER_CUBIC_FT = Decimal("1728")
MONEY_QUANT = Decimal("0.01")
METRIC_QUANT = Decimal("0.0001")
RATE_QUANT = Decimal("0.000001")
VOLUME_FT_QUANT = Decimal("0.000001")

COMMISSION_RATE = Decimal("0.15")
RETURN_COMMISSION_RELIEF_RATE = Decimal("0.20")
STANDARD_STORAGE_RATE = Decimal("0.78")
OVERSIZE_STORAGE_RATE = Decimal("0.56")

PRICE_BANDS = [
    ("lt_10", "售价 < $10"),
    ("between_10_50", "售价 $10 ~ $50"),
    ("gt_50", "售价 > $50"),
]

SMALL_STANDARD_FEES = [
    (Decimal("2"), ("2.43", "3.32", "3.58"), "不超过 2 盎司"),
    (Decimal("4"), ("2.49", "3.42", "3.68"), "2 至 4 盎司"),
    (Decimal("6"), ("2.56", "3.45", "3.71"), "4 至 6 盎司"),
    (Decimal("8"), ("2.66", "3.54", "3.80"), "6 至 8 盎司"),
    (Decimal("10"), ("2.77", "3.68", "3.94"), "8 至 10 盎司"),
    (Decimal("12"), ("2.82", "3.78", "4.04"), "10 至 12 盎司"),
    (Decimal("14"), ("2.92", "3.91", "4.17"), "12 至 14 盎司"),
    (Decimal("16"), ("2.95", "3.96", "4.22"), "14 至 16 盎司"),
]

LARGE_STANDARD_FIXED_FEES = [
    (Decimal("4") / OZ_PER_LB, ("2.91", "3.73", "3.99"), "不超过 4 盎司"),
    (Decimal("8") / OZ_PER_LB, ("3.13", "3.95", "4.21"), "4 至 8 盎司"),
    (Decimal("12") / OZ_PER_LB, ("3.38", "4.20", "4.46"), "8 至 12 盎司"),
    (Decimal("16") / OZ_PER_LB, ("3.78", "4.60", "4.86"), "12 至 16 盎司"),
    (Decimal("1.25"), ("4.22", "5.04", "5.30"), "1 至 1.25 磅"),
    (Decimal("1.5"), ("4.60", "5.42", "5.68"), "1.25 至 1.5 磅"),
    (Decimal("1.75"), ("4.75", "5.57", "5.83"), "1.5 至 1.75 磅"),
    (Decimal("2"), ("5.00", "5.82", "6.08"), "1.75 至 2 磅"),
    (Decimal("2.25"), ("5.10", "5.92", "6.18"), "2 至 2.25 磅"),
    (Decimal("2.5"), ("5.28", "6.10", "6.36"), "2.25 至 2.5 磅"),
    (Decimal("2.75"), ("5.44", "6.26", "6.52"), "2.5 至 2.75 磅"),
    (Decimal("3"), ("5.85", "6.67", "6.93"), "2.75 至 3 磅"),
]

SMALL_STANDARD_INBOUND_FEES = [
    (Decimal("8"), Decimal("0.32"), "不超过 8 盎司"),
    (Decimal("16"), Decimal("0.32"), "8 至 16 盎司"),
]

LARGE_STANDARD_INBOUND_FEES = [
    (Decimal("12") / OZ_PER_LB, Decimal("0.40"), "不超过 12 盎司"),
    (Decimal("1.5"), Decimal("0.50"), "12 盎司至 1.5 磅"),
    (Decimal("3"), Decimal("0.60"), "1.5 至 3 磅"),
    (Decimal("5"), Decimal("0.76"), "3 至 5 磅"),
    (Decimal("7"), Decimal("0.98"), "5 至 7 磅"),
    (Decimal("10"), Decimal("1.20"), "7 至 10 磅"),
    (Decimal("15"), Decimal("1.50"), "10 至 15 磅"),
    (Decimal("20"), Decimal("1.90"), "15 至 20 磅"),
]

SMALL_OVERSIZE_INBOUND_FEES = [
    (Decimal("5"), Decimal("1.60"), "小于或等于 5 磅"),
    (Decimal("12"), Decimal("2.40"), "5 至 12 磅"),
    (Decimal("28"), Decimal("3.50"), "12 至 28 磅"),
    (Decimal("42"), Decimal("4.95"), "28 至 42 磅"),
    (Decimal("50"), Decimal("5.95"), "42 至 50 磅"),
]

LARGE_OVERSIZE_INBOUND_FEES = [
    (Decimal("5"), Decimal("1.80"), "小于或等于 5 磅"),
    (Decimal("12"), Decimal("2.90"), "5 至 12 磅"),
    (Decimal("28"), Decimal("4.10"), "12 至 28 磅"),
    (Decimal("42"), Decimal("5.60"), "28 至 42 磅"),
    (Decimal("50"), Decimal("6.50"), "42 至 50 磅"),
]

TIER_LABELS = {
    "small_standard": "小号标准尺寸",
    "large_standard": "大号标准尺寸",
    "small_oversize": "小号大件",
    "large_oversize": "大号大件",
    "oversize_0_50": "超大件（0 至 50 磅）",
    "oversize_50_70": "超大件（50 至 70 磅）",
    "oversize_70_150": "超大件（70 至 150 磅）",
    "oversize_150_plus": "超大件（150 磅以上）",
}

VAT_RATE_MAP: dict[str, Decimal] = {
    "DE": Decimal("0.19"),
    "UK": Decimal("0.20"),
}
