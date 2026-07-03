"""d1_signals — D1 高 ROAS × 低曝光词（v2.2 §9.1）。

筛选逻辑：
  1. search-terms 30d 按 search_term 聚合
  2. impression_share S1 max（v2.2 反哺 2）
  3. 强信号：ROAS≥3 + ImpShare<30% + conf≥medium
"""
from __future__ import annotations

import argparse
from typing import Any

from . import load_data, classify, metrics


def find_d1_strong(
    search_terms: list[dict[str, Any]],
    search_term_shares: list[dict[str, Any]],
    *,
    min_roas: float = 3.0,
    max_imp_share: float = 30.0,
    require_confidence: tuple[str, ...] = ("★high", "☆medium"),
) -> list[dict[str, Any]]:
    """找出 D1 强信号词。

    Args:
        search_terms: ad-search-terms 端点 data[]
        search_term_shares: ad-search-term-shares 端点 data[]
        min_roas: 最小 ROAS 阈值（默认 3.0）
        max_imp_share: 最大 impression_share（默认 30%）
        require_confidence: 允许的最低置信度

    Returns:
        强信号列表，按 ROAS × Orders 降序
    """
    term_agg = metrics.aggregate_terms(search_terms)
    share_max = metrics.share_max_by_term(search_term_shares)
    cls = classify.get_classifier()

    candidates = []
    for t, d in term_agg.items():
        if d["orders"] == 0 or d["spend"] == 0:
            continue
        roas = d["sales"] / d["spend"]
        if roas < min_roas:
            continue
        conf = metrics.confidence(d["impr"], d["orders"])
        if conf not in require_confidence:
            continue
        imp_share = share_max.get(t)
        if imp_share is not None and imp_share >= max_imp_share:
            continue
        candidates.append({
            "term": t,
            "type": cls.classify(t),
            "impr": d["impr"],
            "clk": d["clk"],
            "ctr": round(d["clk"] / d["impr"] * 100, 2) if d["impr"] > 0 else 0,
            "spend": round(d["spend"], 2),
            "sales": round(d["sales"], 2),
            "orders": d["orders"],
            "roas": round(roas, 2),
            "imp_share": imp_share,
            "confidence": conf,
            "campaigns": d["campaigns"],
            "match_types": d["match_types"],
        })

    candidates.sort(key=lambda x: (x["roas"] * x["orders"]), reverse=True)
    return candidates


def main():
    parser = argparse.ArgumentParser(description="D1 高 ROAS × 低曝光词")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--top", type=int, default=25, help="显示 Top N")
    args = parser.parse_args()

    cfg = load_data.load_config(args.project)
    thresholds = cfg.get("d_signals", {}).get("d1", {})

    data = load_data.fetch_all(
        args.project, args.country, args.period,
        endpoints=["search_terms", "search_term_shares"],
    )
    strong = find_d1_strong(
        data["search_terms"]["data"],
        data["search_term_shares"]["data"],
        min_roas=thresholds.get("min_roas", 3.0),
        max_imp_share=thresholds.get("max_imp_share", 30.0),
    )

    print(f"\n=== D1 强信号（ROAS≥{thresholds.get('min_roas', 3.0)} + ImpShare<{thresholds.get('max_imp_share', 30.0)}% + conf≥medium）===")
    print(f"命中: {len(strong)}")
    if not strong:
        return

    print(f"\n{'#':<4}{'Conf':<9}{'搜索词':<35}{'类型':<20}{'曝光':>7}{'花费':>7}{'销售':>7}{'订单':>5}{'ROAS':>6}{'Share%':>8}")
    for i, c in enumerate(strong[:args.top], 1):
        term = c["term"][:32] if c["term"] else "(空)"
        sh = f"{c['imp_share']}%" if c["imp_share"] is not None else "-"
        print(f"{i:<4}{c['confidence']:<9}{term:<35}{c['type']:<20}{c['impr']:>7}{c['spend']:>7.2f}{c['sales']:>7.2f}{c['orders']:>5}{c['roas']:>6.2f}{sh:>8}")


if __name__ == "__main__":
    main()