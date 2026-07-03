"""metrics — 通用指标计算（v2.2 §3 + §6）。

- 置信度标签（★high / ☆medium / .low / ..none）
- 单位价值（ROAS × Orders / 词数）
- impression_share S1 max 聚合（v2.2 §9.1 反哺 2）
- TopShare 单值校验
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any


def confidence(impressions: int, orders: int) -> str:
    """置信度标签（v2.2 §3.3）。

    ★high  : impressions ≥ 100, orders ≥ 3
    ☆medium: impressions ≥ 20,  orders ≥ 1
    .low    : orders == 1
    ..none  : orders == 0
    """
    if impressions >= 100 and orders >= 3:
        return "★high"
    if impressions >= 20 and orders >= 1:
        return "☆medium"
    if orders == 1:
        return ".low"
    return "..none"


def unit_value(roas: float, orders: int, n_terms: int) -> float:
    """单位价值（v2.2 §6）= ROAS × Orders / 词数。"""
    if n_terms <= 0:
        return 0.0
    return roas * orders / n_terms


def safe_roas(sales: float | None, spend: float | None) -> float:
    """安全 ROAS（spend=0 时返回 0）。"""
    if not spend or spend <= 0:
        return 0.0
    return (sales or 0.0) / spend


def share_max_by_term(rows: list[dict[str, Any]]) -> dict[str, float]:
    """S1 max 聚合 impression_share（v2.2 §9.1）。

    同一 search_term 在不同 ad_group 各有 share → 取 max。
    原因：share 是"该 ad_group 内该搜索词的曝光份额"，
    累加会跨 group 重复（曾出现 547% 异常）。
    """
    bucket: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        t = r.get("search_term")
        s = r.get("impression_share")
        if t and s is not None:
            bucket[t].append(s)
    return {t: max(v) for t, v in bucket.items()}


def aggregate_terms(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """按 search_term 聚合行（多 ad_group 行合并）。

    Returns:
        {term: {impr, clk, spend, sales, orders, ...}}
    """
    bucket: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "impr": 0, "clk": 0, "spend": 0.0, "sales": 0.0, "orders": 0,
        "campaigns": set(), "match_types": set(), "targeting_types": set(),
    })
    for r in rows:
        t = r.get("search_term")
        if not t:
            continue
        d = bucket[t]
        d["impr"] += r.get("impressions", 0) or 0
        d["clk"] += r.get("clicks", 0) or 0
        d["spend"] += r.get("spend", 0) or 0
        d["sales"] += r.get("sales_7d", 0) or 0
        d["orders"] += r.get("orders_7d", 0) or 0
        cn = r.get("campaign_name")
        if cn:
            d["campaigns"].add(cn)
        mt = r.get("match_type")
        if mt:
            d["match_types"].add(mt)
        tt = r.get("targeting_type")
        if tt:
            d["targeting_types"].add(tt)
    # set 不可 hash，转 list 方便 JSON 序列化
    result = {}
    for t, d in bucket.items():
        d2 = dict(d)
        d2["campaigns"] = sorted(d["campaigns"])
        d2["match_types"] = sorted(d["match_types"], key=lambda x: x or "")
        d2["targeting_types"] = sorted(d["targeting_types"], key=lambda x: x or "")
        result[t] = d2
    return result


def judge(value: float, thresholds: dict[str, float], higher_is_better: bool = True) -> str:
    """按阈值判定 4 档等级（优秀 / 良好 / 一般 / 不及格）。

    Args:
        value: 实际值
        thresholds: {excellent, good, fair}（不包含 '不及格'，低于 fair 即不及格）
        higher_is_better: True=越大越好（ROAS/CTR/CVR），False=越小越好（ACOS/CPC）
    """
    exc = thresholds["excellent"]
    good = thresholds["good"]
    fair = thresholds["fair"]
    if higher_is_better:
        if value >= exc:
            return "excellent"
        if value >= good:
            return "good"
        if value >= fair:
            return "fair"
        return "fail"
    else:
        if value <= exc:
            return "excellent"
        if value <= good:
            return "good"
        if value <= fair:
            return "fair"
        return "fail"


if __name__ == "__main__":
    # 自检
    print("=== metrics 自检 ===")
    print("confidence(150, 5)  =", confidence(150, 5), "(期望 ★high)")
    print("confidence(50, 2)   =", confidence(50, 2), "(期望 ☆medium)")
    print("confidence(5, 1)    =", confidence(5, 1), "(期望 .low)")
    print("confidence(10, 0)   =", confidence(10, 0), "(期望 ..none)")
    print()
    print("unit_value(roas=3, orders=10, n=5) =", round(unit_value(3, 10, 5), 2), "(期望 6.0)")
    print()
    sample = [
        {"search_term": "drill bit", "impression_share": 5.0},
        {"search_term": "drill bit", "impression_share": 100.0},
        {"search_term": "cobalt drill bit", "impression_share": 20.0},
    ]
    print("share_max_by_term =", share_max_by_term(sample))
    print()
    thresholds = {"excellent": 25, "good": 35, "fair": 50}
    print("judge(20, acos)  =", judge(20, thresholds, higher_is_better=False), "(期望 excellent)")
    print("judge(30, acos)  =", judge(30, thresholds, higher_is_better=False), "(期望 good)")
    print("judge(45, acos)  =", judge(45, thresholds, higher_is_better=False), "(期望 fair)")
    print("judge(60, acos)  =", judge(60, thresholds, higher_is_better=False), "(期望 fail)")