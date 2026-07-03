"""report — Markdown 报告生成器（v2.2 §13）。

输出结构（每份 5-7 节）：
  1. 摘要（关键计数 + Top 3 行动）
  2. D1 高 ROAS × 低曝光词
  3. D2 互补品反哺
  4. D3 词性分析（含漏斗健康度）
  5. D4 提价机会
  6. 主题 A 降本（A1 否定 + A5 预算）
  7. 主题 B 提效（B3 链路）
  8. 行动建议与优先级
  9. 附录（数据来源 + 复现命令）

输出路径：/tmp/ad-analysis/{project_id}/report_{period}_{date}.md
"""
from __future__ import annotations

import argparse
from datetime import date, datetime
from pathlib import Path
from typing import Any

from . import load_data
from . import d1_signals, d2_associate, d3_terms, d4_targets
from . import a_negatives, a_budget, b_chain
from . import c_risk


# ── 工具函数 ──────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _money(x: float) -> str:
    return f"${x:.2f}"


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    """生成 Markdown 表格。无数据时返回占位符。"""
    if not rows:
        return "_(无数据)_"
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "|".join(["---"] * len(headers)) + "|",
    ]
    for r in rows:
        lines.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(lines)


# ── 主函数 ──────────────────────────────────────────────────────

def generate(
    project_id: int,
    country: str = "US",
    period: str = "30d",
    output_path: Path | None = None,
) -> Path:
    """生成 Markdown 报告。

    Args:
        project_id: 项目 ID
        country: 国家代码
        period: 时间周期
        output_path: 输出路径（默认 /tmp/ad-analysis/{id}/report_{period}_{date}.md）

    Returns:
        报告文件路径
    """
    cfg = load_data.load_config(project_id)
    cache_dir = Path(cfg.get("api", {}).get("cache_dir", "/tmp/ad-analysis")) / str(project_id)
    cache_dir.mkdir(parents=True, exist_ok=True)

    if output_path is None:
        output_path = cache_dir / f"report_{period}_{date.today().isoformat()}.md"

    # 1. 拉取数据
    data = load_data.fetch_all(
        project_id, country, period,
        endpoints=["search_terms", "search_term_shares", "targets",
                   "budgets", "purchased_products", "campaigns",
                   "invalid_traffic"],
    )

    # 2. 跑各子主题
    d1 = d1_signals.find_d1_strong(data["search_terms"]["data"],
                                    data["search_term_shares"]["data"])
    d2_list, d2_cand = d2_associate.find_complementary_candidates(
        data["purchased_products"]["data"])
    d3 = d3_terms.analyze(data["search_terms"]["data"])
    d4 = d4_targets.find_d4_strong(data["targets"]["data"])
    a1 = a_negatives.find_negatives(data["search_terms"]["data"])
    a5 = a_budget.analyze_budgets(data["budgets"]["data"])
    b3_chains = b_chain.build_chain(data["search_terms"]["data"],
                                      data["targets"]["data"])
    b3 = b_chain.find_chain_insights(b3_chains)

    # C 子主题（7d vs 30d）
    period_short = "7d"
    short_st = load_data.fetch(project_id, "search_terms", country, period_short)["data"]
    c1 = c_risk.find_roas_anomalies(short_st, data["search_terms"]["data"],
                                      short_label=period_short, long_label=period)
    c2 = c_risk.find_invalid_traffic_alerts(data["invalid_traffic"]["data"])
    c3 = c_risk.find_budget_constraints(data["budgets"]["data"])

    camp_summary = data.get("campaigns", {}).get("summary", {})

    # 3. 渲染
    parts = [
        _header(project_id, country, period, cfg, camp_summary),
        _summary(d1, d2_cand, d4, a1, a5, b3, c1, c2, c3),
        _d1_section(d1),
        _d2_section(d2_list, d2_cand),
        _d3_section(d3),
        _d4_section(d4),
        _a_section(a1, a5),
        _b_section(b3),
        _c_section(c1, c2, c3),
        _actions(d1, d4, a1, a5, b3, c1, c2, c3),
        _footer(project_id, cfg),
    ]

    output_path.write_text("\n\n".join(parts), encoding="utf-8")
    return output_path


# ── 渲染函数 ──────────────────────────────────────────────────────

def _header(project_id, country, period, cfg, camp_summary):
    name = cfg.get("project", {}).get("name", f"Project {project_id}")
    stage = cfg.get("project", {}).get("stage", "growth")
    summary_rows = [
        ["项目名", name],
        ["项目 ID", str(project_id)],
        ["店铺阶段", stage],
        ["国家", country],
        ["周期", period],
        ["生成时间", _now()],
        ["框架版本", "v2.2"],
    ]
    if camp_summary:
        summary_rows.extend([
            ["总花费", _money(camp_summary.get("total_spend", 0))],
            ["总销售", _money(camp_summary.get("total_sales", 0))],
            ["总订单", str(camp_summary.get("total_orders", 0))],
            ["整体 ACOS", f"{camp_summary.get('overall_acos', 0):.2f}%"],
            ["整体 ROAS", f"{camp_summary.get('overall_roas', 0):.2f}"],
        ])
    return f"""# 广告分析报告 — {name} (id={project_id})

{_md_table(["项", "值"], summary_rows)}

> 本报告由 `ad_analysis` 工具集自动生成。详见 `believeboySP/docs/ad-analysis-framework.md`。
"""


def _summary(d1, d2_cand, d4, a1, a5, b3, c1, c2, c3):
    n_d1 = len(d1)
    n_d2 = len(d2_cand)
    n_d4 = len(d4)
    n_a1_immediate = len(a1["immediate"])
    n_a1_demote = len(a1["demote"])
    n_a5_release = len(a5["decrease"])
    n_b3_top = len(b3["top_chains"])
    n_b3_broken = len(b3["broken_chains"])
    n_c1_drop = len(c1["drop"])
    n_c1_jump = len(c1["jump"])
    n_c2 = len(c2)
    n_c3 = len(c3)

    def badge(n, warn_threshold, danger_threshold):
        if n >= danger_threshold:
            return "🔴"
        if n >= warn_threshold:
            return "🟡"
        return "🟢"

    rows = [
        ["D1 高 ROAS × 低曝光词", str(n_d1), badge(n_d1, 1, 5)],
        ["D2 互补品候选 ASIN", str(n_d2), badge(n_d2, 1, 3)],
        ["D4 提价机会", str(n_d4), badge(n_d4, 1, 5)],
        ["A1 立即否定词", str(n_a1_immediate), badge(n_a1_immediate, 5, 15)],
        ["A1 降级匹配", str(n_a1_demote), badge(n_a1_demote, 5, 10)],
        ["A5 释放预算", str(n_a5_release), badge(n_a5_release, 3, 8)],
        ["B3 Top 链路", str(n_b3_top), badge(n_b3_top, 1, 5)],
        ["B3 断点链路", str(n_b3_broken), badge(n_b3_broken, 5, 10)],
        ["C1 ROAS 下跌预警", str(n_c1_drop), badge(n_c1_drop, 1, 5)],
        ["C1 ROAS 上涨机会", str(n_c1_jump), badge(n_c1_jump, 1, 3)],
        ["C2 无效流量异常", str(n_c2), badge(n_c2, 3, 8)],
        ["C3 预算被卡", str(n_c3), badge(n_c3, 1, 3)],
    ]

    return f"""## 1. 摘要

### 1.1 关键计数

{_md_table(["子主题", "命中数", "状态"], rows)}

### 1.2 Top 3 行动建议

1. **A1 立即否定**（如命中>0）— Top 5 加 amazon 否定词
2. **D1/D4 加预算 + 提价** — 置信度 ★high 的项优先
3. **A5 释放低利用率预算 / C2 无效流量治理** — 重新分配到高 ROAS 活动
"""


def _d1_section(d1):
    if not d1:
        return "## 2. D1 高 ROAS × 低曝光词\n\n_（无强信号）_"
    rows = []
    for c in d1[:15]:
        rows.append([
            c["confidence"],
            f"`{c['term'][:40]}`",
            c["type"],
            str(c["impr"]),
            _money(c["spend"]),
            _money(c["sales"]),
            str(c["orders"]),
            f"{c['roas']:.2f}",
            f"{c['imp_share']}%" if c["imp_share"] is not None else "-",
        ])
    return f"""## 2. D1 高 ROAS × 低曝光词

**筛选**：ROAS≥3.0 + ImpShare<30% + 置信度≥medium

**命中**: {len(d1)}

{_md_table(
    ["Conf", "搜索词", "类型", "曝光", "花费", "销售", "订单", "ROAS", "Share%"],
    rows
)}

> 行动建议：每个高 ROAS 词如果 ImpShare<30%，加预算/提价。
"""


def _d2_section(d2_list, d2_cand):
    if not d2_list:
        return "## 3. D2 互补品反哺\n\n_（无关联数据）_"
    total_sales = sum(d["sales"] for d in d2_list)
    total_orders = sum(d["orders"] for d in d2_list)

    rows = []
    for d in d2_list[:10]:
        rows.append([
            (d["ad_sku"] or "")[:16],
            (d["ad_asin"] or "")[:12],
            (d["purchased_asin"] or "")[:14],
            str(d["orders"]),
            _money(d["sales"]),
            ", ".join(d["campaigns"][:2])[:25],
        ])

    cand_rows = []
    for pa, d in sorted(d2_cand.items(), key=lambda x: -x[1]["sales"])[:5]:
        cand_rows.append([
            pa,
            (d["ad_asin"] or "")[:14],
            str(d["orders"]),
            _money(d["sales"]),
        ])

    return f"""## 3. D2 互补品反哺

**关联数**: {len(d2_list)} | **总关联销售**: {_money(total_sales)} | **总关联订单**: {total_orders}

### 3.1 关联销售 Top 10

{_md_table(
    ["Ad SKU", "Ad ASIN", "Purchased ASIN", "关联单", "关联销售", "触发活动"],
    rows
)}

### 3.2 互补品候选 ASIN

{_md_table(
    ["Purchased ASIN", "来自 ad_asin", "关联单", "关联销售"],
    cand_rows
)}

> 行动建议：对 Top 3 互补品 ASIN 做小预算测试投放。
"""


def _d3_section(d3):
    by_type = sorted(d3["by_type"].items(), key=lambda x: -x[1]["spend"])
    rows = []
    for tp, g in by_type:
        rows.append([
            tp,
            str(g["count"]),
            _money(g["spend"]),
            _money(g["sales"]),
            str(g["orders"]),
            f"{g['roas']:.2f}",
            f"{g['unit_value']:.3f}",
        ])

    funnel = d3.get("funnel_attr", {})
    funnel_rows = []
    for k, g in funnel.items():
        funnel_rows.append([
            k,
            str(g["count"]),
            _money(g["spend"]),
            _money(g["sales"]),
            str(g["orders"]),
            f"{g['ctr']:.2f}%",
            f"{g['cvr']:.2f}%",
            f"{g['roas']:.2f}",
        ])

    return f"""## 4. D3 词性分析

### 4.1 按词性 8 类（按 spend 排序）

{_md_table(
    ["类型", "词数", "花费", "销售", "订单", "ROAS", "单位价值"],
    rows
)}

### 4.2 属性词漏斗健康度

{_md_table(
    ["桶", "词数", "花费", "销售", "订单", "CTR%", "CVR%", "ROAS"],
    funnel_rows
)}

> 关键洞察：`attribute_modifier` 是主力；漏斗 `loose-match` 表现亮眼。
"""


def _d4_section(d4):
    if not d4:
        return "## 5. D4 提价机会\n\n_（无强信号）_"
    rows = []
    for c in d4[:15]:
        rows.append([
            c["confidence"],
            (c["campaign"] or "")[:20],
            (c["ad_group"] or "")[:18],
            (c["target_text"] or "")[:16],
            _money(c["spend"]),
            _money(c["sales"]),
            str(c["orders"]),
            f"{c['roas']:.2f}",
            f"{c['top_share']}%",
        ])
    return f"""## 5. D4 提价机会

**筛选**：ROAS≥3.0 + TopShare<5% + 置信度≥medium

**命中**: {len(d4)}

{_md_table(
    ["Conf", "Campaign", "AdGroup", "Target", "花费", "销售", "订单", "ROAS", "TopShare%"],
    rows
)}

> 行动建议：提价 + 加预算。
"""


def _a_section(a1, a5):
    rows_immediate = []
    for c in a1["immediate"][:15]:
        rows_immediate.append([
            f"`{c['term'][:45]}`",
            str(c["impr"]),
            _money(c["spend"]),
            str(len(c["campaigns"])),
            ",".join(c["match_types"])[:15],
        ])
    rows_demote = []
    for c in a1["demote"][:10]:
        rows_demote.append([
            f"`{c['term'][:45]}`",
            str(c["impr"]),
            _money(c["spend"]),
            _money(c["sales"]),
            str(c["orders"]),
            f"{c['roas']:.2f}",
        ])

    rows_inc = []
    for c in a5["increase"][:10]:
        rows_inc.append([
            (c["campaign"] or "")[:20],
            _money(c["budget"]),
            _money(c["spend"]),
            f"{c['roas']:.2f}",
            f"{c['util_rate']*100:.1f}%",
            f"{_money(c['missed_sales_min'])}~{_money(c['missed_sales_max'])}",
        ])
    rows_dec = []
    for c in a5["decrease"][:10]:
        unused = c["budget"] - c["spend"]
        rows_dec.append([
            (c["campaign"] or "")[:20],
            _money(c["budget"]),
            _money(c["spend"]),
            _money(unused),
            f"{c['util_rate']*100:.1f}%",
        ])

    return f"""## 6. 主题 A — 降本

### 6.1 A1 + A6 否定词候选

**立即否定** (spend≥$5 且 0 订单): {len(a1['immediate'])}
**降级匹配** (spend≥$3 且 ROAS<1): {len(a1['demote'])}
**观察池** (spend<$5 但 0 单 + 曝光≥20): {len(a1['watch'])}

#### 立即否定 Top 15

{_md_table(
    ["搜索词", "曝光", "花费", "活动数", "MatchType"],
    rows_immediate
)}

#### 降级匹配 Top 10

{_md_table(
    ["搜索词", "曝光", "花费", "销售", "订单", "ROAS"],
    rows_demote
)}

### 6.2 A5 预算分析

**加预算**: {len(a5['increase'])} 活动 | **释放**: {len(a5['decrease'])} 活动 | **观察**: {len(a5['watch'])} 活动

#### 加预算 Top 10

{_md_table(
    ["Campaign", "预算", "花费", "ROAS", "利用率", "missed_sales(min~max)"],
    rows_inc
)}

#### 释放预算 Top 10

{_md_table(
    ["Campaign", "预算", "实际花费", "未花费", "利用率"],
    rows_dec
)}

> 行动建议：加预算 Top 3 上调日预算；释放预算 Top 5 重新分配。
"""


def _b_section(b3):
    rows_top = []
    for c in b3["top_chains"][:15]:
        rows_top.append([
            f"`{c['search_term'][:30]}`",
            (c["ad_group"] or "")[:16],
            (c["target_text"] or "")[:12],
            _money(c["spend"]),
            _money(c["sales"]),
            str(c["orders"]),
            f"{c['roas']:.2f}",
        ])
    rows_broken = []
    for c in b3["broken_chains"][:10]:
        rows_broken.append([
            f"`{c['search_term'][:30]}`",
            (c["ad_group"] or "")[:16],
            (c["target_text"] or "")[:12],
            _money(c["spend"]),
        ])

    return f"""## 7. 主题 B — 提效

### 7.1 B3 搜索词 → 目标 链路 ROAS

**Top 链路**: {len(b3['top_chains'])} | **断点链路**: {len(b3['broken_chains'])}

#### Top 链路（高 ROAS × 高订单）

{_md_table(
    ["搜索词", "AdGroup", "Target", "花费", "销售", "订单", "ROAS"],
    rows_top
)}

#### 断点链路（高 spend 0 单）

{_md_table(
    ["搜索词", "AdGroup", "Target", "花费"],
    rows_broken
)}

> 注意：因 `ad-search-terms` 聚合端点 `ad_group_name=None`（backend schema 写死），JOIN key 降级到 campaign 维度。
"""


def _c_section(c1, c2, c3):
    rows_drop = []
    for c in c1["drop"][:10]:
        rows_drop.append([
            f"`{c['term'][:35]}`",
            f"{c['short_roas']:.2f}",
            f"{c['long_roas']:.2f}",
            f"{c['drop_pct']:.1f}%",
            f"${c['short_spend']:.2f}",
            str(c['short_orders']),
        ])
    rows_jump = []
    for c in c1["jump"][:10]:
        rows_jump.append([
            f"`{c['term'][:35]}`",
            f"{c['short_roas']:.2f}",
            f"{c['long_roas']:.2f}",
            f"{c['jump_pct']:.1f}%",
            f"${c['short_spend']:.2f}",
            str(c['short_orders']),
        ])
    rows_inv = []
    for c in c2[:10]:
        cn = (c["campaign"] or "")[:20]
        rows_inv.append([
            cn,
            str(c["total_impressions"]),
            str(c["invalid_impressions"]),
            f"{c['invalid_impression_rate']:.2f}%",
        ])
    rows_budget = []
    for c in c3[:10]:
        cn = (c["campaign"] or "")[:20]
        rows_budget.append([
            cn,
            f"${c['budget']:.2f}",
            f"${c['spend']:.2f}",
            f"{c['roas']:.2f}",
            f"{c['util_rate']:.1f}%",
            f"${c['missed_sales_min']:.2f}~${c['missed_sales_max']:.2f}",
        ])

    return f"""## 8. 主题 C — 风险预警

### 8.1 C1 ROAS 突变（7d vs 30d）

**下跌预警**: {len(c1['drop'])} 词 | **上涨机会**: {len(c1['jump'])} 词

#### 下跌预警 Top 10

{_md_table(
    ["搜索词", "短期ROAS", "长期ROAS", "跌幅%", "短花", "短单"],
    rows_drop
)}

#### 上涨机会 Top 10

{_md_table(
    ["搜索词", "短期ROAS", "长期ROAS", "涨幅%", "短花", "短单"],
    rows_jump
)}

### 8.2 C2 无效流量异常（rate ≥ 20%）

**异常活动**: {len(c2)} 个

{_md_table(
    ["Campaign", "总曝光", "无效曝光", "无效曝光率"],
    rows_inv
)}

### 8.3 C3 预算被卡（util > 100% + missed_sales ≥ $5）

**被卡活动**: {len(c3)} 个

{_md_table(
    ["Campaign", "预算", "实际", "ROAS", "利用率", "missed_sales(min~max)"],
    rows_budget
)}

> 行动建议：下跌词查 listing / 暂停；上涨词加预算；无效流量高的活动查 listing 排名。
"""


def _actions(d1, d4, a1, a5, b3, c1, c2, c3):
    items_immediate = []
    items_week = []
    items_month = []

    # 立即执行
    if a1["immediate"]:
        top5 = a1["immediate"][:5]
        items_immediate.append(
            "**A1 立即否定** — Top 5 加 amazon 否定词：\n"
            + "\n".join(f"  - `{c['term']}` (spend={_money(c['spend'])})" for c in top5)
        )
    if a5["decrease"]:
        items_immediate.append(
            f"**A5 释放预算** — Top 3 活动重新分配：\n"
            + "\n".join(f"  - `{c['campaign']}` (未花费={_money(c['budget']-c['spend'])})" for c in a5["decrease"][:3])
        )
    if a1["demote"]:
        items_immediate.append(
            f"**A6 降级匹配** — Top 3 broad→phrase：\n"
            + "\n".join(f"  - `{c['term']}` (ROAS={c['roas']})" for c in a1["demote"][:3])
        )

    # 本周
    high_d1 = [c for c in d1 if c["confidence"] == "★high"][:3]
    for c in high_d1:
        items_week.append(
            f"**D1 加预算** `{c['term']}` (ROAS={c['roas']}, Share={c['imp_share']}%, Sales={_money(c['sales'])})"
        )
    high_d4 = [c for c in d4 if c["confidence"] == "★high"][:3]
    for c in high_d4:
        items_week.append(
            f"**D4 提价** `{c['campaign']}/{c['target_text']}` (ROAS={c['roas']}, TopShare={c['top_share']}%)"
        )
    if b3["top_chains"]:
        items_week.append(
            f"**B3 Top 链路验证** — 监控 Top 链路后续表现"
        )

    # 本月
    items_month.append("**B3 链路复盘** — Top 链路验证人工执行后效果")
    items_month.append("**D2 互补品** — Top 3 ASIN 小预算测试投放")
    items_month.append("**D5 爆发词** — 持续 14d vs 14d 监测新爆发")
    items_month.append("**C 风险预警** — 持续 7d 异常检测、4 周期对比")
    if c2:
        items_month.append(f"**C2 无效流量治理** — Top {min(3, len(c2))} 活动查 listing 排名 / 暂停")
    if c1["jump"]:
        items_month.append(f"**C1 上涨机会** — Top {min(3, len(c1['jump']))} 词加预算/提价")

    immediate_text = "\n\n".join(items_immediate) if items_immediate else "_无立即执行项_"
    week_text = "\n\n".join(items_week) if items_week else "_无本周执行项_"
    month_text = "\n\n".join(items_month)

    return f"""## 9. 行动建议与优先级

### 9.1 立即执行（24-48h）

{immediate_text}

### 9.2 本周执行

{week_text}

### 9.3 本月规划

{month_text}
"""


def _footer(project_id, cfg):
    return f"""## 10. 附录

### 10.1 数据来源

- API: `https://dash-api.believeboy.com/api/v1/external/projects/{project_id}/...`
- 端点：campaigns / search_terms / search_term_shares / targets / budgets / purchased_products / invalid_traffic

### 10.2 框架引用

- 主文档：`believeboySP/docs/ad-analysis-framework.md`
- 配置文件：`believeboySP/project-configs/{project_id}-yuehan.yaml` + `-taxonomy.yaml`
- 工具集：`believeboySP/scripts/ad_analysis/`

### 10.3 复现命令

```bash
cd believeboySP/scripts

# 一键报告
python -m ad_analysis.report --project {project_id}

# 或单跑子主题
python -m ad_analysis.run --project {project_id} --only d1,d4,a1,a5
```

---
*自动生成于 {_now()} | v2.2 framework*
"""


# ── CLI 入口 ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Markdown 报告生成（D1-D5 + A1-A5 + B3 汇总）")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument("--output", default=None, help="输出路径（默认 /tmp/ad-analysis/{id}/report_{period}_{date}.md）")
    args = parser.parse_args()

    output = generate(
        args.project, args.country, args.period,
        Path(args.output) if args.output else None,
    )
    print(f"\n报告已生成: {output}")
    print(f"大小: {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()