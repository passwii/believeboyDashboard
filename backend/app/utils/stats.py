"""Wilson 95% 置信区间下界公式 + risk_level 判定。

公式源自 Edwin Wilson 1927, 适用于小样本二项分布。
与 scipy.stats._binary_smoother 等价, 但只 10 行 Python。
"""

from __future__ import annotations

import math
from typing import Tuple

from app.constants.return_thresholds import (
    MIN_SALES_FOR_RISK_LEVEL,
    WILSON_CRITICAL_THRESHOLD,
    WILSON_WARNING_THRESHOLD,
    WILSON_Z,
)


def wilson_lower_bound(successes: int, trials: int, z: float = WILSON_Z) -> float:
    """Wilson 95% 置信区间下界（百分比形式, 0.0 ~ 100.0）。

    Examples:
        >>> wilson_lower_bound(1, 2)
        ~0.6
        >>> wilson_lower_bound(100, 1000)
        ~8.0
        >>> wilson_lower_bound(5, 10)
        ~21.7

    Returns:
        下界百分比（min 0.0）

    Raises:
        不抛异常, 边界情况返回 0.0

    Note:
        真实退货数据里 ``successes``（退货件数）可能 > ``trials``（同窗口
        销售件数）——退货来自更早下单的订单。此时裸比例 p > 1，会让
        ``p*(1-p)`` 变负、``math.sqrt`` 抛 ``ValueError: math domain error``。
        Wilson 区间本质是二项比例置信区间，定义域 p ∈ [0,1]，故把 p
        clamp 到 [0,1]：退货 > 销售时按 p=1 处理（下界接近 100%，保守
        判为高风险）。再对 sqrt 参数取 max(0.0, ·) 兜底浮点误差。
    """
    if trials <= 0:
        return 0.0
    # clamp 裸比例到 [0,1]：退货件数可能 > 销售件数（跨期退货），见 Note。
    p = min(1.0, max(0.0, successes / trials))
    denom = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denom
    radicand = p * (1 - p) / trials + z * z / (4 * trials * trials)
    margin = z * math.sqrt(max(0.0, radicand)) / denom
    return max(0.0, (center - margin) * 100)


def compute_risk_level(
    return_quantity: int,
    sales_quantity: int,
) -> Tuple[str, float]:
    """根据销量门槛 + Wilson 下界判定 risk_level。

    Args:
        return_quantity: 退货件数
        sales_quantity: 同周期销售件数

    Returns:
        (risk_level, wilson_lower_bound):
        - risk_level: 'critical' | 'warning' | 'normal' | 'no_data'
        - wilson_lower_bound: Wilson 95% 下界百分比; no_data 时返回 0.0

    规则（BEL-372 拍板）:
        - sales_quantity < 15 → no_data（避免小样本噪声）
        - sales_quantity >= 15:
            - Wilson >= 10% → critical
            - Wilson >= 6% → warning
            - 否则 → normal
    """
    if sales_quantity < MIN_SALES_FOR_RISK_LEVEL:
        return "no_data", 0.0
    wilson = wilson_lower_bound(return_quantity, sales_quantity)
    if wilson >= WILSON_CRITICAL_THRESHOLD:
        return "critical", wilson
    if wilson >= WILSON_WARNING_THRESHOLD:
        return "warning", wilson
    return "normal", wilson
