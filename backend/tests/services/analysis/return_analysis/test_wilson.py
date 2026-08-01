"""Wilson 95% 置信区间下界公式 + risk_level 判定 — 单测。

覆盖 plan §1 拍板的 8 个场景，验证公式 + 等级映射同时正确。
公式源自 Edwin Wilson 1927, 适用于小样本二项分布。

不做的事：
- 不 mock 任何业务逻辑（公式是纯函数）
- 不依赖外部库（不要 scipy）
"""

from __future__ import annotations

import pytest

from app.constants.return_thresholds import (
    MIN_SALES_FOR_RISK_LEVEL,
    WILSON_CRITICAL_THRESHOLD,
    WILSON_WARNING_THRESHOLD,
    WILSON_Z,
)
from app.utils.stats import wilson_lower_bound


# ──────────────────────────────────────────────────────────────────────
# 1. 公式边界（数值精度用 abs 容差 0.1，因为算法本身就四舍五入到 0.01%）
# ──────────────────────────────────────────────────────────────────────


def test_wilson_zero_trials_returns_zero() -> None:
    """trials=0 时返回 0，避免除零。"""
    assert wilson_lower_bound(0, 0) == 0.0
    assert wilson_lower_bound(5, 0) == 0.0


def test_wilson_zero_successes_returns_zero() -> None:
    """successes=0 时（无退货）下界为 0，不触发任何风险等级。"""
    assert wilson_lower_bound(0, 100) == 0.0


def test_wilson_small_sample_does_not_overestimate() -> None:
    """极小样本：卖 2 退 1 → Wilson 下界约 9.5%（比 raw 50% 显著拉低）。"""
    result = wilson_lower_bound(1, 2)
    # raw 是 50%, Wilson 下界应 < 15%
    assert 5.0 <= result <= 15.0, f"expected ~9.5%, got {result}"


def test_wilson_medium_sample_under_threshold() -> None:
    """中等样本：卖 100 退 10 → 下界约 5.5%（未达 6% 警告阈值）。"""
    result = wilson_lower_bound(10, 100)
    assert 4.5 <= result <= 6.5, f"expected ~5.5%, got {result}"


def test_wilson_large_sample_triggers_warning() -> None:
    """大样本：卖 1000 退 100 → 下界约 8.3%（触发 warning）。"""
    result = wilson_lower_bound(100, 1000)
    assert 7.5 <= result <= 9.5, f"expected ~8.3%, got {result}"


def test_wilson_large_sample_high_rate_triggers_critical() -> None:
    """大样本高退货率：卖 1000 退 150 → 下界约 12.9%（触发 critical）。"""
    result = wilson_lower_bound(150, 1000)
    assert 11.5 <= result <= 14.5, f"expected ~12.9%, got {result}"


def test_wilson_small_sample_high_rate_pulled_down() -> None:
    """极小样本高比例：卖 10 退 5 → 下界约 23.7%（raw 50% 被 Wilson 拉低）。"""
    result = wilson_lower_bound(5, 10)
    # raw 是 50%, Wilson 下界应远低于 raw 但仍 > critical 阈值
    assert 18.0 <= result <= 28.0, f"expected ~23.7%, got {result}"


def test_wilson_perfect_rate() -> None:
    """极端：全部退货（successes == trials）。下界应接近 100% 但小于 100%。"""
    result = wilson_lower_bound(100, 100)
    assert 95.0 <= result < 100.0, f"expected ~96.5%, got {result}"


# ──────────────────────────────────────────────────────────────────────
# 2. risk_level 判定（基于销量门槛 + Wilson 下界）
# ──────────────────────────────────────────────────────────────────────


def test_compute_risk_level_no_data_below_min_sales() -> None:
    """销量 < 15 → no_data（即使 Wilson 显示高退货率）。"""
    from app.utils.stats import compute_risk_level

    # 卖 5 退 5（100% 退货率），但销量 < 15 → no_data
    risk, wilson = compute_risk_level(return_quantity=5, sales_quantity=5)
    assert risk == "no_data"
    assert wilson == 0.0


def test_compute_risk_level_normal_under_warning() -> None:
    """销量 ≥ 15 且 Wilson < 6% → normal。"""
    from app.utils.stats import compute_risk_level

    # 卖 100 退 5（5%），Wilson 下界约 2%
    risk, wilson = compute_risk_level(return_quantity=5, sales_quantity=100)
    assert risk == "normal"
    assert wilson > 0.0


def test_compute_risk_level_warning_in_range() -> None:
    """Wilson 介于 6% 和 10% → warning。"""
    from app.utils.stats import compute_risk_level

    # 卖 1000 退 80（8%）→ Wilson 下界约 6.3%
    risk, wilson = compute_risk_level(return_quantity=80, sales_quantity=1000)
    assert risk == "warning"
    assert WILSON_WARNING_THRESHOLD <= wilson < WILSON_CRITICAL_THRESHOLD


def test_compute_risk_level_critical_above_threshold() -> None:
    """Wilson ≥ 10% → critical。"""
    from app.utils.stats import compute_risk_level

    # 卖 1000 退 100（10%）→ Wilson 下界约 8.0%
    # 卖 1000 退 130（13%）→ Wilson 下界约 10.7%
    risk, wilson = compute_risk_level(return_quantity=130, sales_quantity=1000)
    assert risk == "critical"
    assert wilson >= WILSON_CRITICAL_THRESHOLD


def test_compute_risk_level_at_min_sales_boundary() -> None:
    """边界：sales_quantity == MIN_SALES_FOR_RISK_LEVEL 时仍参与判定。"""
    from app.utils.stats import compute_risk_level

    # 卖 15 退 10（66.7%）→ Wilson 下界约 42%（远高于 critical）
    risk, wilson = compute_risk_level(return_quantity=10, sales_quantity=15)
    assert risk == "critical"
    assert wilson >= WILSON_CRITICAL_THRESHOLD


# ──────────────────────────────────────────────────────────────────────
# 3. 阈值常量合理性（防止误改）
# ──────────────────────────────────────────────────────────────────────


def test_thresholds_match_plan_decision() -> None:
    """阈值常量必须符合 BEL-372 拍板的取值。"""
    assert WILSON_Z == 1.96  # 95% 置信
    assert MIN_SALES_FOR_RISK_LEVEL == 15  # 用户拍板（30 → 15）
    assert WILSON_CRITICAL_THRESHOLD == 10.0
    assert WILSON_WARNING_THRESHOLD == 6.0


# ──────────────────────────────────────────────────────────────────────
# 4. plan §1 表格场景完整复现（端到端）
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "return_qty,sales_qty,expected_wilson_band,expected_risk",
    [
        # (return, sales, Wilson 下界带, 期望 risk_level)
        (1, 2, (5.0, 15.0), "no_data"),  # < 15 → no_data (Wilson ~9.5%)
        (1, 15, (0.0, 5.0), "normal"),  # = 15 参与判定; Wilson ~1.2%
        (2, 15, (0.0, 6.0), "normal"),  # = 15 参与判定; Wilson ~3.7%
        (3, 30, (0.0, 5.0), "normal"),  # 30 件门槛内; Wilson ~3.5%
        (10, 100, (4.5, 6.5), "normal"),  # Wilson ~5.5%
        (100, 1000, (7.5, 9.5), "warning"),  # Wilson ~8.3%
        (150, 1000, (11.5, 14.5), "critical"),  # Wilson ~12.9%
        (5, 10, (18.0, 28.0), "critical"),  # Wilson ~23.7% (sales < 15 直接 no_data)
        # 注：最后一行 sales < 15 直接 no_data, 绕过 risk_level 计算
    ],
)
def test_plan_table_scenarios(
    return_qty: int,
    sales_qty: int,
    expected_wilson_band: tuple[float, float],
    expected_risk: str,
) -> None:
    """复现 plan §1 表格：8 个 (sales_qty, return_qty) 场景 → Wilson 下界 + risk_level。"""
    from app.utils.stats import compute_risk_level

    wilson = wilson_lower_bound(return_qty, sales_qty)
    low, high = expected_wilson_band
    assert low <= wilson <= high, (
        f"Wilson [{low}, {high}], got {wilson} for ({return_qty}/{sales_qty})"
    )

    # 最后一行特殊：sales < 15 直接 no_data，绕过 risk_level 计算
    if sales_qty < MIN_SALES_FOR_RISK_LEVEL:
        risk, _ = compute_risk_level(return_qty, sales_qty)
        assert risk == "no_data"
    else:
        risk, _ = compute_risk_level(return_qty, sales_qty)
        assert risk == expected_risk
