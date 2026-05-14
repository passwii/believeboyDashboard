"""Metrics and classification helpers for ad analysis.

Extracted from ad_analysis_service.py (stage 3 refactor).
"""
from __future__ import annotations

from decimal import Decimal

from app.utils.math_utils import DECIMAL_ZERO, round_money, round_ratio, safe_ratio


# ─── Rating / grading ────────────────────────────────────────────────────────


def grade_campaign(*, orders: int, acos: Decimal, clicks: int, spend: Decimal) -> str:
    if orders >= 2 and (acos <= Decimal("0.25") or acos == DECIMAL_ZERO):
        return "A"
    if orders >= 1 and acos <= Decimal("0.35"):
        return "B"
    if clicks >= 5 and orders == 0 and spend >= Decimal("5"):
        return "D"
    if acos > Decimal("0.45"):
        return "C"
    return "Observe"


def grade_product(*, orders: int, acos: Decimal, ctr: Decimal, clicks: int) -> str:
    if orders >= 2 and (acos <= Decimal("0.25") or acos == DECIMAL_ZERO):
        return "\u4e3b\u63a8"
    if orders >= 1 and acos <= Decimal("0.35"):
        return "\u6f5c\u529b"
    if clicks >= 5 and orders == 0:
        return "\u6b62\u635f"
    if ctr < Decimal("0.005"):
        return "\u4f4e\u70b9\u51fb"
    return "\u89c2\u5bdf"


def classify_cross_sell_action(*, sales: Decimal, orders: int) -> str:
    if orders >= 2 or sales >= Decimal("100"):
        return "\u653e\u5927\u5173\u8054"
    if orders >= 1:
        return "\u7ee7\u7eed\u89c2\u5bdf"
    return "\u6682\u65e0\u5173\u8054\u8f6c\u5316"


def classify_product_next_action(
    *,
    grade: str,
    ctr: Decimal,
    clicks: int,
    orders: int,
    cross_sell_action: str,
) -> str:
    if grade == '主推' and cross_sell_action == '放大关联':
        return '优先放量并强化关联承接'
    if grade in {'主推', '潜力'}:
        return '保持放量并继续抢高质量流量'
    if clicks >= 5 and orders == 0:
        return '先查转化承接，再决定是否控量'
    if ctr < Decimal('0.005'):
        return '先优化点击承接，再追加预算'
    return '继续观察'


# ─── Campaign next-action classification ─────────────────────────────────────

# ─── Campaign next-action classification ─────────────────────────────────────


def classify_campaign_next_action(
    *,
    grade: str,
    budget_gap: Decimal,
    cross_sell_sales: Decimal,
    orders: int,
    spend: Decimal,
) -> str:
    if grade == "A" and budget_gap > DECIMAL_ZERO:
        return "\u52a0\u9884\u7b97\u653e\u91cf"
    if grade in {"A", "B"} and (orders > 0 or cross_sell_sales > DECIMAL_ZERO):
        return "\u7a33\u5b9a\u653e\u91cf"
    if grade == "D" or (orders == 0 and spend >= Decimal("10")):
        return "\u6682\u505c\u6392\u67e5"
    if grade == "C":
        return "\u4f18\u5316\u63a7\u91cf"
    return "\u7ee7\u7eed\u89c2\u5bdf"


def classify_search_term_action(
    *,
    orders: int,
    impression_share: Decimal,
    acos: Decimal,
    clicks: int,
) -> str:
    if orders >= 1 and impression_share > DECIMAL_ZERO and impression_share < Decimal("0.08"):
        return "\u63d0\u4e89\u4ef7\u4e89\u4efd\u989d"
    if orders >= 1 and (acos <= Decimal("0.35") or acos == DECIMAL_ZERO):
        return "\u52a0\u8bcd\u653e\u91cf"
    if clicks >= 5 and orders == 0:
        return "\u5426\u8bcd/\u964d\u4ef7"
    return "\u7ee7\u7eed\u89c2\u5bdf"


def classify_target_action(
    *,
    orders: int,
    acos: Decimal,
    clicks: int,
    ctr: Decimal,
    top_share: Decimal,
) -> str:
    if orders >= 1 and (acos <= Decimal("0.35") or acos == DECIMAL_ZERO):
        return "\u4fdd\u7559\u653e\u91cf"
    if clicks >= 5 and orders == 0:
        return "\u964d\u4ef7/\u9694\u79bb"
    if ctr >= Decimal("0.01") and top_share < Decimal("0.01"):
        return "\u63d0\u9ad8\u9996\u9875\u7cfb\u6570"
    return "\u6301\u7eed\u89c2\u5bdf"


def classify_budget_action(
    *,
    utilization: Decimal,
    orders: int,
    acos: Decimal,
    spend: Decimal,
) -> str:
    if utilization < Decimal("0.95"):
        if orders > 0 and (acos <= Decimal("0.35") or acos == DECIMAL_ZERO):
            return "\u4f18\u5148\u52a0\u9884\u7b97"
        if spend >= Decimal("10") and orders == 0:
            return "\u5148\u4f18\u5316\u518d\u52a0\u9884\u7b97"
        return "\u89c2\u5bdf\u9884\u7b97"
    return "\u9884\u7b97\u5145\u8db3"


def classify_budget_next_step(action: str) -> str:
    if action == "\u4f18\u5148\u52a0\u9884\u7b97":
        return "\u4eca\u5929\u8865\u9884\u7b97\uff0c\u4f18\u5148\u4fdd\u969c\u5728\u7ebf\u65f6\u957f\u3002"
    if action == "\u5148\u4f18\u5316\u518d\u52a0\u9884\u7b97":
        return "\u5148\u56de\u770b\u641c\u7d22\u8bcd\u3001\u5165\u53e3\u548c\u5e7f\u544a\u4f4d\u8d28\u91cf\uff0c\u518d\u51b3\u5b9a\u662f\u5426\u8865\u9884\u7b97\u3002"
    if action == "\u89c2\u5bdf\u9884\u7b97":
        return "\u5148\u4fdd\u7559\u5f53\u524d\u9884\u7b97\uff0c\u7ee7\u7eed\u89c2\u5bdf\u8f6c\u5316\u627f\u63a5\u3002"
    return "\u5f53\u524d\u4e0d\u7528\u8c03\u6574\u9884\u7b97\u3002"


# ─── Placement action classification ────────────────────────────────────────


def classify_placement_action(
    *,
    orders: int,
    cvr: Decimal,
    acos: Decimal,
    clicks: int,
    ctr: Decimal,
) -> str:
    if orders >= 1 and cvr >= Decimal("0.08") and (acos <= Decimal("0.35") or acos == DECIMAL_ZERO):
        return "\u53ef\u63d0\u9ad8\u7cfb\u6570"
    if clicks >= 5 and orders == 0:
        return "\u8c28\u614e\u964d\u4ef7"
    if ctr < Decimal("0.005"):
        return "\u6d41\u91cf\u504f\u5f31"
    return "\u6301\u7eed\u89c2\u5bdf"


def classify_placement_next_step(action: str) -> str:
    if action == "\u53ef\u63d0\u9ad8\u7cfb\u6570":
        return "\u53ef\u4ee5\u63d0\u9ad8\u8be5\u5e7f\u544a\u4f4d\u7cfb\u6570\uff0c\u4f18\u5148\u4e89\u53d6\u66f4\u591a\u9ad8\u8d28\u91cf\u66dd\u5149\u3002"
    if action == "\u8c28\u614e\u964d\u4ef7":
        return "\u5148\u4e0b\u8c03\u7cfb\u6570\uff0c\u907f\u514d\u7ee7\u7eed\u5728\u4f4e\u6548\u4f4d\u7f6e\u6d88\u8017\u3002"
    if action == "\u6d41\u91cf\u504f\u5f31":
        return "\u5148\u4e0d\u8981\u62ac\u4ef7\uff0c\u56de\u770b\u7d20\u6750\u548c\u5165\u53e3\u8d28\u91cf\u3002"
    return "\u7ef4\u6301\u5f53\u524d\u7cfb\u6570\uff0c\u7ee7\u7eed\u770b\u91cf\u548c\u8f6c\u5316\u3002"


# ─── Traffic risk classification ─────────────────────────────────────────────


def classify_traffic_risk(*, invalid_click_rate: Decimal, invalid_impression_rate: Decimal) -> str:
    if invalid_click_rate >= Decimal("0.25") or invalid_impression_rate >= Decimal("0.4"):
        return "\u9ad8\u98ce\u9669"
    if invalid_click_rate >= Decimal("0.15") or invalid_impression_rate >= Decimal("0.25"):
        return "\u4e2d\u98ce\u9669"
    return "\u6b63\u5e38"


def classify_traffic_next_action(risk_level: str) -> str:
    if risk_level == "\u9ad8\u98ce\u9669":
        return "\u5148\u6682\u505c\u6392\u67e5\uff0c\u4f18\u5148\u68c0\u67e5\u5f02\u5e38\u5165\u53e3\u548c\u5f02\u5e38\u5e7f\u544a\u4f4d\u3002"
    if risk_level == "\u4e2d\u98ce\u9669":
        return "\u7ee7\u7eed\u76d1\u63a7\uff0c\u5e76\u56de\u770b\u6295\u653e\u5165\u53e3\u662f\u5426\u96c6\u4e2d\u5728\u4f4e\u8d28\u6d41\u91cf\u3002"
    return "\u5f53\u524d\u65e0\u9700\u5904\u7406\uff0c\u4fdd\u6301\u76d1\u63a7\u3002"


# ─── Narrative helpers ───────────────────────────────────────────────────────


def build_issue_card(
    *,
    title: str,
    level: str,
    summary: str,
    drill_to: str,
    next_step: str,
) -> dict[str, str]:
    return {
        "title": title,
        "level": level,
        "summary": summary,
        "drill_to": drill_to,
        "next_step": next_step,
    }


def build_narrative_section(
    *,
    title: str,
    summary: str,
    evidence: list[str],
    action: str | None = None,
    drill_to: str | None = None,
) -> dict[str, object]:
    return {
        "title": title,
        "summary": summary,
        "evidence": evidence,
        "action": action,
        "drill_to": drill_to,
    }