"""季节性因子计算（v1.2 简化版）。

每个 SKU 自己的"季节性基线"——基于 YoY DMS 数据自动学，不需要任何人工标注。

Fallback 链（v1.2 简化）：SKU 自己的 YoY → 跳过（无 fallback）。
v1.2 决策理由：现实里大部分项目店铺没 YoY，与其 fallback 到项目级平均污染判断，
不如直接跳过——signals.seasonal_phase = "unknown" 不影响主流程。
"""

from __future__ import annotations

# 阈值常量：factor > X → 对应相位
SEASONAL_PHASE_THRESHOLDS: dict[str, float] = {
    "peak": 1.3,  # > 1.3 → peak
    "rising": 1.1,  # > 1.1 且 ≤ 1.3 → rising
    "neutral_low": 0.9,  # ≥ 0.9 且 ≤ 1.1 → neutral
    "falling": 0.7,  # ≥ 0.7 且 < 0.9 → falling
    # < 0.7 → trough
}

FACTOR_MIN = 0.3
FACTOR_MAX = 3.0


def compute_seasonal_factor(
    dms_30: float | None,
    dms_7: float | None,
    dms_30_yoy: float | None,
    dms_7_yoy: float | None,
) -> tuple[float | None, str, str]:
    """返回 (factor, phase, source)。

    factor: 季节性因子，1.0=常态，>1=旺季，<1=淡季；None=无数据
    phase: peak/rising/neutral/falling/trough/unknown
    source: sku_yoy / neutral
    """
    ratios: list[float] = []
    # dms_30 不能是 0（分子必须 > 0，否则表示没销量，不算季节性）
    if dms_30 is not None and dms_30 > 0 and dms_30_yoy is not None and dms_30_yoy > 0:
        ratios.append(dms_30 / dms_30_yoy)
    if dms_7 is not None and dms_7 > 0 and dms_7_yoy is not None and dms_7_yoy > 0:
        ratios.append(dms_7 / dms_7_yoy)

    if not ratios:
        return (None, "unknown", "neutral")

    raw = sum(ratios) / len(ratios)
    factor = max(FACTOR_MIN, min(FACTOR_MAX, raw))
    return (factor, compute_seasonal_phase(factor), "sku_yoy")


def compute_seasonal_phase(factor: float | None) -> str:
    """按 factor 划分相位。factor=None → 'unknown'。"""
    if factor is None:
        return "unknown"
    if factor > SEASONAL_PHASE_THRESHOLDS["peak"]:
        return "peak"
    if factor > SEASONAL_PHASE_THRESHOLDS["rising"]:
        return "rising"
    if factor >= SEASONAL_PHASE_THRESHOLDS["neutral_low"]:
        return "neutral"
    if factor >= SEASONAL_PHASE_THRESHOLDS["falling"]:
        return "falling"
    return "trough"
