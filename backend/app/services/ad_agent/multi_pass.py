"""
Multi-Pass Analysis Engine — 多阶段迭代分析
=============================================

Pass 1 (Scout): 快速扫描全量数据，识别 TOP 5 热点问题
Pass 2 (Deep-dive): 对每个热点进行精准深挖
Pass 3 (Synthesis): 综合所有发现，聚焦维度间逻辑链条

设计原则：
- 每轮 LLM 调用有明确的目标和数据范围
- Scout 只做识别，不做分析
- Deep-dive 用精准子集数据，避免 token 浪费
- Synthesis 强调交叉联系，不重复细节
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Iterator

from app.core.config import Settings
from app.services.ad_agent import DataProfile, AnalysisStrategy
from app.services.ad_agent.config_loader import RegistryConfig
from app.services.ad_agent.data_zoom import extract_zoomed_data
from app.services.ad_agent.prompt_assembler import (
    _build_strategy_declaration,
    assemble_system_prompt,
)

logger = logging.getLogger(__name__)

# ── Scout Prompt ─────────────────────────────────────────────────────────
SCOUT_SYSTEM_PROMPT = """你是一位资深的亚马逊广告数据扫描专家。

你的任务是快速扫描数据，识别最值得关注的问题热点。不要做详细分析——只做识别。

## 输出要求

严格输出 JSON 数组，每个元素格式：
```json
[
  {
    "dimension": "维度ID",
    "severity": "high/medium",
    "finding": "一句话描述发现（不超过 50 字）",
    "key_metric": "关键数字，如 '$45.20 spend, 0 orders'"
  }
]
```

## 规则

1. 最多输出 5 个热点，按严重程度排序
2. 只输出需要行动的问题，不要列出正常数据
3. severity=high 表示正在浪费钱或严重影响业绩
4. severity=medium 表示有优化空间但不紧急
5. dimension 必须是以下之一：search_term_waste, budget_utilization, sku_ad_performance, campaign_health, placement_efficiency, target_effectiveness, invalid_traffic_check, time_trend_analysis, budget_reallocation, campaign_search_target_optimization
6. 只输出 JSON 数组，不要任何解释文字
"""

# ── Deep-dive Prompt Template ────────────────────────────────────────────
DEEP_DIVE_SYSTEM_PROMPT = """你是一位资深的亚马逊广告优化专家。

## 你的任务

针对以下特定问题进行深度分析，给出可执行的行动建议。

## 当前热点

- **维度**: {dimension}
- **严重程度**: {severity}
- **发现**: {finding}
- **关键指标**: {key_metric}

## 分析要求

1. **根因分析**：为什么会出现这个问题？（从数据中找证据）
2. **量化影响**：这个问题造成了多少损失？（具体金额）
3. **具体行动**：应该怎么做？（操作对象 + 具体数字 + 预期效果）
4. **交叉影响**：这个问题是否影响了其他维度？（如搜索词浪费是否影响了预算分配）

输出中文 Markdown，使用表格展示关键数据。
每条建议必须有具体数字，不要说"建议优化"这种空话。
"""

# ── Synthesis Prompt ─────────────────────────────────────────────────────
SYNTHESIS_SYSTEM_PROMPT = """你是一位资深的亚马逊运营总监，负责综合各维度分析结果生成最终决策报告。

## 你的任务

基于侦察扫描和深度分析的结果，生成一份聚焦**交叉联系和决策逻辑链**的最终报告。

## 侦察扫描发现的热点

{scout_summary}

## 深度分析结果

{deep_dive_summaries}

## 输出要求

1. **执行摘要**（3-5 条要点，每条结构：【关键现象】：数据 + 影响判断）
2. **问题全景图**：用表格展示所有发现的问题、影响金额、优先级
3. **交叉分析**：维度之间的关联和矛盾（如"搜索词浪费的 campaign 恰好预算过剩"）
4. **行动路线图**：按优先级排序的行动清单，每条包含：操作对象、具体变更、预期效果
5. **预算优化方案**（如有预算相关发现）：精确到金额的转移计划

## 格式要求

- 中文 Markdown
- 图表使用 fenced code block（lineChart / pieChart / alert）
- 数字保留 2 位小数
- 每条建议必须可执行
- 不要重复深度分析中的细节数据，聚焦综合判断和行动方案
"""


def _build_scout_data(data_profile: DataProfile, strategy: AnalysisStrategy) -> str:
    """构建 Scout 阶段的数据摘要（精简版）。"""
    parts = []
    parts.append("## 数据源信号")
    for src, info in (data_profile.data_source_summary or {}).items():
        if info.get("signal") != "empty":
            parts.append(f"- {info.get('label', src)}: 信号 {info['signal']}")
    parts.append("")

    parts.append("## 可用维度")
    for dim in (data_profile.available_dimensions or []):
        parts.append(f"- {dim['name']} (L{dim.get('level', 1)}, 信号: {dim.get('signal_strength', '?')})")
        for h in dim.get("highlights", [])[:3]:
            parts.append(f"  - {h}")
    parts.append("")

    if data_profile.cross_dimension_signals:
        parts.append("## 交叉信号")
        for sig in data_profile.cross_dimension_signals:
            parts.append(f"- {sig}")

    return "\n".join(parts)


def _parse_hotspots(raw_output: str) -> list[dict[str, Any]]:
    """从 Scout 输出中解析热点 JSON，支持多种格式。"""
    text = raw_output.strip()

    # 策略 1：提取 ```json ... ``` 包裹的 JSON
    fenced_match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if fenced_match:
        try:
            candidate = fenced_match.group(1).strip()
            hotspots = json.loads(candidate)
            if isinstance(hotspots, list):
                return hotspots[:5]
        except json.JSONDecodeError:
            pass

    # 策略 2：查找最外层 JSON 数组
    if "[" in text and "]" in text:
        try:
            start = text.index("[")
            end = text.rindex("]") + 1
            hotspots = json.loads(text[start:end])
            if isinstance(hotspots, list):
                return hotspots[:5]
        except (json.JSONDecodeError, ValueError):
            pass

    logger.warning("Failed to parse scout hotspots from output: %s...", text[:200])
    return []


def _build_deep_dive_prompt(hotspot: dict[str, Any]) -> str:
    """构建 Deep-dive 阶段的 system prompt。"""
    return DEEP_DIVE_SYSTEM_PROMPT.format(
        dimension=hotspot.get("dimension", ""),
        severity=hotspot.get("severity", "medium"),
        finding=hotspot.get("finding", ""),
        key_metric=hotspot.get("key_metric", ""),
    )


def _build_synthesis_prompt(
    scout_hotspots: list[dict[str, Any]],
    deep_dive_results: list[dict[str, Any]],
) -> str:
    """构建 Synthesis 阶段的 system prompt。"""
    scout_summary = "\n".join(
        f"- [{h.get('severity', '?')}] {h.get('finding', '')} ({h.get('key_metric', '')})"
        for h in scout_hotspots
    )
    deep_dive_summaries = "\n\n".join(
        f"### 热点 {i+1}: {r['hotspot'].get('finding', '')}\n\n{r['analysis']}"
        for i, r in enumerate(deep_dive_results)
    )
    return SYNTHESIS_SYSTEM_PROMPT.format(
        scout_summary=scout_summary,
        deep_dive_summaries=deep_dive_summaries,
    )


def _run_single_deep_dive(
    hotspot: dict[str, Any],
    aggregated_data: dict[str, Any],
    settings: Settings,
    selected_model: str,
    project_context_text: str,
    sku_context_text: str,
) -> str:
    """单个热点的 deep-dive 分析（独立函数，便于后续并行化）。"""
    from app.services import ai as ai_chat_service

    zoomed_data = extract_zoomed_data(aggregated_data, hotspot)
    data_json = json.dumps(zoomed_data, ensure_ascii=False, indent=2)

    deep_prompt = _build_deep_dive_prompt(hotspot)
    deep_llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt=deep_prompt,
        reasoning_effort=None,
    )

    collected = ""
    for chunk in ai_chat_service.stream_assistant_content(
        llm_config=deep_llm_config,
        messages=[],
        user_content=f"以下是针对「{hotspot.get('dimension', '')}」维度的精准数据：\n\n```json\n{data_json}\n```\n\n{project_context_text}\n\n{sku_context_text}",
        settings=settings,
    ):
        if isinstance(chunk, dict):
            if chunk.get("type") == "thinking":
                continue
            delta = chunk.get("content", "")
        elif isinstance(chunk, str):
            delta = chunk
        else:
            continue
        if delta:
            collected += delta

    return collected


def run_multi_pass_stream(
    aggregated_data: dict[str, Any],
    settings: Settings,
    data_profile: DataProfile,
    strategy: AnalysisStrategy,
    registry: RegistryConfig,
    *,
    project_context_text: str = "",
    sku_context_text: str = "",
    model: str | None = None,
    max_hotspots: int = 5,
) -> Iterator[dict[str, Any]]:
    """多阶段流式分析：Scout → Deep-dive → Synthesis。

    Yields:
        {"type": "pass", "pass": N, "name": "...", "status": "starting"}
        {"type": "hotspots", "data": [...]}
        {"type": "deep_dive_start", "hotspot": {...}, "index": N}
        {"type": "chunk", "delta": "..."}
        {"type": "done", "content": "...", ...}
    """
    from app.services import ai as ai_chat_service

    if not ai_chat_service.is_provider_configured(settings):
        raise RuntimeError("AI Provider 未配置")

    models, default_model = ai_chat_service.resolve_available_models(settings)
    selected_model = model or default_model

    # ── Pass 1: Scout ────────────────────────────────────────────────────
    yield {"type": "pass", "pass": 1, "name": "scout", "status": "starting"}

    scout_data = _build_scout_data(data_profile, strategy)
    yield {"type": "pass_progress", "pass": 1, "message": "正在扫描数据热点..."}

    scout_llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt=SCOUT_SYSTEM_PROMPT,
        reasoning_effort=None,
    )

    scout_raw = ai_chat_service.generate_assistant_content(
        llm_config=scout_llm_config,
        messages=[],
        user_content=f"以下是广告数据探针结果，请识别 TOP {max_hotspots} 个热点问题：\n\n{scout_data}",
    )

    yield {"type": "pass_progress", "pass": 1, "message": "热点扫描完成"}
    hotspots = _parse_hotspots(scout_raw)
    yield {"type": "hotspots", "data": hotspots}
    logger.info("Scout identified %d hotspots", len(hotspots))

    if not hotspots:
        # 没有热点 → 退回到单轮分析
        logger.warning("No hotspots from scout, falling back to single-pass synthesis")
        hotspots = [{"dimension": "general", "severity": "low", "finding": "数据整体健康，无明显问题", "key_metric": ""}]

    # ── Pass 2: Deep-dive ────────────────────────────────────────────────
    yield {"type": "pass", "pass": 2, "name": "deep_dive", "status": "starting"}

    deep_dive_results: list[dict[str, Any]] = []
    full_content_parts: list[str] = []

    for i, hotspot in enumerate(hotspots[:max_hotspots]):
        yield {"type": "deep_dive_start", "hotspot": hotspot, "index": i}

        collected = _run_single_deep_dive(
            hotspot, aggregated_data, settings, selected_model,
            project_context_text, sku_context_text,
        )
        # 将 deep-dive 结果分段 yield 以保持流式体验
        for line in collected.split("\n"):
            if line:
                yield {"type": "chunk", "delta": line + "\n"}

        deep_dive_results.append({"hotspot": hotspot, "analysis": collected})
        full_content_parts.append(f"## {hotspot.get('finding', f'热点 {i+1}')}\n\n{collected}")

    # ── Pass 3: Synthesis ────────────────────────────────────────────────
    yield {"type": "pass", "pass": 3, "name": "synthesis", "status": "starting"}

    synthesis_prompt = _build_synthesis_prompt(hotspots, deep_dive_results)
    strategy_declaration = _build_strategy_declaration(strategy, data_profile)

    synthesis_llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt=synthesis_prompt,
        reasoning_effort=None,
    )

    synthesis_user_content = (
        f"{strategy_declaration}\n\n"
        f"## 项目背景\n{project_context_text}\n\n"
        f"## SKU 状态\n{sku_context_text}\n\n"
        f"请基于上述侦察和深度分析结果，生成最终决策报告。"
    )

    synthesis_content = ""
    for chunk in ai_chat_service.stream_assistant_content(
        llm_config=synthesis_llm_config,
        messages=[],
        user_content=synthesis_user_content,
        settings=settings,
    ):
        if isinstance(chunk, dict):
            if chunk.get("type") == "thinking":
                continue
            delta = chunk.get("content", "")
        elif isinstance(chunk, str):
            delta = chunk
        else:
            continue
        if delta:
            synthesis_content += delta
            yield {"type": "chunk", "delta": delta}

    # ── 合并最终内容 ─────────────────────────────────────────────────────
    # Synthesis 作为主体报告，Deep-dive 详情作为附录
    from app.services.ai_insight_generator import normalize_insight_markdown

    final_parts = [synthesis_content]
    if full_content_parts:
        final_parts.append("\n\n---\n\n## 附录：维度深度分析详情\n\n")
        final_parts.extend(full_content_parts)

    final_content = normalize_insight_markdown("\n".join(final_parts))

    yield {
        "type": "done",
        "content": final_content,
        "hotspots": hotspots,
        "deep_dive_count": len(deep_dive_results),
    }
