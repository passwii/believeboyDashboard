"""inventory_state + replenishment_action 判定逻辑。

三段式产物：
  1. inventory_state (5 状态)
  2. replenishment_action (6 行动)
  3. signals (透明度)

判定顺序（严格分阶段，避免循环）：
  trend_label → state → action
  trend_momentum / seasonal_factor 单独计算，传给 signals
"""

from __future__ import annotations

from enum import Enum

from app.services.inventory.health_score import ItemInput

# 阈值常量
TREND_RATIO_UP = 1.5
TREND_RATIO_STABLE = 0.9
TREND_RATIO_DOWN_MILD = 0.7
MOMENTUM_DELTA = 0.1


def compute_trend_label(dms_7: float | None, dms_30: float | None) -> str:
    """复用 _score_trend 4 档语义。

    ratio = dms_7 / dms_30
    ratio > 1.5       → 上升
    0.9 ≤ ratio ≤ 1.5 → 稳定
    0.7 ≤ ratio < 0.9 → 轻微下降
    ratio < 0.7       → 下降明显
    数据缺失 → 稳定
    """
    if dms_7 is None or dms_30 is None or dms_30 <= 0:
        return "稳定"
    ratio = dms_7 / dms_30
    if ratio > TREND_RATIO_UP:
        return "上升"
    if ratio >= TREND_RATIO_STABLE:
        return "稳定"
    if ratio >= TREND_RATIO_DOWN_MILD:
        return "轻微下降"
    return "下降明显"


def compute_trend_momentum(
    dms_7: float | None,
    dms_14: float | None,
    dms_30: float | None,
) -> str:
    """双比值差：delta = (dms_7 - dms_14) / dms_30。

    delta < -0.1 → accelerating （趋势在恶化）
    delta > +0.1 → decelerating （趋势在回稳）
    其它 → stable
    """
    if dms_7 is None or dms_14 is None or dms_30 is None or dms_30 <= 0:
        return "stable"
    delta = (dms_7 - dms_14) / dms_30
    if delta < -MOMENTUM_DELTA:
        return "accelerating"
    if delta > MOMENTUM_DELTA:
        return "decelerating"
    return "stable"


def compute_seasonal_adjusted_sellable_days(
    sellable_days: float | None,
    seasonal_factor: float | None,
) -> float | None:
    """adjusted_sellable_days = sellable_days / seasonal_factor。

    factor=None 或 factor<=0 → 不调整，返原值。
    """
    if sellable_days is None:
        return None
    if seasonal_factor is None or seasonal_factor <= 0:
        return sellable_days
    return sellable_days / seasonal_factor


# ============================================================================
# ReplenishmentAction enum
# ============================================================================


class ReplenishmentAction(str, Enum):
    REPLENISH_NOW = "REPLENISH_NOW"
    REPLENISH_NORMAL = "REPLENISH_NORMAL"
    HOLD = "HOLD"
    REDUCE_PRICE = "REDUCE_PRICE"
    REMOVE = "REMOVE"
    NO_ACTION = "NO_ACTION"


# ============================================================================
# inventory_state 判定阈值常量（spec §2.1）
# ============================================================================

STATE_CRITICAL_DOH = 14
STATE_CRITICAL_SHORTAGE_DOH = 30
STATE_OVERSTOCK_CRITICAL_DOH = 180
STATE_OVERSTOCK_DETERIORATE_DOH = 120
STATE_WATCH_DOH_MIN = 30
STATE_WATCH_DOH_MAX = 90
AGING_271_RATIO = 0.50
AGING_181_RATIO = 0.50
AGING_91_DETERIORATE_RATIO = 0.30
TRANSIT_RATIO_DETERIORATE = 3.0
VELOCITY_MID = 0.7


def compute_inventory_state(
    item: ItemInput,
    trend_label: str,
    adjusted_sellable_days: float | None,
) -> tuple[str, str | None]:
    """返回 (state, critical_subtype)。

    critical_subtype ∈ {'shortage', 'aging', 'overstock'} 仅当 state='critical'。
    其余 state 时 critical_subtype 为 None。
    """
    doh = adjusted_sellable_days  # 使用季节性调整后的 DoH

    # P0: 数据缺失（dms_30 是核心指标）
    if item.dms_30 is None:
        return ("unknown", None)

    # P1: 立即断货风险（DoH<14）
    if doh is not None and doh < STATE_CRITICAL_DOH:
        return ("critical", "shortage")

    # P2: DoH 14-30 且在卖
    if doh is not None and doh < STATE_CRITICAL_SHORTAGE_DOH and item.dms_30 > 0:
        return ("critical", "shortage")

    # 计算 total_age
    total_age = (
        item.age_0_90_qty
        + item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
    )

    # P3: 库龄 365+
    if item.age_365_plus_qty > 0:
        return ("critical", "aging")

    # P4: 库龄 271-365 占 ≥50%
    if total_age > 0 and (item.age_271_365_qty / total_age) >= AGING_271_RATIO:
        return ("critical", "aging")

    # P5: 库龄 181-270 占 ≥50%
    if total_age > 0 and (item.age_181_270_qty / total_age) >= AGING_181_RATIO:
        return ("critical", "aging")

    # P6: DoH>180 且慢销
    if (
        doh is not None
        and doh > STATE_OVERSTOCK_CRITICAL_DOH
        and item.dms_30 < VELOCITY_MID
    ):
        return ("critical", "overstock")

    # P7: DoH 120-180 且慢销 → deteriorating
    if (
        doh is not None
        and STATE_OVERSTOCK_DETERIORATE_DOH < doh <= STATE_OVERSTOCK_CRITICAL_DOH
        and item.dms_30 < VELOCITY_MID
    ):
        return ("deteriorating", None)

    # P8: trend=下降明显 + 库龄 91+ ≥30% 或 在途/可售>3
    if trend_label == "下降明显":
        aging_91_plus_ratio = (
            (
                item.age_91_180_qty
                + item.age_181_270_qty
                + item.age_271_365_qty
                + item.age_365_plus_qty
            )
            / total_age
            if total_age > 0
            else 0
        )
        transit_ratio_local = (
            item.in_transit_qty / item.available_qty if item.available_qty > 0 else 0
        )
        if (
            aging_91_plus_ratio >= AGING_91_DETERIORATE_RATIO
            or transit_ratio_local > TRANSIT_RATIO_DETERIORATE
        ):
            return ("deteriorating", None)

    # P9: DoH 45-90 + trend=下降明显 → deteriorating
    if (
        doh is not None
        and 45 <= doh <= STATE_WATCH_DOH_MAX
        and trend_label == "下降明显"
    ):
        return ("deteriorating", None)

    # P10: DoH 30-45 + trend=下降明显 → watch
    if (
        doh is not None
        and STATE_WATCH_DOH_MIN <= doh < 45
        and trend_label == "下降明显"
    ):
        return ("watch", None)

    # P11: DoH 90-180 + 库龄正常 → watch
    if doh is not None and STATE_WATCH_DOH_MAX < doh <= STATE_OVERSTOCK_CRITICAL_DOH:
        return ("watch", None)

    # P12/P13: 其余 → healthy
    return ("healthy", None)


# ============================================================================
# replenishment_action 决策（spec §2.2 12 行 + 季节性覆盖）
# ============================================================================

PEAK_PHASES = {"peak", "rising"}
TROUGH_PHASES = {"falling", "trough"}


def compute_replenishment_action(
    state: str,
    critical_subtype: str | None,
    trend_label: str,
    transit_ratio: float,
    seasonal_phase: str,
) -> str:
    """决策表（spec §2.2）。

    规则优先级：
    1. critical + shortage → REPLENISH_NORMAL / HOLD（旺季覆盖）
    2. critical + aging → REMOVE
    3. critical + overstock → REDUCE_PRICE / HOLD（淡季覆盖）
    4. deteriorating → REDUCE_PRICE / HOLD（淡季覆盖）
    5. watch / healthy / unknown → NO_ACTION
    """
    trend_is_decline = trend_label in {"轻微下降", "下降明显"}
    trend_is_up = trend_label in {"上升", "稳定"}

    # 1. critical + shortage：DoH<14 和 DoH 14-30 在卖都走这里
    if state == "critical" and critical_subtype == "shortage":
        if trend_is_up:
            return ReplenishmentAction.REPLENISH_NORMAL.value
        # trend=下降；旺季覆盖 → REPLENISH_NORMAL（旺季"下降"可能是补货跟进问题）
        if seasonal_phase in PEAK_PHASES:
            return ReplenishmentAction.REPLENISH_NORMAL.value
        return ReplenishmentAction.HOLD.value

    # 2. critical + aging → REMOVE
    if state == "critical" and critical_subtype == "aging":
        return ReplenishmentAction.REMOVE.value

    # 3. critical + overstock：DoH>120 慢销
    if state == "critical" and critical_subtype == "overstock":
        if trend_is_decline:
            return ReplenishmentAction.REDUCE_PRICE.value
        # trend_is_up
        if transit_ratio > 3.0:
            return ReplenishmentAction.REDUCE_PRICE.value
        # transit≤3；trough 覆盖 → HOLD（季节性存量）
        return ReplenishmentAction.HOLD.value

    # 4. deteriorating
    if state == "deteriorating":
        if trend_is_decline:
            # trough 覆盖 → HOLD（避免误杀季节性回落）
            if seasonal_phase in TROUGH_PHASES:
                return ReplenishmentAction.HOLD.value
            return ReplenishmentAction.REDUCE_PRICE.value
        # trend_is_up → HOLD
        return ReplenishmentAction.HOLD.value

    # 5. watch / healthy / unknown
    return ReplenishmentAction.NO_ACTION.value


# ============================================================================
# compute_signals（spec §2.3）
# ============================================================================


def compute_signals(
    item: ItemInput,
    trend_label: str,
    trend_momentum: str,
    snapshot_age_days: int,
    seasonal_factor: float | None,
    seasonal_phase: str,
    seasonal_source: str,
) -> dict:
    """返回 signals dict（不含 dataclass，便于映射到 Pydantic schema）。

    spec §2.3 完整字段列表：
      sellable_days, dms_3/7/14/30,
      trend_ratio_7_30, trend_ratio_3_7,
      trend_label, trend_momentum,
      aging_share (dict), transit_ratio,
      data_freshness_days, confidence,
      seasonal_factor, seasonal_phase, seasonal_source (v1.2)
    """

    # trend_ratio
    trend_ratio_7_30 = (
        item.dms_7 / item.dms_30
        if item.dms_7 is not None and item.dms_30 is not None and item.dms_30 > 0
        else None
    )
    trend_ratio_3_7 = (
        item.dms_3 / item.dms_7
        if item.dms_3 is not None and item.dms_7 is not None and item.dms_7 > 0
        else None
    )

    # aging_share
    total_age = (
        item.age_0_90_qty
        + item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
    )
    if total_age > 0:
        aging_share = {
            "0_90": item.age_0_90_qty / total_age,
            "91_180": item.age_91_180_qty / total_age,
            "181_270": item.age_181_270_qty / total_age,
            "271_365": item.age_271_365_qty / total_age,
            "365_plus": item.age_365_plus_qty / total_age,
        }
    else:
        aging_share = {
            "0_90": 0.0,
            "91_180": 0.0,
            "181_270": 0.0,
            "271_365": 0.0,
            "365_plus": 0.0,
        }

    # transit_ratio
    transit_ratio = (
        item.in_transit_qty / item.available_qty if item.available_qty > 0 else None
    )

    # confidence（spec §2.3 算法）
    has_dms30 = item.dms_30 is not None
    has_dms7 = item.dms_7 is not None
    has_full_aging = total_age > 0
    if not has_dms30 or snapshot_age_days > 3:
        confidence = "low"
    elif (not has_dms7 or not has_full_aging) or snapshot_age_days > 1:
        confidence = "medium"
    else:
        confidence = "high"

    return {
        "sellable_days": item.sellable_days,
        "dms_3": item.dms_3,
        "dms_7": item.dms_7,
        "dms_14": item.dms_14,
        "dms_30": item.dms_30,
        "trend_ratio_7_30": trend_ratio_7_30,
        "trend_ratio_3_7": trend_ratio_3_7,
        "trend_label": trend_label,
        "trend_momentum": trend_momentum,
        "aging_share": aging_share,
        "transit_ratio": transit_ratio,
        "data_freshness_days": snapshot_age_days,
        "confidence": confidence,
        "seasonal_factor": seasonal_factor,
        "seasonal_phase": seasonal_phase,
        "seasonal_source": seasonal_source,
    }
