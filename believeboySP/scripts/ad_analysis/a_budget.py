"""a_budget — 主题 A5 预算利用率 + 加/减预算机会（v2.2 §8）。

逻辑：
  1. 拉 budgets 30d
  2. 计算每个活动的：
     - budget_utilization_rate（实际花费/预算）
     - missed_impressions/sales（被卡的损失）
  3. 三档建议：
     - 加预算：高利用率 + 有 missed_*（>0） → 加预算机会（按 missed_sales_max 量化）
     - 释放预算：低利用率（< 60%） + 高 budget → 释放预算
     - 观察：中等利用率 → 观察
"""
from __future__ import annotations

import argparse
from typing import Any

from . import load_data, metrics


def analyze_budgets(
    budgets: list[dict[str, Any]],
    *,
    high_utilization: float = 100.0,     # > 100% 表示被卡
    low_utilization: float = 60.0,       # < 60% 表示浪费
    min_missed_sales_for_increase: float = 5.0,  # 加预算的最低 missed_sales_max
) -> dict[str, list[dict[str, Any]]]:
    """分析预算利用率 + 加/减预算机会。"""
    increase, decrease, watch = [], [], []

    for r in budgets:
        util = r.get("budget_utilization_rate")
        if util is None:
            continue
        sp = r.get("spend", 0) or 0
        bud = r.get("budget", 0) or 0
        sa = r.get("sales_7d", 0) or 0
        od = r.get("orders_7d", 0) or 0
        roas = sa / sp if sp > 0 else 0

        missed_sales_min = r.get("missed_sales_min", 0) or 0
        missed_sales_max = r.get("missed_sales_max", 0) or 0
        missed_impr_min = r.get("missed_impressions_min", 0) or 0
        missed_impr_max = r.get("missed_impressions_max", 0) or 0
        missed_clicks_min = r.get("missed_clicks_min", 0) or 0
        missed_clicks_max = r.get("missed_clicks_max", 0) or 0

        item = {
            "campaign": r.get("campaign_name"),
            "budget": bud,
            "spend": round(sp, 2),
            "sales": round(sa, 2),
            "orders": od,
            "roas": round(roas, 2),
            "util_rate": round(util, 4),
            "missed_sales_min": round(missed_sales_min, 2),
            "missed_sales_max": round(missed_sales_max, 2),
            "missed_impressions_min": missed_impr_min,
            "missed_impressions_max": missed_impr_max,
            "missed_clicks_min": missed_clicks_min,
            "missed_clicks_max": missed_clicks_max,
            "status": r.get("status"),
        }

        # 1. 加预算：高利用率 + 有 missed_sales
        if util > high_utilization and missed_sales_max >= min_missed_sales_for_increase and roas >= 2:
            increase.append({**item, "rule": f"util>{high_utilization}% AND missed_sales_max>={min_missed_sales_for_increase}"})
        # 2. 释放预算：低利用率 + 有实际预算
        elif util < low_utilization and bud > 0 and sp < bud * low_utilization / 100:
            decrease.append({**item, "rule": f"util<{low_utilization}% AND spend<{low_utilization}% of budget"})
        # 3. 观察：其余
        else:
            watch.append(item)

    increase.sort(key=lambda x: -x["missed_sales_max"])
    decrease.sort(key=lambda x: -(x["budget"] - x["spend"]))
    return {"increase": increase, "decrease": decrease, "watch": watch}


def main():
    parser = argparse.ArgumentParser(description="A5 预算利用率 + 加/减预算")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--top", type=int, default=15, help="每档显示 Top N")
    args = parser.parse_args()

    data = load_data.fetch(args.project, "budgets", args.country, args.period)
    result = analyze_budgets(data["data"])

    print(f"\n=== A 预算分析（{args.period}, {args.country}）===")
    print(f"加预算: {len(result['increase'])} 活动（高利用率 + missed_sales 大）")
    print(f"释放:   {len(result['decrease'])} 活动（低利用率）")
    print(f"观察:   {len(result['watch'])} 活动")

    if result["increase"]:
        print(f"\n[1] 加预算 Top {args.top}（按 missed_sales_max 排序）:")
        print(f"{'#':<4}{'Campaign':<22}{'预算':>7}{'花费':>7}{'销售':>7}{'ROAS':>6}{'利用率%':>9}{'missed_sales(min~max)':>24}")
        for i, c in enumerate(result["increase"][:args.top], 1):
            cn = (c["campaign"] or "")[:20]
            print(f"{i:<4}{cn:<22}{c['budget']:>7.2f}{c['spend']:>7.2f}{c['sales']:>7.2f}{c['roas']:>6.2f}{c['util_rate']*100:>8.2f}%{c['missed_sales_min']:>10.2f}~{c['missed_sales_max']:<10.2f}")

    if result["decrease"]:
        print(f"\n[2] 释放预算 Top {args.top}（按 未花费金额 排序）:")
        print(f"{'#':<4}{'Campaign':<22}{'预算':>7}{'实际花费':>10}{'未花费':>10}{'利用率%':>9}{'ROAS':>6}")
        for i, c in enumerate(result["decrease"][:args.top], 1):
            cn = (c["campaign"] or "")[:20]
            unused = c["budget"] - c["spend"]
            print(f"{i:<4}{cn:<22}{c['budget']:>7.2f}{c['spend']:>10.2f}{unused:>10.2f}{c['util_rate']*100:>8.2f}%{c['roas']:>6.2f}")


if __name__ == "__main__":
    main()