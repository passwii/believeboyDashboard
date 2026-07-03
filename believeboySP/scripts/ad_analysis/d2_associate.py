"""d2_associate — D2 互补品反哺（v2.2 §9.7）。

逻辑：
  1. 拉 ad-purchased-products 90d
  2. 按 (ad_asin, purchased_asin) 聚合关联强度
  3. 找出关联最强的 purchased_asin 作为互补品候选
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from typing import Any

from . import load_data


def find_complementary_candidates(
    purchased_products: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """找出互补品候选 ASIN。

    Args:
        purchased_products: ad-purchased-products data[]

    Returns:
        (sorted_assoc_list, complementary_candidates_by_purchased_asin)
    """
    asoc: dict[tuple[str, str], dict[str, Any]] = defaultdict(lambda: {
        "units": 0, "orders": 0, "sales": 0.0,
        "campaigns": set(), "ad_sku": "", "ad_asin": "", "purchased_asin": "",
    })
    for r in purchased_products:
        aa = r.get("ad_asin")
        pa = r.get("purchased_asin")
        if not aa or not pa:
            continue
        d = asoc[(aa, pa)]
        d["units"] += r.get("other_sku_units_7d", 0) or 0
        d["orders"] += r.get("other_sku_orders_7d", 0) or 0
        d["sales"] += r.get("other_sku_sales_7d", 0) or 0
        c = r.get("campaign_name")
        if c:
            d["campaigns"].add(c)
        d["ad_sku"] = r.get("ad_sku") or ""
        d["ad_asin"] = aa
        d["purchased_asin"] = pa

    # 转 list
    asoc_list = []
    for d in asoc.values():
        d2 = dict(d)
        d2["campaigns"] = sorted(d["campaigns"])
        asoc_list.append(d2)
    asoc_list.sort(key=lambda x: -x["sales"])

    # 互补品候选：按 purchased_asin 去重，取最强
    cand: dict[str, dict[str, Any]] = {}
    for d in asoc_list:
        pa = d["purchased_asin"]
        if pa not in cand or d["sales"] > cand[pa]["sales"]:
            cand[pa] = d
    return asoc_list, cand


def main():
    parser = argparse.ArgumentParser(description="D2 互补品反哺")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="90d", help="时间周期（默认 90d）")
    args = parser.parse_args()

    data = load_data.fetch(args.project, "purchased_products", args.country, args.period)
    rows = data.get("data", [])
    if not rows:
        print("无 purchased-products 数据")
        return

    asoc_list, cand = find_complementary_candidates(rows)
    total_sales = sum(d["sales"] for d in asoc_list)
    total_orders = sum(d["orders"] for d in asoc_list)

    print(f"\n=== D2 互补品反哺 ===")
    print(f"数据行数: {len(rows)} | 关联数: {len(asoc_list)}")
    print(f"总关联销售: ${total_sales:.2f} | 总关联订单: {total_orders}")

    print(f"\n关联销售 Top 10（广告 ASIN → 用户购买 ASIN）:")
    print(f"{'#':<4}{'Ad SKU':<18}{'Ad ASIN':<14}{'Purchased ASIN':<16}{'关联单':>6}{'关联销售':>10}{'触发活动'}")
    for i, d in enumerate(asoc_list[:10], 1):
        ad_sku = (d["ad_sku"] or "")[:16]
        ad_asin = (d["ad_asin"] or "")[:12]
        pa = (d["purchased_asin"] or "")[:14]
        camp = ", ".join(d["campaigns"][:2])[:30]
        print(f"{i:<4}{ad_sku:<18}{ad_asin:<14}{pa:<16}{d['orders']:>6}{d['sales']:>10.2f}{camp}")

    cand_sorted = sorted(cand.items(), key=lambda x: -x[1]["sales"])
    print(f"\n互补品候选 ASIN（按最强关联, Top 5）:")
    for i, (pa, d) in enumerate(cand_sorted[:5], 1):
        ad_asin = (d["ad_asin"] or "")[:14]
        print(f"  #{i}: {pa} (来自 ad_asin={ad_asin}) | ${d['sales']:.2f} | {d['orders']}单")


if __name__ == "__main__":
    main()