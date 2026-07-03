"""d3_terms — D3 词性 + matchType 矩阵（v2.2 §9.3 + §9.4）。

输出：
  1. 按词性 8 类分组的整体表现（ROAS / 订单 / 销售 / 单位价值）
  2. 词性 × matchType 矩阵
  3. 词性 × targetingType 矩阵
  4. 漏斗健康度（属性词 × close/loose/substitutes/complements）
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from typing import Any

from . import load_data, classify, metrics


def analyze(
    search_terms: list[dict[str, Any]],
) -> dict[str, Any]:
    """完整 D3 分析。

    Returns:
        {
          "by_type": {type: {count, impr, spend, sales, orders, roas, unit_value}},
          "by_match": {(type, match): {...}},
          "by_targeting": {(type, targeting): {...}},
          "funnel_attr": {match/targeting: {...}},
        }
    """
    cls = classify.get_classifier()

    by_type: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "count": 0, "impr": 0, "clk": 0, "spend": 0.0, "sales": 0.0, "orders": 0,
        "terms": set(),
    })
    by_match: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {
        "count": 0, "impr": 0, "clk": 0, "spend": 0.0, "sales": 0.0, "orders": 0,
        "terms": set(),
    })
    by_targeting: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {
        "count": 0, "impr": 0, "clk": 0, "spend": 0.0, "sales": 0.0, "orders": 0,
        "terms": set(),
    })

    for r in search_terms:
        t = r.get("search_term")
        if not t:
            continue
        wtype = cls.classify(t)
        mt = r.get("match_type") or "-"
        tt = r.get("targeting_type") or "-"
        impr = r.get("impressions", 0) or 0
        clk = r.get("clicks", 0) or 0
        sp = r.get("spend", 0) or 0
        sa = r.get("sales_7d", 0) or 0
        od = r.get("orders_7d", 0) or 0

        for g in [by_type[wtype], by_match[(wtype, mt)], by_targeting[(wtype, tt)]]:
            g["count"] += 1
            g["impr"] += impr
            g["clk"] += clk
            g["spend"] += sp
            g["sales"] += sa
            g["orders"] += od
            g["terms"].add(t)

    def finalize(g: dict[str, Any]) -> dict[str, Any]:
        sp = g["spend"]
        sa = g["sales"]
        roas = sa / sp if sp > 0 else 0
        ctr = g["clk"] / g["impr"] * 100 if g["impr"] > 0 else 0
        cvr = g["orders"] / g["clk"] * 100 if g["clk"] > 0 else 0
        n = len(g["terms"])
        return {
            "count": n,
            "spend": round(sp, 2),
            "sales": round(sa, 2),
            "orders": g["orders"],
            "roas": round(roas, 2),
            "ctr": round(ctr, 2),
            "cvr": round(cvr, 2),
            "unit_value": round(metrics.unit_value(roas, g["orders"], n), 3),
            "impressions": g["impr"],
            "clicks": g["clk"],
        }

    out = {
        "by_type": {k: finalize(v) for k, v in by_type.items()},
        "by_match": {f"{k[0]}|{k[1]}": finalize(v) for k, v in by_match.items()},
        "by_targeting": {f"{k[0]}|{k[1]}": finalize(v) for k, v in by_targeting.items()},
    }

    # 漏斗健康度：attribute_modifier × match_type/targeting_type
    funnel = {}
    for mt in ["EXACT", "PHRASE", "BROAD"]:
        key = f"attribute_modifier|{mt}"
        if key in out["by_match"]:
            funnel[f"match_{mt}"] = out["by_match"][key]
    for tt in ["close-match", "substitutes", "loose-match", "complements"]:
        key = f"attribute_modifier|{tt}"
        if key in out["by_targeting"]:
            funnel[f"targeting_{tt}"] = out["by_targeting"][key]
    out["funnel_attr"] = funnel
    return out


def main():
    parser = argparse.ArgumentParser(description="D3 词性 + matchType 矩阵")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    args = parser.parse_args()

    data = load_data.fetch(args.project, "search_terms", args.country, args.period)
    result = analyze(data["data"])

    print(f"\n=== D3 词性分析（{args.period}, {args.country}）===")

    # 1. 按词性 8 类
    by_type = sorted(result["by_type"].items(), key=lambda x: -x[1]["spend"])
    print(f"\n[1] 按词性（按 spend 排序）:")
    print(f"{'类型':<22}{'词数':>6}{'花费':>10}{'销售':>10}{'订单':>5}{'ROAS':>6}{'单位价值':>10}")
    for tp, g in by_type:
        print(f"{tp:<22}{g['count']:>6}{g['spend']:>10.2f}{g['sales']:>10.2f}{g['orders']:>5}{g['roas']:>6.2f}{g['unit_value']:>10.3f}")

    # 2. 漏斗健康度（属性词）
    funnel = result["funnel_attr"]
    if funnel:
        print(f"\n[2] 属性词漏斗健康度:")
        print(f"{'桶':<28}{'词数':>6}{'花费':>10}{'销售':>10}{'订单':>5}{'CTR%':>7}{'CVR%':>7}{'ROAS':>6}")
        for k, g in funnel.items():
            print(f"{k:<28}{g['count']:>6}{g['spend']:>10.2f}{g['sales']:>10.2f}{g['orders']:>5}{g['ctr']:>7.2f}{g['cvr']:>7.2f}{g['roas']:>6.2f}")


if __name__ == "__main__":
    main()