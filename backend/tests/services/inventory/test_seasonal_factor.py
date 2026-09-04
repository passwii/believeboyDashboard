"""seasonal_factor 单元测试（v1.2 简化版）。

v1.2 fallback 简化：没 SKU YoY 数据直接跳过（不 fallback 到项目级平均）。
"""

from __future__ import annotations

import pytest

from app.services.inventory.seasonal_factor import (
    SEASONAL_PHASE_THRESHOLDS,
    compute_seasonal_factor,
    compute_seasonal_phase,
)


class TestComputeSeasonalFactor:
    """compute_seasonal_factor 返回 (factor, phase, source)。"""

    def test_factor_from_sku_yoy_single_ratio(self):
        """dms_30=2.0, dms_30_yoy=1.0, dms_7_yoy=None → factor=2.0, source='sku_yoy'"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=None, dms_30_yoy=1.0, dms_7_yoy=None
        )
        assert factor == 2.0
        assert source == "sku_yoy"
        assert phase == "peak"

    def test_factor_average_of_two_yoy_ratios(self):
        """dms_30=2.0/dms_30_yoy=1.0=2.0; dms_7=1.5/dms_7_yoy=1.0=1.5; avg=1.75"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == pytest.approx(1.75)
        assert source == "sku_yoy"
        assert phase == "peak"

    def test_factor_from_single_yoy_when_only_one_available(self):
        """只有 dms_7_yoy（dms_30_yoy=None）→ 单个比值"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=None, dms_7_yoy=1.0
        )
        assert factor == 1.5
        assert source == "sku_yoy"

    def test_factor_neutral_when_no_yoy(self):
        """全 None → None, 'neutral', 'unknown'（v1.2 不 fallback）"""
        factor, phase, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=None, dms_7_yoy=None
        )
        assert factor is None
        assert source == "neutral"
        assert phase == "unknown"

    def test_factor_neutral_when_all_dms_zero(self):
        """dms 全 0（没销量）→ None"""
        factor, _, source = compute_seasonal_factor(
            dms_30=0, dms_7=0, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor is None
        assert source == "neutral"

    def test_factor_zero_yoy_returns_neutral(self):
        """yoy=0 → 不能除，返 None"""
        factor, _, source = compute_seasonal_factor(
            dms_30=2.0, dms_7=1.5, dms_30_yoy=0, dms_7_yoy=0
        )
        assert factor is None
        assert source == "neutral"

    def test_factor_clamp_to_3_when_extreme_high(self):
        """factor=5.0 → clamp 到 3.0, peak"""
        factor, phase, _ = compute_seasonal_factor(
            dms_30=5.0, dms_7=5.0, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == 3.0
        assert phase == "peak"

    def test_factor_clamp_to_03_when_extreme_low(self):
        """factor=0.1 → clamp 到 0.3, trough"""
        factor, phase, _ = compute_seasonal_factor(
            dms_30=0.1, dms_7=0.1, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        assert factor == 0.3
        assert phase == "trough"

    def test_factor_ignores_zero_dms_even_when_yoy_positive(self):
        """dms_30=0 但 dms_30_yoy=1.0 → 0/1.0 = 0 应该被忽略（dms 是分子，不能 0）"""
        factor, _, source = compute_seasonal_factor(
            dms_30=0, dms_7=1.5, dms_30_yoy=1.0, dms_7_yoy=1.0
        )
        # dms_30=0 跳过；dms_7=1.5 / dms_7_yoy=1.0 = 1.5
        assert factor == 1.5
        assert source == "sku_yoy"


class TestComputeSeasonalPhase:
    """compute_seasonal_phase 按阈值划分相位。"""

    def test_phase_peak(self):
        assert compute_seasonal_phase(1.5) == "peak"
        assert compute_seasonal_phase(2.0) == "peak"

    def test_phase_rising(self):
        assert compute_seasonal_phase(1.2) == "rising"
        assert compute_seasonal_phase(1.3) == "rising"

    def test_phase_neutral(self):
        assert compute_seasonal_phase(1.0) == "neutral"
        assert compute_seasonal_phase(0.95) == "neutral"
        assert compute_seasonal_phase(0.9) == "neutral"

    def test_phase_falling(self):
        assert compute_seasonal_phase(0.8) == "falling"
        assert compute_seasonal_phase(0.7) == "falling"

    def test_phase_trough(self):
        assert compute_seasonal_phase(0.5) == "trough"
        assert compute_seasonal_phase(0.1) == "trough"

    def test_phase_unknown_when_factor_none(self):
        assert compute_seasonal_phase(None) == "unknown"

    def test_thresholds_dict_exists(self):
        """常量 SEASONAL_PHASE_THRESHOLDS 必须存在并有完整阈值。"""
        assert "peak" in SEASONAL_PHASE_THRESHOLDS
        assert "rising" in SEASONAL_PHASE_THRESHOLDS
        assert "neutral_low" in SEASONAL_PHASE_THRESHOLDS
        assert "falling" in SEASONAL_PHASE_THRESHOLDS
