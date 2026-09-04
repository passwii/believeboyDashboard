"""
AI Insight 共享工具函数
======================

从 ai_insight_generator.py 提取的上下文格式化函数，
供 ai_insight_generator.py 和 ad_agent/pipeline.py 共同使用，
避免循环导入。
"""
from __future__ import annotations

from typing import Any


def format_project_context_for_prompt(context: dict[str, Any]) -> str:
    """将 project_context 格式化为可读的文本片段。"""
    if not context:
        return "（暂无项目背景信息）"

    lines = []
    mapping = {
        "factory": "🏭 工厂供货",
        "productSeasonality": "📅 淡旺季",
        "productGrowth": "📈 产品增长",
        "projectStatus": "📊 项目状态",
    }

    for key, label in mapping.items():
        if key in context and context[key]:
            section = context[key]
            if isinstance(section, str):
                lines.append(f"**{label}**：{section}")
                continue
            if not isinstance(section, dict):
                lines.append(f"**{label}**：{str(section)}")
                continue
            parts = []
            if key == "factory":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("productionCapacity"):
                    parts.append(f"生产能力：{section['productionCapacity']}")
                if section.get("communication"):
                    parts.append(f"沟通协作：{section['communication']}")
            elif key == "productSeasonality":
                if section.get("peakSeason"):
                    parts.append(f"高峰期：{section['peakSeason']}")
                if section.get("offSeason"):
                    parts.append(f"淡季：{section['offSeason']}")
                if section.get("restockStrategy"):
                    parts.append(f"备货策略：{section['restockStrategy']}")
            elif key == "productGrowth":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("growthDriver"):
                    parts.append(f"增长驱动：{section['growthDriver']}")
            elif key == "projectStatus":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("riskNotes"):
                    parts.append(f"风险备注：{section['riskNotes']}")

            if parts:
                lines.append(f"**{label}**：{'；'.join(parts)}")

    # 自由备注
    notes = context.get("notes")
    if notes:
        lines.append(f"**📝 自由备注**：{notes}")

    # 非标准 key（AI context parser 产生的扁平 key-value）
    known_keys = set(mapping.keys()) | {"notes"}
    extra_keys = [k for k in context if k not in known_keys and context[k]]
    for k in extra_keys:
        val = context[k]
        lines.append(f"**{k}**：{val if isinstance(val, str) else str(val)}")

    return "\n".join(lines) if lines else "（暂无项目背景信息）"


def format_sku_context_for_prompt(context: dict[str, Any]) -> str:
    """将 sku_context 格式化为可读的文本片段。"""
    if not context:
        return "（暂无 SKU 特殊状态）"

    lines = []
    for sku, item in context.items():
        if isinstance(item, str):
            lines.append(f"- **{sku}**：{item}")
            continue
        if not isinstance(item, dict):
            lines.append(f"- **{sku}**：{str(item)}")
            continue
        parts = []
        if item.get("status"):
            parts.append(f"状态：{item['status']}")
        if item.get("reason"):
            parts.append(f"原因：{item['reason']}")
        if item.get("action"):
            parts.append(f"行动：{item['action']}")
        if item.get("startDate"):
            parts.append(f"开始日期：{item['startDate']}")
        if item.get("endDate"):
            parts.append(f"结束日期：{item['endDate']}")

        if parts:
            lines.append(f"- **{sku}**：{'；'.join(parts)}")
        else:
            lines.append(f"- **{sku}**：{str(item)}")

    return "\n".join(lines) if lines else "（暂无 SKU 特殊状态）"
