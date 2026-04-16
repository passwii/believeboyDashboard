from __future__ import annotations

import json
from typing import Any, Iterator

from app.core.config import Settings
from app.schemas.ai_chat import LLMConfigInput
from app.services import ai_chat_service


INSIGHT_SYSTEM_PROMPT = """你是一位专业的跨境电商数据分析师，为Amazon卖家提供经营洞察。

你的任务是根据提供的经营数据，生成一份结构化的Markdown格式经营洞察报告。

## 输出要求

1. **语言**：使用中文输出
2. **格式**：完整、可直接使用的Markdown文档
3. **图表**：使用Mermaid语法嵌入趋势图表（lineChart类型）
4. **结构**：必须包含以下章节
   - 执行摘要（1-2段话总结核心发现）
   - 销售趋势分析（含趋势图表）
   - 广告效果分析（含关键指标）
   - 库存状态评估
   - 同比/环比对比（如有对比数据）
   - 异常发现（销售/广告/库存的异常波动）
   - 运营建议（基于数据的具体可操作建议，3-5条）

## Markdown格式规范

- 折线图使用 ```lineChart 代码块
- 饼图使用 ```pieChart 代码块
- 数据表格使用标准Markdown表格
- 数字保留2位小数
- 百分比使用 % 符号

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
