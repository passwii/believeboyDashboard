"""d5_burst — D5 爆发词识别（v2.2 §9.6）。

逻辑：
  1. 拉近 14d + 前 14d search-terms 数据
  2. 按 search_term 聚合
  3. 筛选：
     P1: recent_impr > prev_impr × 1.5 AND prev_impr > 0  (频次爆发)
     P2: recent_orders > prev_orders                       (订单爆发)
     P3: recent_sales > prev_sales × 2                     (销售爆发)
     触发：P1 OR (P2 AND P3)
  4. 分类：P1 频次爆发 vs P2+P3 成交爆发
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
from typing import Any

from . import load_data, metrics


def _two_periods(period: str = "14d") -> tuple[tuple[str, str], tuple[str, str]]:
    """生成最近两个周期的 (start, end) 日期对。

    以今天 (假定 = 数据 T-1) 为锚点 — 实际 API 数据以 T-1 结束。
    """
    today = date.today()
    if period == "14d":
        # 最近 14d: [today-14, today-1]（包含 today-1 是 API 数据最后日）
        recent_end = today - timedelta(days=1)
        recent_start = recent_end - timedelta(days=13)  # 14 天
        prev_end = recent_start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=13)
    elif period == "7d":
        recent_end = today - timedelta(days=1)
        recent_start = recent_end - timedelta(days=6)
        prev_end = recent_start - timedelta(days=1)
        prev_start = prev_end - timedelta(days=6)
    else:
        raise ValueError(f"unsupported burst period: {period}")
    return (recent_start.isoformat(), recent_end.isoformat()), (prev_start.isoformat(), prev_end.isoformat())


def find_burst_words(
    recent: list[dict[str, Any]],
    prev: list[dict[str, Any]],
    *,
    p1_impr_ratio: float = 1.5,
    p3_sales_ratio: float = 2.0,
) -> list[dict[str, Any]]:
    """找出爆发词。"""
    recent_agg = metrics.aggregate_terms(recent)
    prev_agg = metrics.aggregate_terms(prev)
    all_terms = set(recent_agg.keys()) | set(prev_agg.keys())

    bursts = []
    for t in all_terms:
        p = prev_agg.get(t, {"impr": 0, "clk": 0, "spend": 0, "sales": 0, "orders": 0})
        r = recent_agg.get(t, {"impr": 0, "clk": 0, "spend": 0, "sales": 0, "orders": 0})
        if p["impr"] == 0 and r["impr"] == 0:
            continue

        p1 = p["impr"] > 0 and r["impr"] > p["impr"] * p1_impr_ratio
        p2 = r["orders"] > p["orders"]
        p3 = p["sales"] > 0 and r["sales"] > p["sales"] * p3_sales_ratio

        if p1 or (p2 and p3):
            trigger = "P1" if p1 else "P2+P3"
            roas = r["sales"] / r["spend"] if r["spend"] > 0 else 0
            bursts.append({
                "term": t,
                "trigger": trigger,
                "prev_impr": p["impr"],
                "recent_impr": r["impr"],
                "impr_ratio": round(r["impr"] / max(p["impr"], 1), 2),
                "prev_sales": round(p["sales"], 2),
                "recent_sales": round(r["sales"], 2),
                "prev_orders": p["orders"],
                "recent_orders": r["orders"],
                "recent_spend": round(r["spend"], 2),
                "recent_roas": round(roas, 2),
            })

    bursts.sort(key=lambda x: -x["recent_sales"])
    return bursts


def main():
    parser = argparse.ArgumentParser(description="D5 爆发词识别")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="14d", help="对比周期（默认 14d）")
    parser.add_argument("--top", type=int, default=25, help="显示 Top N")
    args = parser.parse_args()

    cfg = load_data.load_config(args.project)
    burst_cfg = cfg.get("d_signals", {}).get("d5_burst", {})

    (r_start, r_end), (p_start, p_end) = _two_periods(args.period)

    print(f"\n=== D5 爆发词识别 ===")
    print(f"近 {args.period}: {r_start} ~ {r_end}")
    print(f"前 {args.period}: {p_start} ~ {p_end}")

    recent = load_data.fetch_period(
        args.project, "search_terms", args.country, r_start, r_end
    )["data"]
    prev = load_data.fetch_period(
        args.project, "search_terms", args.country, p_start, p_end
    )["data"]

    bursts = find_burst_words(
        recent, prev,
        p1_impr_ratio=burst_cfg.get("p1_impr_ratio", 1.5),
        p3_sales_ratio=burst_cfg.get("p3_sales_ratio", 2.0),
    )

    p1_count = sum(1 for b in bursts if b["trigger"] == "P1")
    p23_count = sum(1 for b in bursts if b["trigger"] == "P2+P3")
    print(f"\n命中: {len(bursts)} (P1 频次爆发: {p1_count} | P2+P3 成交爆发: {p23_count})")

    print(f"\n{'#':<4}{'Trigger':<10}{'搜索词':<48}{'上曝光':>10}{'近曝光':>10}{'比':>6}{'上销售':>9}{'近销售':>9}{'上单':>5}{'近单':>5}{'近ROAS':>8}")
    for i, b in enumerate(bursts[:args.top], 1):
        t = b["term"][:45] if b["term"] else "(空)"
        print(f"{i:<4}{b['trigger']:<10}{t:<48}{b['prev_impr']:>10}{b['recent_impr']:>10}{b['impr_ratio']:>6.2f}{b['prev_sales']:>9.2f}{b['recent_sales']:>9.2f}{b['prev_orders']:>5}{b['recent_orders']:>5}{b['recent_roas']:>8.2f}")

    # 特别标注 P2+P3 成交爆发（真信号）
    deal_bursts = [b for b in bursts if b["trigger"] == "P2+P3"]
    if deal_bursts:
        print(f"\n★ 成交爆发词（真信号, {len(deal_bursts)}）:")
        for b in deal_bursts:
            print(f"  '{b['term']}' | +{b['recent_orders'] - b['prev_orders']}单 | "
                  f"+${b['recent_sales'] - b['prev_sales']:.2f} 销售 | ROAS={b['recent_roas']}")


if __name__ == "__main__":
    main()