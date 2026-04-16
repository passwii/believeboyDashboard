from __future__ import annotations

import json
import re
from typing import Any, Iterator

from app.core.config import Settings
from app.schemas.ai_chat import LLMConfigInput
from app.services import ai_chat_service


INSIGHT_SYSTEM_PROMPT = """你是一位专业的跨境电商数据分析师，为Amazon卖家提供经营洞察。

你的任务是根据提供的经营数据，生成一份结构化的Markdown格式经营洞察报告。

## 输出要求

1. **语言**：使用中文输出
2. **格式**：完整、可直接使用的Markdown文档
3. **图表**：使用前端可直接渲染的 fenced code block 图表语法，不要输出裸露的图表行
4. **结构**：必须包含以下章节
   - 执行摘要（1-2段话总结核心发现）
   - 销售趋势分析（含趋势图表）
   - 广告效果分析（含关键指标）
   - 库存状态评估
   - 同比/环比对比（如有对比数据）
   - 异常发现（销售/广告/库存的异常波动）
   - 运营建议（基于数据的具体可操作建议，3-5条）

## Markdown格式规范

- 折线图必须使用完整的 ```lineChart fenced code block
- 饼图必须使用完整的 ```pieChart fenced code block
- 数据表格使用标准Markdown表格
- 数字保留2位小数
- 百分比使用 % 符号
- 标题、段落、表格、图表之间要留空行，保证 Markdown 结构清晰

## 图表输出硬性约束

- 绝对不要输出裸露的 `x-axis[...]`、`y-axis[...]`、`销售额[...]` 这类单独文本行
- 只要输出图表，必须从单独一行的 ```lineChart 或 ```pieChart 开始，并以单独一行的 ``` 结束
- 不要在代码块前面加列表符号、缩进或引用符号，例如不要写成 `- ```lineChart` 或 `> ```lineChart`
- `x-axis[...]` 必须写在 fenced code block 内部
- 销售趋势分析章节默认至少输出 1 个 `lineChart`
- 如果涉及结构占比、库存库龄、SKU占比等分布信息，优先输出 1 个 `pieChart`
- 如果没有足够数据生成图表，则明确写“图表数据不足”，不要伪造图表

## 输出前自检

- 检查报告中每一个图表是否都被完整包裹在 fenced code block 中
- 检查是否存在未包裹的 `x-axis[`、`y-axis[` 或 `title ` 图表行；如果有，改成标准代码块后再输出
- 检查表格是否为标准 Markdown 表格，而不是纯文本对齐
- 最终输出只能是报告正文，不要附加“说明”“注释”“下面是报告”等前言后记

## 折线图格式示例

```lineChart
x-axis[1/1 1/5 1/10 1/15]
y-axis[销售额 USD]
ROAS[3.51, 3.48, 3.55, 3.52]
```

## 饼图格式示例

```pieChart
title 库龄结构分布
"0-90天" : 89
"91-180天" : 16
"181-270天" : 15
```

## 数据来源说明

- sales_by_date: 每日销售汇总（date, order_qty, sales_amount, unique_asins）
- ad_by_date: 每日广告数据（date, impressions, clicks, ad_spend, ad_sales, ad_orders, ctr, roas）
- inventory_summary: 库存汇总（available, out_of_stock_skus, aging_summary）
- top_skus: TOP SKU排行（sku, asin, order_qty, sales_amount）
- comparison_period: 对比周期数据

请根据以下数据生成洞察报告：
"""


LINE_CHART_LINE_RE = re.compile(r'^[^`#>|-][^\[\]]{0,48}\[[^\]]+\]\s*$')
PIE_CHART_VALUE_RE = re.compile(r'^"?[^"\n]+"?\s*[:：]\s*-?\d+(?:\.\d+)?\s*$')


def _is_fence_line(line: str) -> bool:
    return line.strip().startswith("```")


def _is_line_chart_syntax(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    lowered = stripped.lower()
    if lowered.startswith(("x-axis[", "xaxis[", "y-axis[", "yaxis[")):
        return True
    return bool(LINE_CHART_LINE_RE.match(stripped))


def _is_pie_chart_syntax(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.lower().startswith("title "):
        return True
    return bool(PIE_CHART_VALUE_RE.match(stripped))


def normalize_insight_markdown(content: str) -> str:
    """Wrap bare chart syntax lines into fenced chart code blocks."""
    if not content.strip():
        return content

    lines = content.splitlines()
    normalized: list[str] = []
    idx = 0
    in_fence = False

    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()

        if _is_fence_line(line):
            in_fence = not in_fence
            normalized.append(line)
            idx += 1
            continue

        if in_fence or not stripped:
            normalized.append(line)
            idx += 1
            continue

        if not (_is_line_chart_syntax(line) or _is_pie_chart_syntax(line)):
            normalized.append(line)
            idx += 1
            continue

        block_lines: list[str] = []
        block_start = idx
        while idx < len(lines):
            current = lines[idx]
            current_stripped = current.strip()
            if not current_stripped or _is_fence_line(current):
                break
            if _is_line_chart_syntax(current) or _is_pie_chart_syntax(current):
                block_lines.append(current_stripped)
                idx += 1
                continue
            break

        has_line_chart = any(_is_line_chart_syntax(item) for item in block_lines)
        has_x_axis = any(item.lower().startswith(("x-axis[", "xaxis[")) for item in block_lines)
        has_pie_chart = any(_is_pie_chart_syntax(item) for item in block_lines)

        chart_type = None
        if has_line_chart and has_x_axis:
            chart_type = "lineChart"
        elif has_pie_chart and not has_line_chart:
            chart_type = "pieChart"

        if chart_type and block_lines:
            if normalized and normalized[-1].strip():
                normalized.append("")
            normalized.append(f"```{chart_type}")
            normalized.extend(block_lines)
            normalized.append("```")
            if idx < len(lines) and lines[idx].strip():
                normalized.append("")
        else:
            normalized.extend(lines[block_start:idx])

    return "\n".join(normalized)


def build_insight_messages(
    data: dict[str, Any],
    user_message: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Build system prompt and user message for insight generation."""
    data_str = json.dumps(data, ensure_ascii=False, indent=2)

    system_prompt = INSIGHT_SYSTEM_PROMPT.strip()

    user_content = f"请根据以下数据生成洞察报告：\n\n```json\n{data_str}\n```"

    if user_message:
        user_content += f"\n\n用户补充说明：{user_message}"

    return system_prompt, [{"role": "user", "content": user_content}]


def generate_insight_stream(
    settings: Settings,
    data: dict[str, Any],
    model: str | None = None,
) -> Iterator[str]:
    """Generate insight content via streaming LLM call."""
    if not ai_chat_service.is_provider_configured(settings):
        raise RuntimeError("AI Provider 未配置")

    models, default_model = ai_chat_service.resolve_available_models(settings)
    selected_model = model or default_model

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt="",
        reasoning_effort=None,
    )

    system_prompt, messages = build_insight_messages(data)
    llm_config.system_prompt = system_prompt

    for chunk in ai_chat_service.stream_assistant_content(
        llm_config=llm_config,
        messages=[],  # messages passed in payload_messages via build_payload_messages
        user_content=messages[0]["content"],
        settings=settings,
    ):
        if isinstance(chunk, dict):
            if chunk.get("type") == "thinking":
                continue
            yield chunk.get("content", "")
        elif isinstance(chunk, str):
            yield chunk


def generate_insight_once(
    settings: Settings,
    data: dict[str, Any],
    model: str | None = None,
) -> str:
    """Generate insight content via non-streaming LLM call."""
    if not ai_chat_service.is_provider_configured(settings):
        raise RuntimeError("AI Provider 未配置")

    models, default_model = ai_chat_service.resolve_available_models(settings)
    selected_model = model or default_model

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt="",
        reasoning_effort=None,
    )

    system_prompt, messages = build_insight_messages(data)
    llm_config.system_prompt = system_prompt

    return ai_chat_service.generate_assistant_content(
        llm_config=llm_config,
        messages=[],
        user_content=messages[0]["content"],
    )


def generate_insight_title(
    settings: Settings,
    content: str,
    project_name: str,
    date_range_start: str,
    date_range_end: str,
) -> str:
    """Generate a short title for the insight based on its content."""
    if not ai_chat_service.is_provider_configured(settings):
        return f"{project_name} 经营洞察"

    models, default_model = ai_chat_service.resolve_available_models(settings)

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=models[0] if models else default_model,
        system_prompt="你是一个标题生成器。根据以下经营洞察报告的内容，生成一个简短的中文标题（不超过30个字符），概括报告的核心主题。不要使用引号或任何格式符号，直接输出标题。",
        reasoning_effort=None,
    )

    title_content = f"报告摘要：\n\n{content[:500]}"

    try:
        title = ai_chat_service.generate_assistant_content(
            llm_config=llm_config,
            messages=[],
            user_content=title_content,
        )
        return title.strip()[:30]
    except Exception:
        return f"{project_name} 经营洞察"
