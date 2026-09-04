"""
库存健康度评分模块。

设计：两层判定
  - 第一层：方向（决定动作）  →  断货侧 / 滞销侧 / 健康 / 数据缺失
  - 第二层：程度（同方向内轻重）→  边缘 / 警示 / 严重

health_score (0-100) 仍计算并返回，作为辅助参考数字展示。

不修改亚马逊源 recommended_action 字段，独立输出 risk_status / risk_reasons。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

# ---------------------------------------------------------------------------
# 权重
# ---------------------------------------------------------------------------

W_DOH = 0.30
W_VELOCITY = 0.25
W_TREND = 0.15
W_AGING = 0.20
W_TRANSIT = 0.10

# ---------------------------------------------------------------------------
# 阈值常量（按同事方案 + 业务微调）
# ---------------------------------------------------------------------------

# DoH 阈值
DOH_OOS_RISK = 14  # < 14 视为断货风险
DOH_SHORTAGE = 30  # < 30 视为短期断货
DOH_HEALTHY_MIN = 30  # 健康下界
DOH_HEALTHY_MAX = 90  # 健康上界
DOH_OVERSTOCK_MILD = 60  # 进入滞销侧的下界（与健康区有交叠，配合库龄判定）
DOH_OVERSTOCK_STRONG = 180  # 严重滞销下界

# 库龄阈值（占比 = 该档 qty / available_qty）
AGING_365_PLUS_ANY = 1  # age_365+ > 0 立即判严重
AGING_271_RATIO = 0.50
AGING_181_RATIO = 0.50
AGING_91_RATIO = 0.50

# 销量阈值
VELOCITY_DEAD = 0.0
VELOCITY_ALMOST_DEAD = 0.1
VELOCITY_SLOW = 0.3
VELOCITY_MID = 0.7
VELOCITY_HOT = 2.0

# 趋势比值
TREND_RATIO_UP = 1.5
TREND_RATIO_STABLE = 0.9
TREND_RATIO_DOWN_MILD = 0.7

# 在途冗余
TRANSIT_RATIO_LOW = 0.3
TRANSIT_RATIO_MID = 1.0
TRANSIT_RATIO_HIGH = 3.0

# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------


@dataclass
class ScoreBreakdown:
    """每个轴的得分与命中区间，便于调试。"""

    doh_score: int
    velocity_score: int
    trend_score: int
    aging_score: int
    transit_score: int
    details: dict = field(default_factory=dict)


@dataclass
class HealthAssessment:
    """单 SKU 的完整评估结果。"""

    health_score: int
    direction: str  # "shortage" | "overstock" | "healthy" | "missing_data"
    risk_status: str  # 🔴断货风险 / 🟠短期断货 / 🟡关注 / 🟢健康 / 🟣滞销 / ⚫严重滞销 / ⚪数据缺失
    risk_reasons: list[str]
    breakdown: ScoreBreakdown


@dataclass
class ItemInput:
    """评分所需最小输入（不耦合 ORM/Schema）。"""

    available_qty: int = 0
    sellable_days: float | None = None
    dms_30: float | None = None
    dms_14: float | None = None  # v1.2: 新增（trend_momentum 需要）
    dms_7: float | None = None
    dms_3: float | None = None  # v1.2: 新增（trend_ratio_3_7 需要）
    age_0_90_qty: int = 0
    age_91_180_qty: int = 0
    age_181_270_qty: int = 0
    age_271_365_qty: int = 0
    age_365_plus_qty: int = 0
    in_transit_qty: int = 0


# ---------------------------------------------------------------------------
# 5 轴评分（0-100，高分=高风险）
# ---------------------------------------------------------------------------


def _score_doh(sellable_days: float | None) -> tuple[int, str]:
    if sellable_days is None:
        return 50, "DoH 缺失"
    if sellable_days <= 0:
        return 0, f"DoH={sellable_days} 断货"
    if sellable_days < DOH_OOS_RISK:
        return 5, f"DoH={sellable_days:g}天 断货风险"
    if sellable_days < DOH_SHORTAGE:
        return 25, f"DoH={sellable_days:g}天 短期断货"
    if sellable_days < DOH_HEALTHY_MAX:
        return 50, f"DoH={sellable_days:g}天 健康边界"
    if sellable_days < 90:
        return 75, f"DoH={sellable_days:g}天 健康"
    if sellable_days < 180:
        return 90, f"DoH={sellable_days:g}天 滞销"
    return 100, f"DoH={sellable_days:g}天 严重滞销"


def _score_velocity(dms_30: float | None) -> tuple[int, str]:
    if dms_30 is None:
        return 100, "dms_30 缺失（无销量数据）"
    if dms_30 == VELOCITY_DEAD:
        return 100, "dms_30=0 完全死货"
    if dms_30 < VELOCITY_ALMOST_DEAD:
        return 95, f"dms_30={dms_30:g} 几乎不动"
    if dms_30 < VELOCITY_SLOW:
        return 80, f"dms_30={dms_30:g} 慢销"
    if dms_30 < VELOCITY_MID:
        return 50, f"dms_30={dms_30:g} 中等"
    if dms_30 < VELOCITY_HOT:
        return 20, f"dms_30={dms_30:g} 健康"
    return 5, f"dms_30={dms_30:g} 热销"


def _score_trend(dms_7: float | None, dms_30: float | None) -> tuple[int, str]:
    if dms_7 is None or dms_30 is None or dms_30 <= 0:
        return 50, "趋势数据不足"
    ratio = dms_7 / dms_30
    if ratio > TREND_RATIO_UP:
        return 0, f"销量上升（dms_7/dms_30={ratio:.2f}）"
    if ratio >= TREND_RATIO_STABLE:
        return 30, f"销量稳定（dms_7/dms_30={ratio:.2f}）"
    if ratio >= TREND_RATIO_DOWN_MILD:
        return 60, f"销量轻微下降（dms_7/dms_30={ratio:.2f}）"
    return 90, f"销量下降明显（dms_7/dms_30={ratio:.2f}）"


def _score_aging(
    *,
    age_0_90_qty: int,
    age_91_180_qty: int,
    age_181_270_qty: int,
    age_271_365_qty: int,
    age_365_plus_qty: int,
) -> tuple[int, str]:
    total = (
        age_0_90_qty
        + age_91_180_qty
        + age_181_270_qty
        + age_271_365_qty
        + age_365_plus_qty
    )
    if total == 0:
        return 50, "无库存（库龄无意义）"
    if age_365_plus_qty > 0:
        ratio = age_365_plus_qty / total
        return 100, f"1年以上库存 {age_365_plus_qty}（占 {ratio:.0%}）"
    if age_271_365_qty > 0 and (age_271_365_qty / total) >= AGING_271_RATIO:
        ratio = age_271_365_qty / total
        return 90, f"9-12月库存占 {ratio:.0%}"
    if age_181_270_qty > 0 and (age_181_270_qty / total) >= AGING_181_RATIO:
        ratio = age_181_270_qty / total
        return 70, f"6-9月库存占 {ratio:.0%}"
    if age_91_180_qty > 0 and (age_91_180_qty / total) >= AGING_91_RATIO:
        ratio = age_91_180_qty / total
        return 40, f"3-6月库存占 {ratio:.0%}"
    fresh_ratio = age_0_90_qty / total
    return 5, f"新鲜库存占 {fresh_ratio:.0%}"


def _score_transit(available_qty: int, in_transit_qty: int) -> tuple[int, str]:
    if in_transit_qty <= 0:
        return 10, "无在途"
    if available_qty <= 0:
        # 无可用库存 + 在途=将来到货（不能算积压）
        return 30, f"在途 {in_transit_qty}（无可售，到货后缓解）"
    ratio = in_transit_qty / available_qty
    if ratio < TRANSIT_RATIO_LOW:
        return 30, f"在途/可售={ratio:.2f}"
    if ratio < TRANSIT_RATIO_MID:
        return 50, f"在途/可售={ratio:.2f}"
    if ratio < TRANSIT_RATIO_HIGH:
        return 75, f"在途/可售={ratio:.2f}（补货偏多）"
    return 90, f"在途/可售={ratio:.2f}（双重积压）"


# ---------------------------------------------------------------------------
# 方向判定
# ---------------------------------------------------------------------------


def _decide_direction(item: ItemInput) -> tuple[str, list[str]]:
    """
    返回 (direction, reasons)：
      - "missing_data"  dms_30 缺失，listing 疑似有问题
      - "shortage"      断货侧（要补货）
      - "overstock"     滞销侧（要清货）
      - "healthy"       健康（不动）
    """
    reasons: list[str] = []

    # 数据缺失优先于一切：dms_30 是核心，无 dms_30 没法判断健康/滞销
    if item.dms_30 is None:
        return "missing_data", ["dms_30 缺失，无销量数据"]

    # 断货侧判定：listing 在卖（dms_30 > 0）+ 库存不够
    if item.sellable_days is not None and item.sellable_days < DOH_SHORTAGE:
        if item.dms_30 > 0:
            reasons.append(f"dms_30={item.dms_30:g} 在卖但 DoH={item.sellable_days:g}")
            return "shortage", reasons
        # dms_30=0 + DoH 低 → listing 没人买，不是真断货，归到滞销
        reasons.append(f"dms_30=0 无销量，DoH={item.sellable_days:g} 无意义")
        return "overstock", reasons

    # 滞销侧判定：库龄硬指标优先（库龄是滞销的"铁证"）
    total_aging = (
        item.age_0_90_qty
        + item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
    )
    if total_aging > 0:
        if item.age_365_plus_qty > 0:
            reasons.append(f"库龄 365+ 天 {item.age_365_plus_qty}")
            return "overstock", reasons
        if total_aging > 0 and (item.age_271_365_qty / total_aging) >= AGING_271_RATIO:
            reasons.append(f"库龄 271-365 占 {item.age_271_365_qty / total_aging:.0%}")
            return "overstock", reasons
        if total_aging > 0 and (item.age_181_270_qty / total_aging) >= AGING_181_RATIO:
            reasons.append(f"库龄 181-270 占 {item.age_181_270_qty / total_aging:.0%}")
            return "overstock", reasons

    # 销量死货：dms_30=0 且库龄非新（>90 天的货但完全没卖）
    if (
        item.dms_30 == 0
        and item.age_91_180_qty
        + item.age_181_270_qty
        + item.age_271_365_qty
        + item.age_365_plus_qty
        > 0
    ):
        reasons.append("dms_30=0 + 库龄 90+ 天")
        return "overstock", reasons

    # 滞销侧判定：DoH 长
    if item.sellable_days is not None and item.sellable_days >= DOH_OVERSTOCK_MILD:
        if item.dms_30 < VELOCITY_MID:
            reasons.append(
                f"DoH={item.sellable_days:g} 但 dms_30={item.dms_30:g}<{VELOCITY_MID}"
            )
            return "overstock", reasons
        # DoH 长但 dms_30 健康 → 销量高，可能是"待补货"或"大卖品"也算健康边界
        reasons.append(
            f"DoH={item.sellable_days:g} 长但 dms_30={item.dms_30:g} 高，仍算健康边界"
        )

    # 健康
    reasons.append(f"DoH={item.sellable_days:g} dms_30={item.dms_30:g} 库龄正常")
    return "healthy", reasons


# ---------------------------------------------------------------------------
# 程度判定（在方向内分轻重）
# ---------------------------------------------------------------------------


def _grade_shortage(item: ItemInput) -> str:
    """
    断货侧：严重度按 DoH 倒序排（DoH 越小越严重）
      DoH ≤ 7    → 严重（立即补货）
      DoH ≤ 14   → 警示
      DoH < 30   → 边缘
    """
    doh = item.sellable_days
    if doh is None or doh <= 0:
        return "🔴 断货风险"
    if doh <= 7:
        return "🔴 断货风险"
    if doh <= DOH_OOS_RISK:
        return "🟠 短期断货"
    return "🟡 关注"


def _grade_overstock(item: ItemInput) -> str:
    """
    滞销侧：严重度按 库龄 + DoH + 在途冗余 取重
      库龄 365+ 或 DoH>180 或 dms_30=0 或 在途/可售>3 → 严重
      库龄 181+ 或 DoH≥90 且慢销                  → 警示
      其他                                          → 边缘
    """
    # 在途/可售 > 3 + dms_30 慢销 → 严重（双重积压会爆仓）
    if item.available_qty > 0 and item.in_transit_qty > 0:
        ratio = item.in_transit_qty / item.available_qty
        if (
            ratio > TRANSIT_RATIO_HIGH
            and item.dms_30 is not None
            and item.dms_30 < VELOCITY_MID
        ):
            return "⚫ 严重滞销"
    if item.age_365_plus_qty > 0:
        return "⚫ 严重滞销"
    if item.dms_30 == 0:
        return "⚫ 严重滞销"
    if item.sellable_days is not None and item.sellable_days > DOH_OVERSTOCK_STRONG:
        if item.dms_30 is not None and item.dms_30 < VELOCITY_MID:
            return "⚫ 严重滞销"
    if item.sellable_days is not None and item.sellable_days >= 90:
        if item.dms_30 is not None and item.dms_30 < VELOCITY_MID:
            return "🟣 滞销"
    if item.age_181_270_qty > 0 or item.age_271_365_qty > 0:
        return "🟣 滞销"
    return "🟡 关注"


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def assess(item: ItemInput) -> HealthAssessment:
    # 1. 5 轴评分
    doh_score, doh_note = _score_doh(item.sellable_days)
    vel_score, vel_note = _score_velocity(item.dms_30)
    trend_score, trend_note = _score_trend(item.dms_7, item.dms_30)
    aging_score, aging_note = _score_aging(
        age_0_90_qty=item.age_0_90_qty,
        age_91_180_qty=item.age_91_180_qty,
        age_181_270_qty=item.age_181_270_qty,
        age_271_365_qty=item.age_271_365_qty,
        age_365_plus_qty=item.age_365_plus_qty,
    )
    transit_score, transit_note = _score_transit(
        item.available_qty, item.in_transit_qty
    )

    breakdown = ScoreBreakdown(
        doh_score=doh_score,
        velocity_score=vel_score,
        trend_score=trend_score,
        aging_score=aging_score,
        transit_score=transit_score,
        details={
            "doh": doh_note,
            "velocity": vel_note,
            "trend": trend_note,
            "aging": aging_note,
            "transit": transit_note,
        },
    )

    # 2. health_score 加权（保留作为辅助数字）
    health_score = round(
        doh_score * W_DOH
        + vel_score * W_VELOCITY
        + trend_score * W_TREND
        + aging_score * W_AGING
        + transit_score * W_TRANSIT
    )
    health_score = max(0, min(100, health_score))

    # 3. 方向判定（决定动作）
    direction, direction_reasons = _decide_direction(item)

    # 4. 程度判定
    if direction == "missing_data":
        risk_status = "⚪ 数据缺失"
    elif direction == "shortage":
        risk_status = _grade_shortage(item)
    elif direction == "overstock":
        risk_status = _grade_overstock(item)
    else:  # healthy
        # 健康但仍可降级为"关注"——比如 DoH 边缘 + 销量在掉
        if (
            item.sellable_days is not None
            and DOH_HEALTHY_MIN <= item.sellable_days <= 45
            and item.dms_7 is not None
            and item.dms_30 is not None
            and item.dms_30 > 0
            and (item.dms_7 / item.dms_30) < TREND_RATIO_STABLE
        ):
            risk_status = "🟡 关注"
        else:
            risk_status = "🟢 健康库存"

    # 5. 原因聚合：方向原因 + 关键轴扣分
    risk_reasons: list[str] = list(direction_reasons)
    if aging_score >= 70:
        risk_reasons.append(aging_note)
    if doh_score >= 75:
        risk_reasons.append(doh_note)
    if vel_score >= 80:
        risk_reasons.append(vel_note)
    if trend_score >= 60:
        risk_reasons.append(trend_note)
    if transit_score >= 75:
        risk_reasons.append(transit_note)

    return HealthAssessment(
        health_score=health_score,
        direction=direction,
        risk_status=risk_status,
        risk_reasons=risk_reasons,
        breakdown=breakdown,
    )


def assess_many(items: Iterable[ItemInput]) -> list[HealthAssessment]:
    return [assess(item) for item in items]
