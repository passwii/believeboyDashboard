"""
Layer 2 — Prompt Assembler (动态 Prompt 组装器)
=================================================

将 AnalysisStrategy 转化为结构化 Prompt。
不再使用单一静态 prompt，而是根据策略动态组装：
  - 策略声明（覆盖哪些维度、跳过哪些、为什么）
  - 每个维度的具体分析指令（来自维度注册表的 analysis_prompt_hint）
  - 交叉分析指令
  - 决策逻辑链要求
  - 输出格式约束
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.services.ad_agent import DataProfile, AnalysisStrategy
from app.services.ad_agent.config_loader import RegistryConfig

logger = logging.getLogger(__name__)


def _build_strategy_declaration(
    strategy: AnalysisStrategy,
    data_profile: DataProfile,
) -> str:
    """构建分析策略声明（输出到报告开头）。"""
    lines: list[str] = []
    lines.append("## 分析策略声明")
    lines.append("")

    # 数据概况
    ds = data_profile.data_source_summary
    available_count = sum(1 for v in ds.values() if v.get("signal") != "empty")
    total_count = len(ds)
    lines.append(f"**数据概况**：{total_count} 种数据源中 {available_count} 种有可用数据。")

    # 覆盖维度
    lines.append("")
    lines.append("**本次分析覆盖维度**：")
    for dim in strategy.primary_dimensions:
        lines.append(f"- 【L1】{dim['name']}（信号: {dim.get('signal_strength', '?')}）")
    for dim in strategy.cross_analyses:
        lines.append(f"- 【L2】{dim['name']}（交叉分析）")
    for dim in strategy.temporal_analyses:
        lines.append(f"- 【L3】{dim['name']}（跨周期分析）")

    # 跳过维度
    if strategy.skipped:
        lines.append("")
        lines.append("**跳过维度及原因**：")
        for skip in strategy.skipped:
            lines.append(f"- {skip['name']}：{skip['reason']}")

    # 交叉分析计划
    if strategy.cross_analyses:
        lines.append("")
        lines.append("**交叉分析计划**：")
        for cross in strategy.cross_analyses:
            deps = cross.get("depends_on", [])
            dep_names = [
                d["name"] for d in strategy.primary_dimensions
                if d["dimension_id"] in deps
            ]
            lines.append(f"- {cross['name']}（依赖: {' + '.join(dep_names) if dep_names else '?'}）")

    # 局限性说明
    lines.append("")
    lines.append("**分析局限性说明**：")
    if not data_profile.temporal_signals.get("comparison_period_available"):
        lines.append("- 无对比期数据，跨周期分析无法执行。")
    if not data_profile.temporal_signals.get("trend_detectable"):
        lines.append("- 时间序列数据点不足，趋势分析可靠性有限。")
    missing_optional = set()
    for dim in strategy.primary_dimensions:
        for m in dim.get("missing_optional", []):
            missing_optional.add(m)
    if missing_optional:
        lines.append(f"- 以下可选数据源缺失，分析深度受限: {', '.join(missing_optional)}")
    if not strategy.skipped and not missing_optional:
        lines.append("- 本次分析数据完整，无明显局限。")

    return "\n".join(lines)


def _build_dimension_instructions(
    strategy: AnalysisStrategy,
    registry: RegistryConfig,
) -> str:
    """为每个要分析的维度构建具体分析指令。"""
    lines: list[str] = []

    # Level 1 指令
    if strategy.primary_dimensions:
        lines.append("### 单维度深挖指令")
        lines.append("")
        for i, dim in enumerate(strategy.primary_dimensions, 1):
            reg_dim = registry.get_dimension(dim["dimension_id"])
            lines.append(f"#### 维度 {i}: {dim['name']}")
            lines.append("")
            if reg_dim and reg_dim.analysis_prompt_hint:
                lines.append(reg_dim.analysis_prompt_hint.strip())
            else:
                lines.append(f"分析 {dim['name']} 的数据，给出发现和建议。")
            lines.append("")

    # Level 2 指令
    if strategy.cross_analyses:
        lines.append("### 交叉分析指令")
        lines.append("")
        lines.append("基于上述单维度分析的发现，执行以下交叉分析。")
        lines.append("**重要**：交叉分析必须引用上面单维度分析中的具体发现和数字，不要独立分析。")
        lines.append("")
        for i, cross in enumerate(strategy.cross_analyses, 1):
            reg_dim = registry.get_dimension(cross["dimension_id"])
            lines.append(f"#### 交叉分析 {i}: {cross['name']}")
            lines.append("")
            if reg_dim and reg_dim.analysis_prompt_hint:
                lines.append(reg_dim.analysis_prompt_hint.strip())
            else:
                deps = cross.get("depends_on", [])
                lines.append(f"综合 {', '.join(deps)} 的发现，给出交叉分析结论。")
            lines.append("")

    # Level 3 指令
    if strategy.temporal_analyses:
        lines.append("### 跨周期分析指令")
        lines.append("")
        lines.append("利用对比期数据，执行以下时序分析：")
        lines.append("")
        for i, temp in enumerate(strategy.temporal_analyses, 1):
            reg_dim = registry.get_dimension(temp["dimension_id"])
            lines.append(f"#### 跨周期分析 {i}: {temp['name']}")
            lines.append("")
            if reg_dim and reg_dim.analysis_prompt_hint:
                lines.append(reg_dim.analysis_prompt_hint.strip())
            lines.append("")

    return "\n".join(lines)


def assemble_system_prompt(
    strategy: AnalysisStrategy,
    data_profile: DataProfile,
    registry: RegistryConfig,
) -> str:
    """组装完整的系统 prompt。"""
    global_strategy = registry.global_strategy
    roles = global_strategy.get("roles", [])
    output_rules = global_strategy.get("output_rules", {})
    decision_chain = global_strategy.get("decision_chain_template", {})

    parts: list[str] = []

    # ── 角色定义 ──────────────────────────────────────────────────────
    parts.append("你是一位资深的")
    role_names = [r["name"] for r in roles]
    parts.append("，同时是".join(role_names) if len(role_names) > 1 else role_names[0] if role_names else "数据分析师")
    parts.append("。")
    parts.append("")
    for role in roles:
        parts.append(f"- **{role['name']}**：专注{role['focus']}")
    parts.append("")

    # ── 任务描述 ──────────────────────────────────────────────────────
    parts.append("## 你的任务")
    parts.append("")
    parts.append("基于以下提供的【项目数据】和【分析策略声明】，输出**可被运营团队直接采纳**的洞察报告和行动建议。")
    parts.append("")
    parts.append("你必须严格按照【分析策略声明】中列出的维度进行分析，不要跳过已声明的维度，也不要添加未声明的维度。")
    parts.append("")

    # ── 维度分析指令 ──────────────────────────────────────────────────
    dim_instructions = _build_dimension_instructions(strategy, registry)
    if dim_instructions:
        parts.append("## 分析维度与指令")
        parts.append("")
        parts.append(dim_instructions)

    # ── 决策逻辑链要求 ────────────────────────────────────────────────
    parts.append("## 决策逻辑链要求")
    parts.append("")
    parts.append("每条建议必须包含完整的决策逻辑链：")
    parts.append("")
    parts.append("1. **发现**：你在数据中看到了什么（具体数字）")
    parts.append("2. **量化影响**：这个发现的影响有多大（金额、百分比、占比）")
    parts.append("3. **建议动作**：具体应该做什么（操作对象 + 操作内容 + 具体数字）")
    parts.append("4. **预期效果**：执行后预期带来什么改善")
    parts.append("")

    if decision_chain.get("example"):
        ex = decision_chain["example"]
        parts.append("示例：")
        parts.append(f"> - 发现：{ex.get('finding', '')}")
        parts.append(f"> - 影响：{ex.get('impact', '')}")
        parts.append(f"> - 建议：{ex.get('action', '')}")
        parts.append(f"> - 预期：{ex.get('expected_outcome', '')}")
        parts.append("")

    # ── 输出格式约束 ──────────────────────────────────────────────────
    parts.append("## 输出格式要求")
    parts.append("")
    parts.append(f"- 语言：{output_rules.get('language', 'zh-CN')}")
    parts.append(f"- 格式：{output_rules.get('format', 'markdown')}")
    parts.append(f"- 数字保留 {output_rules.get('number_precision', 2)} 位小数")
    parts.append("- 百分比使用 % 符号")
    parts.append("- 标题、段落、表格、图表之间留空行")
    parts.append("- 表格使用标准 Markdown 表格")
    parts.append("")
    parts.append("图表格式：")
    parts.append("- 折线图：```lineChart fenced code block")
    parts.append("- 饼图：```pieChart fenced code block")
    parts.append("- 柱状图：```barChart fenced code block")
    parts.append("- 告警：```alert fenced code block（不要用 ASCII 边框）")
    parts.append("")
    parts.append("输出前自检：")
    parts.append("- 所有图表必须包裹在 fenced code block 中")
    parts.append("- 所有建议必须有完整的决策逻辑链")
    parts.append("- 不要附加「下面是报告」等前言后语，直接输出策略声明 + 报告正文")
    parts.append("")

    return "\n".join(parts)


def assemble_user_message(
    aggregated_data: dict[str, Any],
    strategy_declaration: str,
    project_context_text: str = "",
    sku_context_text: str = "",
    user_message: str | None = None,
) -> str:
    """组装用户消息（包含数据 + 策略声明）。"""
    # 去掉 context 字段（单独传）
    display_data = {
        k: v for k, v in aggregated_data.items()
        if k not in ("project_context", "sku_context")
    }
    data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

    parts: list[str] = []
    parts.append("请根据以下数据和分析策略，生成广告专项洞察报告：")
    parts.append("")
    parts.append("---")
    parts.append("")
    parts.append(strategy_declaration)
    parts.append("")
    parts.append("---")
    parts.append("")
    parts.append(f"```json\n{data_str}\n```")
    parts.append("")

    if project_context_text or sku_context_text:
        parts.append("## 项目背景信息（由运营人员填写）")
        parts.append("")
        if project_context_text:
            parts.append(f"### 项目背景\n{project_context_text}")
            parts.append("")
        if sku_context_text:
            parts.append(f"### SKU 特殊状态\n{sku_context_text}")
            parts.append("")

    if user_message:
        parts.append(f"用户补充说明：{user_message}")

    return "\n".join(parts)
