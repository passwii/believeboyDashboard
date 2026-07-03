"""a_negatives — 主题 A1 + A6 否定词候选（v2.2 §8）。

逻辑：
  1. 拉 search-terms 30d，按 search_term 聚合
  2. 三档候选：
     - 立即否定：高 spend 且 0 订单（spend > 阈值 且 orders == 0）
     - 降级匹配：高 spend 但低 ROAS（spend 高、roas 低于 good 阈值）
     - 观察池：低 spend 但 0 单（可能是测试期 / 长尾词）
  3. 输出：每个词的 spend / sales / roas + 触发规则
"""
from __future__ import annotations

import argparse
from typing import Any

from . import load_data, metrics


def find_negatives(
    search_terms: list[dict[str, Any]],
    *,
    min_spend_immediate: float = 5.0,    # 立即否定 spend 阈值
    min_spend_demote: float = 3.0,       # 降级匹配 spend 阈值
    roas_demote_threshold: float = 1.0,  # 降级 ROAS 阈值（< 1 不赚钱）
    min_orders_demote: int = 0,          # 降级最低订单数
) -> dict[str, list[dict[str, Any]]]:
    """找出三档否定词候选。

    Returns:
        {
          "immediate": [...],   # 立即加入否定
          "demote": [...],      # 降级匹配（broad → phrase / phrase → exact）
          "watch": [...],       # 观察池
        }
    """
    term_agg = metrics.aggregate_terms(search_terms)

    immediate, demote, watch = [], [], []
    for t, d in term_agg.items():
        if not t:
            continue
        sp = d["spend"]
        od = d["orders"]
        roas = d["sales"] / sp if sp > 0 else 0

        # 1. 立即否定：高 spend + 0 订单
        if sp >= min_spend_immediate and od == 0:
            immediate.append({
                "term": t,
                "impr": d["impr"],
                "spend": round(sp, 2),
                "sales": round(d["sales"], 2),
                "orders": od,
                "roas": 0.0,
                "campaigns": d["campaigns"],
                "match_types": d["match_types"],
                "rule": f"spend>={min_spend_immediate} AND orders=0",
            })
        # 2. 降级匹配：高 spend + 低 ROAS（< 1 即亏钱）
        elif sp >= min_spend_demote and roas < roas_demote_threshold and od <= min_orders_demote:
            demote.append({
                "term": t,
                "impr": d["impr"],
                "spend": round(sp, 2),
                "sales": round(d["sales"], 2),
                "orders": od,
                "roas": round(roas, 2),
                "campaigns": d["campaigns"],
                "match_types": d["match_types"],
                "rule": f"spend>={min_spend_demote} AND roas<{roas_demote_threshold}",
            })
        # 3. 观察池：低 spend + 0 单（可能是测试期 / 长尾词）
        elif sp > 0 and sp < min_spend_immediate and od == 0 and d["impr"] >= 20:
            watch.append({
                "term": t,
                "impr": d["impr"],
                "spend": round(sp, 2),
                "sales": 0.0,
                "orders": 0,
                "roas": 0.0,
                "campaigns": d["campaigns"],
                "rule": f"spend<{min_spend_immediate} AND orders=0 AND impr>=20",
            })

    immediate.sort(key=lambda x: -x["spend"])
    demote.sort(key=lambda x: -x["spend"])
    watch.sort(key=lambda x: -x["impr"])
    return {"immediate": immediate, "demote": demote, "watch": watch}


def main():
    parser = argparse.ArgumentParser(description="A1+A6 否定词候选")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--top", type=int, default=15, help="每档显示 Top N")
    args = parser.parse_args()

    data = load_data.fetch(args.project, "search_terms", args.country, args.period)
    result = find_negatives(data["data"])

    print(f"\n=== A 否定词候选（{args.period}, {args.country}）===")
    print(f"立即否定: {len(result['immediate'])} 词（spend>=$5 且 0 订单）")
    print(f"降级匹配: {len(result['demote'])} 词（spend>=$3 且 ROAS<1）")
    print(f"观察池:   {len(result['watch'])} 词（spend<$5 但 0 订单 + 曝光>=20）")

    if result["immediate"]:
        print(f"\n[1] 立即否定 Top {args.top}（按 spend 排序）:")
        print(f"{'#':<4}{'搜索词':<48}{'曝光':>7}{'花费':>7}{'活动数':>6}{'MatchType'}")
        for i, c in enumerate(result["immediate"][:args.top], 1):
            t = c["term"][:45] if c["term"] else "(空)"
            mt = ",".join(c["match_types"])[:18]
            print(f"{i:<4}{t:<48}{c['impr']:>7}{c['spend']:>7.2f}{len(c['campaigns']):>6}{mt}")

    if result["demote"]:
        print(f"\n[2] 降级匹配 Top {args.top}（按 spend 排序，建议 broad→phrase / phrase→exact）:")
        print(f"{'#':<4}{'搜索词':<48}{'曝光':>7}{'花费':>7}{'销售':>7}{'订单':>5}{'ROAS':>6}")
        for i, c in enumerate(result["demote"][:args.top], 1):
            t = c["term"][:45] if c["term"] else "(空)"
            print(f"{i:<4}{t:<48}{c['impr']:>7}{c['spend']:>7.2f}{c['sales']:>7.2f}{c['orders']:>5}{c['roas']:>6.2f}")

    if result["watch"]:
        print(f"\n[3] 观察池 Top {args.top}（按曝光排序，等下一周期复测）:")
        print(f"{'#':<4}{'搜索词':<48}{'曝光':>7}{'花费':>7}")
        for i, c in enumerate(result["watch"][:args.top], 1):
            t = c["term"][:45] if c["term"] else "(空)"
            print(f"{i:<4}{t:<48}{c['impr']:>7}{c['spend']:>7.2f}")


if __name__ == "__main__":
    main()