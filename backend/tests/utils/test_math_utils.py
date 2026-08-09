"""Tests for app.utils.math_utils.change_pct (BLF-570 同比/环比原子函数).

Covers the unified boundary semantics:

- ``prev > 0``: ``(current - prev) / prev * 100`` rounded to 2dp (0.01%)
- ``prev <= 0`` and ``current > 0``: ``None``（上期无基数，变化率无意义）
- ``prev <= 0`` and ``current <= 0``: ``0.0``（两期均无数据，视为无变化）
- ``None`` inputs are treated as 0 (module convention)
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.utils.math_utils import change_pct

# ─── 正常值 ──────────────────────────────────────────────────────────────────


def test_change_pct_normal_increase():
    assert change_pct(110, 100) == 10.0


def test_change_pct_normal_decrease():
    assert change_pct(80, 100) == -20.0


def test_change_pct_zero_prev_to_zero():
    """两期均为 0 → 0.0（无变化）。"""
    assert change_pct(0, 0) == 0.0


def test_change_pct_unchanged():
    assert change_pct(100, 100) == 0.0


def test_change_pct_rounds_to_two_dp():
    """(4-3)/3 → 33.3333% → 33.33%（ROUND_HALF_UP 到 0.01%）。"""
    assert change_pct(4, 3) == pytest.approx(33.33, abs=1e-9)


def test_change_pct_rounds_half_up():
    """(5-3)/3 → 66.6666% → 66.67%（ROUND_HALF_UP 而非 banker's rounding）。"""
    assert change_pct(5, 3) == pytest.approx(66.67, abs=1e-9)


def test_change_pct_accepts_decimal():
    assert change_pct(Decimal(110), Decimal(100)) == 10.0


def test_change_pct_accepts_mixed_types():
    assert change_pct(Decimal(110), 100) == 10.0


# ─── prev = 0 边界 ────────────────────────────────────────────────────────────


def test_change_pct_prev_zero_curr_positive_is_none():
    """prev=0 且 curr>0 → None：上期无基数，"从无到有"既不是 0% 也不是 100%。"""
    assert change_pct(10, 0) is None


def test_change_pct_prev_zero_curr_zero_is_zero():
    assert change_pct(0, 0) == 0.0


def test_change_pct_prev_zero_curr_negative_is_zero():
    """prev=0 且 curr<=0 → 0.0（两期均无有效数据，与 safe_ratio 语义一致）。"""
    assert change_pct(-5, 0) == 0.0


# ─── prev < 0 边界 ────────────────────────────────────────────────────────────


def test_change_pct_prev_negative_curr_positive_is_none():
    assert change_pct(10, -5) is None


def test_change_pct_prev_negative_curr_zero_is_zero():
    assert change_pct(0, -5) == 0.0


def test_change_pct_prev_negative_curr_negative_is_zero():
    """负基数场景无数学意义，按 safe_ratio 分母<=0 → 0 的底层语义返回 0.0。"""
    assert change_pct(-3, -5) == 0.0


# ─── None 输入 ────────────────────────────────────────────────────────────────


def test_change_pct_none_inputs_treated_as_zero():
    assert change_pct(None, 100) == -100.0
    assert change_pct(100, None) is None
    assert change_pct(None, None) == 0.0
