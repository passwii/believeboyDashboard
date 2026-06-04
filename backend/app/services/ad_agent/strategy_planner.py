"""
Layer 1 — Strategy Planner (策略规划器)
========================================

基于 DataProfile + 维度注册表，动态决定：
1. 哪些维度可以分析（数据够不够、信号强度是否达标）
2. 分析的优先级排序
3. 哪些交叉分析可以做（依赖的 Level 1 维度是否都可用）
4. 哪些被跳过了、为什么
5. 生成策略摘要文本
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.ad_agent import DataProfile, AnalysisStrategy
from app.services.ad_agent.config_loader import RegistryConfig, DimensionDef

logger = logging.getLogger(__name__)

# 信号强度阈值映射
SIGNAL_ORDER = {"empty": 0, "weak": 1, "moderate": 2, "strong": 3}
THRESHOLD_MIN = {"minimum": 0, "moderate": 2, "strong": 3}


def _signal_meets_threshold(signal: str, threshold: str) -> bool:
    """检查信号强度是否满足阈值要求。"""
    return SIGNAL_ORDER.get(signal, 0) >= THRESHOLD_MIN.get(threshold, 2)


def _evaluate_dimension(
    dim: DimensionDef,
    data_profile: DataProfile,
    l1_available_ids: set[str],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """评估单个维度是否可用，返回 (available_info, skip_info)。"""
    # 检查 Level 依赖
    if dim.depends_on:
        missing_deps = [dep for dep in dim.depends_on if dep not in l1_available_ids]
        if missing_deps:
            return None, {
                "dimension_id": dim.id,
                "name": dim.name,
                "level": dim.level,
                "reason": f"依赖的维度不可用: {', '.join(missing_deps)}",
            }

    # 检查对比期依赖
    if dim.requires_comparison and not data_profile.temporal_signals.get("comparison_period_available"):
        return None, {
            "dimension_id": dim.id,
            "name": dim.name,
            "level": dim.level,
            "reason": "无对比期数据",
        }

    # 检查数据可用性
    dim_info = next(
        (d for d in data_profile.available_dimensions if d["dimension_id"] == dim.id),
        None,
    )
    if dim_info is None:
        profile_skip = next(
            (s for s in data_profile.skipped_dimensions if s["dimension_id"] == dim.id),
            None,
        )
        return None, {
            "dimension_id": dim.id,
            "name": dim.name,
            "level": dim.level,
            "reason": profile_skip["reason"] if profile_skip else "数据不足",
        }

    # 检查信号阈值
    signal = dim_info["signal_strength"]
    if not _signal_meets_threshold(signal, dim.signal_threshold):
        return None, {
            "dimension_id": dim.id,
            "name": dim.name,
            "level": dim.level,
            "reason": f"信号强度 '{signal}' 未达到阈值 '{dim.signal_threshold}'",
        }

    available = {
        "dimension_id": dim.id,
        "name": dim.name,
        "level": dim.level,
        "priority": dim.priority,
        "signal_strength": signal,
        "highlights": dim_info.get("highlights", []),
        "analysis_hint": dim.analysis_prompt_hint.strip(),
    }
    return available, None


def plan_strategy(
    data_profile: DataProfile,
    registry: RegistryConfig,
) -> AnalysisStrategy:
    """根据数据 profile 和维度注册表，规划分析策略。"""
    # 建立维度信号强度索引
    dim_signals: dict[str, str] = {}
    for dim_info in data_profile.available_dimensions:
        dim_signals[dim_info["dimension_id"]] = dim_info["signal_strength"]

    # ── Phase 1: 筛选可用的 Level 1 维度 ──────────────────────────────────
    l1_available: dict[str, dict[str, Any]] = {}
    l1_skipped: list[dict[str, Any]] = []

    for dim in registry.get_dimensions_by_level(1):
        avail, skip = _evaluate_dimension(dim, data_profile, set())
        if avail:
            l1_available[dim.id] = avail
        elif skip:
            l1_skipped.append(skip)

    # ── Phase 2: 筛选可用的 Level 2 维度（检查依赖）─────────────────────
    l2_available: list[dict[str, Any]] = []
    l2_skipped: list[dict[str, Any]] = []

    for dim in registry.get_dimensions_by_level(2):
        avail, skip = _evaluate_dimension(dim, data_profile, set(l1_available.keys()))
        if avail:
            l2_available.append(avail)
        elif skip:
            l2_skipped.append(skip)

    # ── Phase 3: 筛选可用的 Level 3 维度 ────────────────────────────────
    l3_available: list[dict[str, Any]] = []
    l3_skipped: list[dict[str, Any]] = []

    for dim in registry.get_dimensions_by_level(3):
        avail, skip = _evaluate_dimension(dim, data_profile, set(l1_available.keys()))
        if avail:
            l3_available.append(avail)
        elif skip:
            l3_skipped.append(skip)

    # ── Phase 4: 排序 ──────────────────────────────────────────────────
    primary_sorted = sorted(
        l1_available.values(),
        key=lambda d: (-d["priority"], SIGNAL_ORDER.get(d["signal_strength"], 0)),
    )
    # Cross-analyses get priority boost when their dependencies have strong signals
    for cross in l2_available:
        dep_signals = [dim_signals.get(dep, "empty") for dep in cross.get("depends_on", [])]
        strong_dep_count = sum(1 for s in dep_signals if s == "strong")
        cross["effective_priority"] = cross["priority"] + strong_dep_count * 2
    cross_sorted = sorted(l2_available, key=lambda d: -d.get("effective_priority", d["priority"]))
    temporal_sorted = sorted(l3_available, key=lambda d: -d["priority"])

    all_skipped = l1_skipped + l2_skipped + l3_skipped

    # ── Phase 5: 生成策略摘要 ──────────────────────────────────────────
    summary_parts: list[str] = []
    summary_parts.append(f"本次分析将覆盖 {len(primary_sorted)} 个单维度深挖")
    if cross_sorted:
        summary_parts.append(f"{len(cross_sorted)} 个交叉分析")
    if temporal_sorted:
        summary_parts.append(f"{len(temporal_sorted)} 个跨周期分析")
    if all_skipped:
        summary_parts.append(f"跳过 {len(all_skipped)} 个维度")

    strategy_summary = "，".join(summary_parts) + "。"

    total_passes = len(primary_sorted) + len(cross_sorted) + len(temporal_sorted)

    logger.info(
        "Strategy planned: %d primary, %d cross, %d temporal, %d skipped",
        len(primary_sorted), len(cross_sorted), len(temporal_sorted), len(all_skipped),
    )

    return AnalysisStrategy(
        primary_dimensions=primary_sorted,
        cross_analyses=cross_sorted,
        temporal_analyses=temporal_sorted,
        skipped=all_skipped,
        strategy_summary=strategy_summary,
        estimated_passes=total_passes,
    )
