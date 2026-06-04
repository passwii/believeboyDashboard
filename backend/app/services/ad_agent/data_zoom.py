"""
Data Zoom — 针对性数据子集提取器
=================================

在多阶段分析中，Deep-dive 阶段需要精准的数据子集，
而不是将全量数据塞入 prompt。每个 zoom 函数从聚合数据中
提取特定维度所需的最小数据集。
"""
from __future__ import annotations

from typing import Any


def _extract_search_term_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取搜索词 + 关联 campaign 数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_search_term_report": breakdown.get("ad_search_term_report", {}),
        "ad_campaign_report": breakdown.get("ad_campaign_report", {}),
        "ad_search_term_share_report": breakdown.get("ad_search_term_share_report", {}),
    }


def _extract_budget_campaign_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取预算 + campaign 结构数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_budget_report": breakdown.get("ad_budget_report", {}),
        "ad_campaign_report": breakdown.get("ad_campaign_report", {}),
    }


def _extract_sku_performance_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取 SKU 广告表现 + 库存 + 销售数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_promoted_product_report": breakdown.get("ad_promoted_product_report", {}),
        "ad_purchased_product_report": breakdown.get("ad_purchased_product_report", {}),
        "inventory_summary": data.get("inventory_summary", {}),
        "top_skus": data.get("top_skus", []),
    }


def _extract_campaign_health_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取 campaign 结构 + 搜索词 + 投放数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_campaign_report": breakdown.get("ad_campaign_report", {}),
        "ad_search_term_report": breakdown.get("ad_search_term_report", {}),
        "ad_target_report": breakdown.get("ad_target_report", {}),
        "ad_placement_report": breakdown.get("ad_placement_report", {}),
    }


def _extract_placement_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取广告位 + campaign 数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_placement_report": breakdown.get("ad_placement_report", {}),
        "ad_campaign_report": breakdown.get("ad_campaign_report", {}),
    }


def _extract_traffic_quality_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取无效流量 + campaign 数据。"""
    breakdown = data.get("ad_breakdown_by_type", {})
    return {
        "ad_invalid_traffic_report": breakdown.get("ad_invalid_traffic_report", {}),
        "ad_campaign_report": breakdown.get("ad_campaign_report", {}),
    }


def _extract_cross_period_data(data: dict[str, Any], _hotspot: dict) -> dict[str, Any]:
    """提取跨周期分析所需的当前期 + 对比期数据。"""
    return {
        "ad_by_date": data.get("ad_by_date", []),
        "sales_by_date": data.get("sales_by_date", []),
        "comparison_period": data.get("comparison_period"),
    }


# ── 维度 → 提取器映射 ───────────────────────────────────────────────────
ZOOM_EXTRACTORS: dict[str, Any] = {
    # L1 单维度
    "search_term_waste": _extract_search_term_data,
    "budget_utilization": _extract_budget_campaign_data,
    "sku_ad_performance": _extract_sku_performance_data,
    "campaign_health": _extract_campaign_health_data,
    "placement_efficiency": _extract_placement_data,
    "target_effectiveness": _extract_campaign_health_data,
    "invalid_traffic_check": _extract_traffic_quality_data,
    "time_trend_analysis": _extract_cross_period_data,
    "search_term_share_analysis": _extract_search_term_data,
    "purchased_product_analysis": _extract_sku_performance_data,
    # L2 交叉维度
    "budget_reallocation": _extract_budget_campaign_data,
    "sku_lifecycle_ad_fit": _extract_sku_performance_data,
    "campaign_search_target_optimization": _extract_campaign_health_data,
    "placement_campaign_efficiency": _extract_placement_data,
    "search_term_budget_campaign_triple": _extract_budget_campaign_data,
    "inventory_search_term_risk": _extract_search_term_data,
    # L3 跨周期
    "cross_period_search_term_drift": _extract_cross_period_data,
    "cross_period_budget_evolution": _extract_cross_period_data,
    "sku_performance_trajectory": _extract_cross_period_data,
}


def extract_zoomed_data(
    aggregated_data: dict[str, Any],
    hotspot: dict[str, Any],
) -> dict[str, Any]:
    """根据热点维度提取精准数据子集。

    Args:
        aggregated_data: 全量聚合数据
        hotspot: Scout 阶段输出的热点 {"dimension": "...", "severity": "...", "finding": "..."}

    Returns:
        该维度所需的最小数据子集
    """
    dimension = hotspot.get("dimension", "")
    extractor = ZOOM_EXTRACTORS.get(dimension)
    if extractor:
        return extractor(aggregated_data, hotspot)

    # 回退：返回全量 ad_breakdown（但不包含辅助数据，控制 token 量）
    return {
        "ad_breakdown_by_type": aggregated_data.get("ad_breakdown_by_type", {}),
    }
