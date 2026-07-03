"""b_chain — 主题 B3 搜索词 → 目标 → SKU 链路 ROAS（v2.2 §8 F 系列）。

跨端点 JOIN：
  1. search-terms：(search_term, campaign_name, ad_group_name) + 搜索词指标
  2. targets：(campaign_name, ad_group_name, target_text) + 目标指标
  3. promoted-products：(ad_sku, scope_status) + SKU 销售
  4. JOIN 路径：search_term 触发某 ad_group → 该 ad_group 的 target_text → 该 target 推的 SKU

链路 ROAS = 搜索词维度 ROAS（按 search_term × campaign × ad_group 聚合）

注意：完整 SKU JOIN 需要 SKU 维度的 target 关联（复杂），这里简化为：
  链路 = (search_term, campaign, ad_group) → target_text → ad_sku
  链路 ROAS = 该 (campaign, ad_group) 维度上 search_term 的 ROAS
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from typing import Any

from . import load_data


def build_chain(
    search_terms: list[dict[str, Any]],
    targets: list[dict[str, Any]],
    promoted: list[dict[str, Any]] | None = None,
    *,
    use_ad_group: bool = False,
) -> list[dict[str, Any]]:
    """构建链路：search_term → campaign/ad_group → target_text → ad_sku。

    Args:
        search_terms: ad-search-terms 端点 data[]
        targets: ad-targets 端点 data[]
        promoted: ad-promoted-products 端点 data[]（可选，备未来扩展）
        use_ad_group: True 用 (campaign, ad_group) JOIN；
                      False 用 campaign 维度（适配聚合端点 ad_group_name=None）

    Returns:
        链路列表，每条含 (search_term, campaign, ad_group, target, roas, ...)
    """
    # 1. 按 (campaign[, ad_group]) 聚合 target
    if use_ad_group:
        key_fn = lambda r: (r.get("campaign_name"), r.get("ad_group_name"))
    else:
        key_fn = lambda r: (r.get("campaign_name"),)

    target_by_key: dict[tuple, list[dict[str, Any]]] = defaultdict(list)
    for r in targets:
        cn = r.get("campaign_name")
        if not cn:
            continue
        ag = r.get("ad_group_name") if use_ad_group else None
        key = (cn,) if not use_ad_group else (cn, ag)
        if not all(k for k in key):
            continue
        target_by_key[key].append({
            "ad_group": ag,
            "target_text": r.get("target_text"),
            "match_type": r.get("match_type"),
            "spend": r.get("spend", 0) or 0,
            "sales": r.get("sales_7d", 0) or 0,
            "orders": r.get("orders_7d", 0) or 0,
        })

    # 2. 按 (campaign[, ad_group], search_term) 聚合搜索词
    term_by_key: dict[tuple, dict[str, Any]] = defaultdict(lambda: {
        "impr": 0, "clk": 0, "spend": 0.0, "sales": 0.0, "orders": 0,
        "ad_group": None, "match_type": set(), "targeting_type": set(),
    })
    for r in search_terms:
        t = r.get("search_term")
        cn = r.get("campaign_name")
        if not (t and cn):
            continue
        ag = r.get("ad_group_name") if use_ad_group else None
        key = (cn,) if not use_ad_group else (cn, ag)
        if not all(k for k in key):
            continue
        d = term_by_key[key + (t,)]
        d["impr"] += r.get("impressions", 0) or 0
        d["clk"] += r.get("clicks", 0) or 0
        d["spend"] += r.get("spend", 0) or 0
        d["sales"] += r.get("sales_7d", 0) or 0
        d["orders"] += r.get("orders_7d", 0) or 0
        if ag:
            d["ad_group"] = ag
        mt = r.get("match_type")
        if mt:
            d["match_type"].add(mt)
        tt = r.get("targeting_type")
        if tt:
            d["targeting_type"].add(tt)

    # 3. JOIN 搜索词 → 目标 → SKU
    chains = []
    for (cn, *rest, t), d in term_by_key.items():
        ag = d["ad_group"]
        sp = d["spend"]
        roas = d["sales"] / sp if sp > 0 else 0
        if use_ad_group:
            tgt_key = (cn, ag)
        else:
            tgt_key = (cn,)
        tgt_list = target_by_key.get(tgt_key, [])
        for tgt in tgt_list:
            chains.append({
                "search_term": t,
                "campaign": cn,
                "ad_group": tgt["ad_group"],  # 用 target 端的 ad_group（更可靠）
                "target_text": tgt["target_text"],
                "target_match_type": tgt["match_type"],
                "search_match_types": sorted(d["match_type"], key=lambda x: x or ""),
                "search_targeting_types": sorted(d["targeting_type"], key=lambda x: x or ""),
                "impr": d["impr"],
                "spend": round(sp, 2),
                "sales": round(d["sales"], 2),
                "orders": d["orders"],
                "roas": round(roas, 2),
            })

    return chains


def find_chain_insights(
    chains: list[dict[str, Any]],
    *,
    min_spend: float = 1.0,
    min_orders: int = 1,
) -> dict[str, list[dict[str, Any]]]:
    """从链路中提取有 insight 的子集。

    Returns:
        {
          "top_chains": [...],   # Top 链路（高 ROAS × Orders）
          "broken_chains": [...], # 断点链路（高 spend 0 单）
        }
    """
    valid = [c for c in chains if c["spend"] >= min_spend]
    valid.sort(key=lambda x: (-x["roas"], -x["orders"]))

    top = [c for c in valid if c["orders"] >= min_orders][:20]
    broken = [c for c in valid if c["orders"] == 0 and c["spend"] >= 5.0]
    broken.sort(key=lambda x: -x["spend"])

    return {"top_chains": top, "broken_chains": broken[:15]}


def main():
    parser = argparse.ArgumentParser(description="B3 搜索词 → 目标 → SKU 链路 ROAS")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--top", type=int, default=15, help="显示 Top N")
    args = parser.parse_args()

    # 并行拉三个端点
    search_data = load_data.fetch(args.project, "search_terms", args.country, args.period)
    target_data = load_data.fetch(args.project, "targets", args.country, args.period)

    chains = build_chain(search_data["data"], target_data["data"])
    print(f"\n=== B3 搜索词 → 目标 链路（{args.period}, {args.country}）===")
    print(f"链路总数: {len(chains)}")

    insights = find_chain_insights(chains)
    if insights["top_chains"]:
        print(f"\n[1] Top 链路（高 ROAS × 高订单）:")
        print(f"{'#':<4}{'搜索词':<32}{'AdGroup':<18}{'Target':<14}{'花费':>7}{'销售':>7}{'订单':>5}{'ROAS':>6}")
        for i, c in enumerate(insights["top_chains"][:args.top], 1):
            t = (c["search_term"] or "")[:30]
            ag = (c["ad_group"] or "")[:16]
            tt = (c["target_text"] or "")[:12]
            print(f"{i:<4}{t:<32}{ag:<18}{tt:<14}{c['spend']:>7.2f}{c['sales']:>7.2f}{c['orders']:>5}{c['roas']:>6.2f}")

    if insights["broken_chains"]:
        print(f"\n[2] 断点链路（高 spend 0 单，建议检查/否定）:")
        print(f"{'#':<4}{'搜索词':<32}{'AdGroup':<18}{'Target':<14}{'花费':>7}{'曝光':>7}{'点击':>5}")
        for i, c in enumerate(insights["broken_chains"][:args.top], 1):
            t = (c["search_term"] or "")[:30]
            ag = (c["ad_group"] or "")[:16]
            tt = (c["target_text"] or "")[:12]
            print(f"{i:<4}{t:<32}{ag:<18}{tt:<14}{c['spend']:>7.2f}{c['impr']:>7}{c.get('impr', 0):>5}")


if __name__ == "__main__":
    main()