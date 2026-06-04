"""
Layer 0 — Data Profiler (数据探针)
===================================

在聚合数据之后、正式分析之前，对每种数据源做"体检"：
- 哪些报表有数据 / 没数据
- 每种报表的信号强度（empty / weak / moderate / strong）
- 哪些交叉分析是可行的
- 时序对比信号

输出 DataProfile，供 Strategy Planner 使用。
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.ad_agent import DataProfile
from app.services.ad_agent.config_loader import RegistryConfig, DimensionDef

logger = logging.getLogger(__name__)

# ── 信号强度阈值 ────────────────────────────────────────────────────────────

SIGNAL_EMPTY = "empty"
SIGNAL_WEAK = "weak"
SIGNAL_MODERATE = "moderate"
SIGNAL_STRONG = "strong"

# top-N 行数阈值
TOP_N_WEAK_THRESHOLD = 3
TOP_N_MODERATE_THRESHOLD = 8


def _assess_ad_source_signal(
    report_type: str,
    ad_breakdown: dict[str, dict[str, Any]],
) -> tuple[str, int, list[str]]:
    """评估单种 ad 报表类型的信号强度。

    Returns:
        (signal_strength, record_count, highlights)
    """
    type_data = ad_breakdown.get(report_type, {})
    has_data = type_data.get("has_data", False)
    summary = type_data.get("summary", {})
    top = type_data.get("top", [])
    label = type_data.get("label", report_type)

    if not has_data:
        return SIGNAL_EMPTY, 0, [f"{label}: 无数据"]

    record_count = len(top)
    highlights: list[str] = []

    # 从 summary 中提取关键数字
    total_spend = summary.get("spend", 0)
    total_sales = summary.get("sales_7d", 0)
    total_orders = summary.get("orders_7d", 0)
    roas = summary.get("roas", 0)

    if total_spend > 0:
        highlights.append(f"总花费 ${total_spend:,.2f}")
    if total_sales > 0:
        highlights.append(f"总广告销售 ${total_sales:,.2f}")
    if roas > 0:
        highlights.append(f"ROAS {roas:.2f}")

    # 搜索词浪费高亮
    if report_type == "ad_search_term_report" and top:
        zero_order_terms = [r for r in top if r.get("orders_7d", 0) == 0]
        waste_spend = sum(r.get("spend", 0) for r in zero_order_terms)
        if zero_order_terms:
            highlights.append(
                f"{len(zero_order_terms)} 个零转化词，浪费 ${waste_spend:,.2f}"
            )

    # 预算利用率高亮
    if report_type == "ad_budget_report" and top:
        over_budget = [
            r for r in top
            if r.get("budget", 0) > 0 and r.get("spend", 0) / r["budget"] > 0.9
        ]
        under_budget = [
            r for r in top
            if r.get("budget", 0) > 0 and r.get("spend", 0) / r["budget"] < 0.5
        ]
        if over_budget:
            highlights.append(f"{len(over_budget)} 个 campaign 预算紧张 (>90%)")
        if under_budget:
            highlights.append(f"{len(under_budget)} 个 campaign 预算过剩 (<50%)")

    # 信号强度判定
    if record_count >= TOP_N_MODERATE_THRESHOLD and total_spend > 0:
        signal = SIGNAL_STRONG
    elif record_count >= TOP_N_WEAK_THRESHOLD or total_spend > 0:
        signal = SIGNAL_MODERATE
    else:
        signal = SIGNAL_WEAK

    return signal, record_count, highlights


def _assess_auxiliary_source(
    source_key: str,
    aggregated_data: dict[str, Any],
) -> tuple[str, list[str]]:
    """评估非广告数据源的信号强度。"""
    highlights: list[str] = []

    if source_key == "sales_by_date":
        sales = aggregated_data.get("sales_by_date", [])
        if not sales:
            return SIGNAL_EMPTY, ["销售数据: 无"]
        total_orders = sum(r.get("order_qty", 0) for r in sales)
        total_amount = sum(r.get("sales_amount", 0) for r in sales)
        highlights.append(f"销售: {len(sales)} 天, {total_orders} 单, ${total_amount:,.2f}")
        return (SIGNAL_STRONG if len(sales) >= 5 else SIGNAL_MODERATE), highlights

    if source_key == "inventory_summary":
        inv = aggregated_data.get("inventory_summary", {})
        if not inv or not inv.get("available"):
            return SIGNAL_EMPTY, ["库存数据: 无"]
        highlights.append(f"可用库存 {inv.get('available', 0)}")
        oos = inv.get("out_of_stock_count", 0)
        if oos:
            highlights.append(f"缺货 {oos} SKU")
        return SIGNAL_MODERATE, highlights

    if source_key == "comparison_period":
        comp = aggregated_data.get("comparison_period")
        if not comp:
            return SIGNAL_EMPTY, ["对比期数据: 无"]
        highlights.append(
            f"对比期: {comp.get('period_start', '?')} ~ {comp.get('period_end', '?')}"
        )
        return SIGNAL_MODERATE, highlights

    if source_key == "top_skus":
        skus = aggregated_data.get("top_skus", [])
        if not skus:
            return SIGNAL_EMPTY, ["Top SKU: 无"]
        highlights.append(f"Top {len(skus)} SKU")
        return SIGNAL_MODERATE, highlights

    return SIGNAL_EMPTY, []


def _detect_cross_signals(
    source_signals: dict[str, str],
    ad_breakdown: dict[str, dict[str, Any]],
    aggregated_data: dict[str, Any],
) -> list[str]:
    """识别跨数据源的交叉分析信号。"""
    signals: list[str] = []

    # 搜索词 + 预算都有数据 → 可做预算再分配
    if (
        source_signals.get("ad_search_term_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
        and source_signals.get("ad_budget_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
    ):
        signals.append("搜索词数据 + 预算数据都有强信号，可做「搜索词浪费 → 预算再分配」交叉分析")

    # 库存 + 推广商品 → SKU 生命周期 × 广告
    inv_signal = source_signals.get("inventory_summary", SIGNAL_EMPTY)
    promoted_signal = source_signals.get("ad_promoted_product_report", SIGNAL_EMPTY)
    if inv_signal != SIGNAL_EMPTY and promoted_signal in (SIGNAL_MODERATE, SIGNAL_STRONG):
        signals.append("库存数据 + 推广商品数据都可用，可做「缺货 SKU 是否仍在烧广告」检查")

    # Campaign + 搜索词 → 结构优化
    if (
        source_signals.get("ad_campaign_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
        and source_signals.get("ad_search_term_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
    ):
        signals.append("Campaign + 搜索词数据都充足，可做「Campaign 结构优化」交叉分析")

    # 对比期 + 任何强信号 → 跨周期分析
    comp_signal = source_signals.get("comparison_period", SIGNAL_EMPTY)
    if comp_signal != SIGNAL_EMPTY:
        strong_sources = [k for k, v in source_signals.items() if v == SIGNAL_STRONG]
        if strong_sources:
            signals.append(f"对比期数据可用，{', '.join(strong_sources[:3])} 可做跨周期漂移分析")

    # 搜索词 + 预算 + Campaign 三数据源 → 三角优化
    if (
        source_signals.get("ad_search_term_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
        and source_signals.get("ad_budget_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
        and source_signals.get("ad_campaign_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
    ):
        signals.append("搜索词 + 预算 + Campaign 三数据源都充足，可做三角交叉优化分析")

    # 库存 + 搜索词 → 库存风险联动
    if (
        source_signals.get("inventory_summary", SIGNAL_EMPTY) != SIGNAL_EMPTY
        and source_signals.get("ad_search_term_report") in (SIGNAL_MODERATE, SIGNAL_STRONG)
    ):
        signals.append("库存 + 搜索词数据都可用，可做「缺货 SKU 是否仍有搜索词在花钱」风险检查")

    # 高花费零转化搜索词模式检测
    ad_search_data = ad_breakdown.get("ad_search_term_report", {})
    if ad_search_data.get("has_data"):
        top_terms = ad_search_data.get("top", [])
        multi_campaign_waste = [
            t for t in top_terms
            if t.get("orders_7d", 0) == 0 and t.get("spend", 0) > 10
        ]
        if len(multi_campaign_waste) >= 3:
            signals.append(
                f"发现 {len(multi_campaign_waste)} 个高花费零转化搜索词，需要跨 Campaign 级别排查"
            )

    return signals


def _detect_temporal_signals(
    aggregated_data: dict[str, Any],
) -> dict[str, Any]:
    """检测时序分析信号。"""
    comp = aggregated_data.get("comparison_period")
    ad_by_date = aggregated_data.get("ad_by_date", [])
    sales_by_date = aggregated_data.get("sales_by_date", [])

    return {
        "comparison_period_available": comp is not None,
        "trend_detectable": len(ad_by_date) >= 5 or len(sales_by_date) >= 5,
        "ad_daily_points": len(ad_by_date),
        "sales_daily_points": len(sales_by_date),
        "note": (
            "本期 vs 上期数据完整，可做周期对比分析"
            if comp
            else "无对比期数据，跨周期分析受限"
        ),
    }


def profile_data(
    aggregated_data: dict[str, Any],
    registry: RegistryConfig,
) -> DataProfile:
    """执行数据探针，输出 DataProfile。

    Args:
        aggregated_data: ai_insight_aggregator.to_dict() 的输出
        registry: 维度注册表配置
    """
    ad_breakdown: dict[str, dict[str, Any]] = aggregated_data.get(
        "ad_breakdown_by_type", {}
    )

    # ── 评估每种数据源的信号强度并缓存结果 ───────────────────────────────
    source_assessments: dict[str, tuple[str, int, list[str]]] = {}

    # 广告报表
    for report_type in registry.data_source_registry:
        signal, count, highlights = _assess_ad_source_signal(report_type, ad_breakdown)
        source_assessments[report_type] = (signal, count, highlights)
        logger.debug("Source %s: signal=%s, count=%d", report_type, signal, count)

    # 辅助数据源
    for aux_key in registry.auxiliary_sources:
        signal, highlights = _assess_auxiliary_source(aux_key, aggregated_data)
        # 辅助数据源 count 统一为 0，不影响信号强度计算
        source_assessments[aux_key] = (signal, 0, highlights)

    # 从缓存读取信号强度
    source_signals: dict[str, str] = {
        k: v[0] for k, v in source_assessments.items()
    }

    # ── 评估每个维度的可用性 ──────────────────────────────────────────────
    available: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for dim in registry.dimensions.values():
        # 检查 required_sources
        missing = [
            src for src in dim.required_sources
            if source_signals.get(src) == SIGNAL_EMPTY
        ]

        # 检查 auxiliary_required
        missing_aux = [
            src for src in dim.auxiliary_required
            if source_signals.get(src) == SIGNAL_EMPTY
        ]

        # 检查 comparison 依赖
        if dim.requires_comparison and not aggregated_data.get("comparison_period"):
            missing.append("comparison_period")

        if missing:
            skipped.append({
                "dimension_id": dim.id,
                "name": dim.name,
                "level": dim.level,
                "reason": f"缺少数据源: {', '.join(missing)}",
            })
            continue

        # 计算该维度的综合信号强度
        required_signals = [
            source_signals.get(src, SIGNAL_EMPTY) for src in dim.required_sources
        ]
        optional_signals = [
            source_signals.get(src, SIGNAL_EMPTY)
            for src in dim.optional_sources
            if source_signals.get(src) != SIGNAL_EMPTY
        ]
        all_signals = required_signals + optional_signals
        combined_signal = _combine_signals(all_signals)

        # 收集相关 highlights（从缓存读取，避免重复评估）
        dim_highlights: list[str] = []
        for src in dim.required_sources + dim.optional_sources:
            if src in source_assessments:
                _, _, hls = source_assessments[src]
                dim_highlights.extend(hls)

        # record_count 从缓存获取
        record_count = 0
        if dim.required_sources and dim.required_sources[0] in source_assessments:
            record_count = source_assessments[dim.required_sources[0]][1]

        available.append({
            "dimension_id": dim.id,
            "name": dim.name,
            "level": dim.level,
            "priority": dim.priority,
            "signal_strength": combined_signal,
            "record_count": record_count,
            "highlights": dim_highlights[:5],
            "missing_optional": missing_aux,
        })

    # ── 识别交叉和时序信号 ────────────────────────────────────────────────
    cross_signals = _detect_cross_signals(source_signals, ad_breakdown, aggregated_data)
    temporal_signals = _detect_temporal_signals(aggregated_data)

    # ── 数据源汇总 ────────────────────────────────────────────────────────
    data_source_summary: dict[str, Any] = {}
    for src, signal in source_signals.items():
        label = registry.data_source_registry.get(src, {}).get("label") or \
                registry.auxiliary_sources.get(src, {}).get("label") or src
        data_source_summary[src] = {"label": label, "signal": signal}

    return DataProfile(
        available_dimensions=available,
        skipped_dimensions=skipped,
        cross_dimension_signals=cross_signals,
        temporal_signals=temporal_signals,
        data_source_summary=data_source_summary,
    )


def _combine_signals(signals: list[str]) -> str:
    """将多个信号强度合并为一个。取最低非空值。"""
    if not signals:
        return SIGNAL_EMPTY

    order = {SIGNAL_EMPTY: 0, SIGNAL_WEAK: 1, SIGNAL_MODERATE: 2, SIGNAL_STRONG: 3}
    reverse_order = {v: k for k, v in order.items()}

    non_empty = [order.get(s, 0) for s in signals if s != SIGNAL_EMPTY]
    if not non_empty:
        return SIGNAL_EMPTY

    # 取中位数，但不低于 weak
    non_empty.sort()
    median_idx = len(non_empty) // 2
    median_val = non_empty[median_idx]

    return reverse_order.get(max(median_val, 1), SIGNAL_WEAK)
