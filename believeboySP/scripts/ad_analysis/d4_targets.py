"""d4_targets — D4 提价机会（v2.2 §9.5）。

筛选逻辑：
  1. ad-targets 30d 拉取
  2. 强信号：ROAS≥3 + TopShare<5%（v2.2 反哺 5，成熟店更严）+ conf≥medium
  3. 按 ROAS × Orders 排序
"""
from __future__ import annotations

import argparse
from typing import Any

from . import load_data, metrics


def find_d4_strong(
    targets: list[dict[str, Any]],
    *,
    min_roas: float = 3.0,
    max_top_share: float = 5.0,
    require_confidence: tuple[str, ...] = ("★high", "☆medium"),
) -> list[dict[str, Any]]:
    """找出 D4 强信号（提价机会）。"""
    candidates = []
    for r in targets:
        roas = r.get("roas", 0) or 0
        if roas <= 0:
            continue
        if roas < min_roas:
            continue
        ts = r.get("top_of_search_impression_share")
        if ts is None or ts >= max_top_share:
            continue
        impr = r.get("impressions", 0) or 0
        od = r.get("orders_7d", 0) or 0
        conf = metrics.confidence(impr, od)
        if conf not in require_confidence:
            continue
        candidates.append({
            "campaign": r.get("campaign_name"),
            "ad_group": r.get("ad_group_name"),
            "target_text": r.get("target_text"),
            "match_type": r.get("match_type"),
            "impressions": impr,
            "spend": round(r.get("spend", 0) or 0, 2),
            "sales": round(r.get("sales_7d", 0) or 0, 2),
            "orders": od,
            "roas": round(roas, 2),
            "top_share": ts,
            "confidence": conf,
        })

    candidates.sort(key=lambda x: (0 if x["confidence"] == "★high" else 1, -x["roas"] * x["orders"]))
    return candidates


def main():
    parser = argparse.ArgumentParser(description="D4 提价机会")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--top", type=int, default=15, help="显示 Top N")
    args = parser.parse_args()

    cfg = load_data.load_config(args.project)
    thresholds = cfg.get("d_signals", {}).get("d4", {})

    data = load_data.fetch(args.project, "targets", args.country, args.period)
    rows = data.get("data", [])
    if not rows:
        print("无 targets 数据")
        return

    strong = find_d4_strong(
        rows,
        min_roas=thresholds.get("min_roas", 3.0),
        max_top_share=thresholds.get("max_top_share", 5.0),
    )

    print(f"\n=== D4 强信号（ROAS≥{thresholds.get('min_roas', 3.0)} + TopShare<{thresholds.get('max_top_share', 5.0)}% + conf≥medium）===")
    print(f"命中: {len(strong)}")

    print(f"\n{'#':<4}{'Conf':<9}{'Campaign':<22}{'AdGroup':<20}{'Target':<18}{'曝光':>7}{'花费':>7}{'销售':>7}{'订单':>5}{'ROAS':>6}{'TopShare%':>11}")
    for i, c in enumerate(strong[:args.top], 1):
        cn = (c["campaign"] or "")[:20]
        ag = (c["ad_group"] or "")[:18]
        tt = (c["target_text"] or "")[:16]
        ts = f"{c['top_share']}%"
        print(f"{i:<4}{c['confidence']:<9}{cn:<22}{ag:<20}{tt:<18}{c['impressions']:>7}{c['spend']:>7.2f}{c['sales']:>7.2f}{c['orders']:>5}{c['roas']:>6.2f}{ts:>11}")


if __name__ == "__main__":
    main()