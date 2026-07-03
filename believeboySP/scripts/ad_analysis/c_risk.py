"""c_risk — 主题 C 风险预警（v2.2 §8）。

C1: 7d vs 30d ROAS 突变 — 活动/搜索词级别异常检测
C2: 无效流量突增 — invalid-traffic 异常
C3: 预算被卡 — budget_utilization_rate > 100% + missed_* 量化
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from . import load_data, metrics


# ── C1: 7d vs 30d ROAS 突变 ──────────────────────────────────

def find_roas_anomalies(
    short_data: list[dict[str, Any]],
    long_data: list[dict[str, Any]],
    *,
    short_label: str = "7d",
    long_label: str = "30d",
    roas_drop_threshold: float = 0.30,  # ROAS 下跌 > 30%
    roas_jump_threshold: float = 0.50,  # ROAS 上涨 > 50%
    min_short_orders: int = 1,
    min_long_orders: int = 1,
) -> dict[str, list[dict[str, Any]]]:
    """找 ROAS 突变的搜索词。

    Returns:
        {
          "drop": [...],   # 短期 ROAS 大幅下跌（预警）
          "jump": [...],   # 短期 ROAS 大幅上涨（机会）
        }
    """
    short_agg = metrics.aggregate_terms(short_data)
    long_agg = metrics.aggregate_terms(long_data)
    all_terms = set(short_agg.keys()) | set(long_agg.keys())

    drop, jump = [], []
    for t in all_terms:
        s = short_agg.get(t, {"spend": 0, "sales": 0, "orders": 0, "impr": 0, "clk": 0})
        l = long_agg.get(t, {"spend": 0, "sales": 0, "orders": 0, "impr": 0, "clk": 0})

        s_roas = s["sales"] / s["spend"] if s["spend"] > 0 else 0
        l_roas = l["sales"] / l["spend"] if l["spend"] > 0 else 0

        # 样本量过滤
        if s["orders"] < min_short_orders or l["orders"] < min_long_orders:
            continue

        # 短期跌 / 长期涨 → 预警
        if s_roas < l_roas * (1 - roas_drop_threshold) and s["spend"] >= 1:
            drop.append({
                "term": t,
                "short_roas": round(s_roas, 2),
                "long_roas": round(l_roas, 2),
                "short_sales": round(s["sales"], 2),
                "long_sales": round(l["sales"], 2),
                "short_orders": s["orders"],
                "long_orders": l["orders"],
                "short_spend": round(s["spend"], 2),
                "drop_pct": round((l_roas - s_roas) / l_roas * 100, 1) if l_roas > 0 else 0,
            })

        # 短期涨 / 长期跌 → 机会
        if s_roas > l_roas * (1 + roas_jump_threshold) and s["spend"] >= 1 and s["orders"] >= 1:
            jump.append({
                "term": t,
                "short_roas": round(s_roas, 2),
                "long_roas": round(l_roas, 2),
                "short_sales": round(s["sales"], 2),
                "long_sales": round(l["sales"], 2),
                "short_orders": s["orders"],
                "long_orders": l["orders"],
                "short_spend": round(s["spend"], 2),
                "jump_pct": round((s_roas - l_roas) / l_roas * 100, 1) if l_roas > 0 else 0,
            })

    drop.sort(key=lambda x: -x["short_spend"])
    jump.sort(key=lambda x: -x["jump_pct"])
    return {"drop": drop, "jump": jump}


# ── C2: 无效流量突增 ──────────────────────────────────

def find_invalid_traffic_alerts(
    invalid_traffic: list[dict[str, Any]],
    *,
    high_rate_threshold: float = 20.0,  # > 20% 视为异常（注意：API 返回的 rate 已是百分数）
) -> list[dict[str, Any]]:
    """找无效流量异常的活动。

    注意：API 返回的 `invalid_impression_rate` / `invalid_click_rate` 已是百分数
    （如 36.73 表示 36.73%），不是小数。所以阈值用 20.0 不是 0.20。

    Args:
        invalid_traffic: ad-invalid-traffic data[]
        high_rate_threshold: 阈值（百分数，如 20.0 表示 20%）
    """
    alerts = []
    for r in invalid_traffic:
        rate = r.get("invalid_impression_rate")
        click_rate = r.get("invalid_click_rate")
        total_impr = r.get("total_impressions", 0) or 0
        invalid_impr = r.get("invalid_impressions", 0) or 0
        status = r.get("status")

        if rate is not None and rate >= high_rate_threshold:
            alerts.append({
                "campaign": r.get("campaign_name"),
                "total_impressions": total_impr,
                "invalid_impressions": invalid_impr,
                "invalid_impression_rate": round(rate, 2),  # 已是百分数
                "invalid_click_rate": round(click_rate, 2) if click_rate is not None else None,
                "status": status,
                "rule": f"invalid_impression_rate >= {high_rate_threshold:.0f}%",
            })

    alerts.sort(key=lambda x: -x["invalid_impression_rate"])
    return alerts


# ── C3: 预算被卡检测 ──────────────────────────────────

def find_budget_constraints(
    budgets: list[dict[str, Any]],
    *,
    utilization_threshold: float = 1.0,  # > 100% 表示被卡
    min_missed_sales: float = 5.0,
) -> list[dict[str, Any]]:
    """找预算被卡的活动（util_rate > 100% + missed_sales 显著）。"""
    constraints = []
    for r in budgets:
        util = r.get("budget_utilization_rate")
        if util is None or util <= utilization_threshold:
            continue
        missed_sales_max = r.get("missed_sales_max", 0) or 0
        if missed_sales_max < min_missed_sales:
            continue
        sp = r.get("spend", 0) or 0
        sa = r.get("sales_7d", 0) or 0
        roas = sa / sp if sp > 0 else 0
        constraints.append({
            "campaign": r.get("campaign_name"),
            "budget": r.get("budget", 0) or 0,
            "spend": round(sp, 2),
            "sales": round(sa, 2),
            "roas": round(roas, 2),
            "util_rate": round(util * 100, 2),
            "missed_sales_min": round(r.get("missed_sales_min", 0) or 0, 2),
            "missed_sales_max": round(missed_sales_max, 2),
            "missed_impressions_max": r.get("missed_impressions_max", 0) or 0,
            "missed_clicks_max": r.get("missed_clicks_max", 0) or 0,
        })

    constraints.sort(key=lambda x: -x["missed_sales_max"])
    return constraints


# ── 拉数据（multi-period） ──────────────────────────────────

def fetch_short_long(
    project_id: int,
    country: str,
    endpoint: str,
    short_period: str = "7d",
    long_period: str = "30d",
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """拉短期 + 长期数据。"""
    short = load_data.fetch(project_id, endpoint, country, short_period)["data"]
    long = load_data.fetch(project_id, endpoint, country, long_period)["data"]
    return short, long


# ── CLI ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="C 风险预警（C1+C2+C3）")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--long-period", default="30d", help="长期周期（默认 30d）")
    parser.add_argument("--short-period", default="7d", help="短期周期（默认 7d）")
    parser.add_argument("--top", type=int, default=15, help="每档显示 Top N")
    args = parser.parse_args()

    print(f"\n=== C 风险预警（{args.short_period} vs {args.long_period}, {args.country}）===")

    # C1: 7d vs 30d ROAS 突变
    print(f"\n[C1] {args.short_period} vs {args.long_period} ROAS 突变")
    print("-" * 80)
    short_st, long_st = fetch_short_long(
        args.project, args.country, "search_terms",
        args.short_period, args.long_period,
    )
    c1 = find_roas_anomalies(short_st, long_st,
                              short_label=args.short_period,
                              long_label=args.long_period)
    print(f"  下跌预警: {len(c1['drop'])} 词 | 上涨机会: {len(c1['jump'])} 词")

    if c1["drop"]:
        print(f"\n  下跌预警 Top {args.top}（按短期 spend 排序，建议立即诊断）:")
        print(f"  {'搜索词':<40}{'短期ROAS':>10}{'长期ROAS':>10}{'跌幅%':>8}{'短花':>8}{'短单':>5}{'短销':>8}")
        for c in c1["drop"][:args.top]:
            t = c["term"][:38] if c["term"] else "(空)"
            print(f"  {t:<40}{c['short_roas']:>10.2f}{c['long_roas']:>10.2f}{c['drop_pct']:>7.1f}%{c['short_spend']:>8.2f}{c['short_orders']:>5}{c['short_sales']:>8.2f}")

    if c1["jump"]:
        print(f"\n  上涨机会 Top {args.top}（按涨幅排序，可能新爆品）:")
        print(f"  {'搜索词':<40}{'短期ROAS':>10}{'长期ROAS':>10}{'涨幅%':>8}{'短花':>8}{'短单':>5}{'短销':>8}")
        for c in c1["jump"][:args.top]:
            t = c["term"][:38] if c["term"] else "(空)"
            print(f"  {t:<40}{c['short_roas']:>10.2f}{c['long_roas']:>10.2f}{c['jump_pct']:>7.1f}%{c['short_spend']:>8.2f}{c['short_orders']:>5}{c['short_sales']:>8.2f}")

    # C2: 无效流量
    print(f"\n[C2] 无效流量异常")
    print("-" * 80)
    invalid = load_data.fetch(args.project, "invalid_traffic", args.country, args.long_period)["data"]
    c2 = find_invalid_traffic_alerts(invalid)
    print(f"  异常活动: {len(c2)} 个（invalid_impression_rate >= 20%）")
    if c2:
        print(f"\n  {'#':<4}{'Campaign':<22}{'总曝光':>10}{'无效曝光':>10}{'无效曝光率%':>13}{'状态':<10}")
        for i, c in enumerate(c2[:args.top], 1):
            cn = (c["campaign"] or "")[:20]
            print(f"  {i:<4}{cn:<22}{c['total_impressions']:>10}{c['invalid_impressions']:>10}{c['invalid_impression_rate']:>12.2f}%{(c['status'] or ''):<10}")
        print(f"\n  > 注：invalid_impression_rate 是 API 返回的百分数（>20% 提示异常）")

    # C3: 预算被卡
    print(f"\n[C3] 预算被卡")
    print("-" * 80)
    budgets = load_data.fetch(args.project, "budgets", args.country, args.long_period)["data"]
    c3 = find_budget_constraints(budgets)
    print(f"  被卡活动: {len(c3)} 个（util > 100% + missed_sales ≥ $5）")
    if c3:
        print(f"\n  {'#':<4}{'Campaign':<22}{'预算':>7}{'实际':>7}{'ROAS':>6}{'利用率%':>9}{'missed_sales_max':>17}{'损失销售max':>14}")
        for i, c in enumerate(c3[:args.top], 1):
            cn = (c["campaign"] or "")[:20]
            print(f"  {i:<4}{cn:<22}{c['budget']:>7.2f}{c['spend']:>7.2f}{c['roas']:>6.2f}{c['util_rate']:>8.2f}%{c['missed_sales_min']:>8.2f}~{c['missed_sales_max']:<7.2f}{c['missed_sales_max']:>14.2f}")


if __name__ == "__main__":
    main()