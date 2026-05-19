from __future__ import annotations

import json
import re
from typing import Any, Iterator

from app.core.config import Settings
from app.schemas.ai_chat import LLMConfigInput
from app.services import ai as ai_chat_service


def _format_project_context_for_prompt(context: dict[str, Any]) -> str:
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
    if context.get("notes"):
        lines.append(f"**📝 自由备注**：{context['notes']}")

    return "\n".join(lines) if lines else "（暂无项目背景信息）"


def _format_sku_context_for_prompt(context: dict[str, Any]) -> str:
    """将 sku_context 格式化为可读的文本片段。"""
    if not context:
        return "（暂无 SKU 特殊状态）"

    lines = []
    for sku, item in context.items():
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

    return "\n".join(lines) if lines else "（暂无 SKU 特殊状态）"


INSIGHT_SYSTEM_PROMPT = """你是一位专业的跨境电商数据分析师，为Amazon卖家提供经营洞察。

你的任务是根据提供的经营数据，生成一份结构化的Markdown格式经营洞察报告。

## 输出要求

1. **语言**：使用中文输出
2. **格式**：完整、可直接使用的Markdown文档
3. **图表**：使用前端可直接渲染的 fenced code block 图表语法，不要输出裸露的图表行
4. **结构**：必须包含以下章节
   - 执行摘要（用要点列表形式呈现核心发现，每条要点结构：【关键现象】：数据说明 + 趋势判断，3-5条）
   - 销售趋势分析（含趋势图表）
   - 广告效果分析（含关键指标）
   - 库存状态评估
   - 同比/环比对比（如有对比数据）
   - 异常发现（销售/广告/库存的异常波动）
   - 运营建议（基于数据的具体可操作建议，3-5条）

## Markdown格式规范

- 折线图必须使用完整的 ```lineChart fenced code block
- 饼图必须使用完整的 ```pieChart fenced code block
- 重要告警优先使用 Markdown blockquote（以 `> ` 开头）或 ```alert fenced code block，不要使用 ASCII 画框
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
- 如果需要强调库存异常、风险警告，不要输出 `┌─│└` 这类 ASCII 边框，改用 blockquote 或 `alert` 代码块

## 输出前自检

- 检查报告中每一个图表是否都被完整包裹在 fenced code block 中
- 检查是否存在未包裹的 `x-axis[`、`y-axis[` 或 `title ` 图表行；如果有，改成标准代码块后再输出
- 检查是否存在 `┌`、`└`、`│` 组成的 ASCII 提示框；如果有，改成 blockquote 或 ```alert
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

## 告警格式示例

```alert
⚠️ 严重警告：可用库存为 0

库存数据显示所有SKU可用库存为0，但店铺仍在产生销售订单。
这可能意味着库存数据与实际库存不同步，或实际库存已耗尽。
```

## alert 代码块使用规范（必须严格遵守）

- alert 代码块的标题（⚠️ 后的文字）必须是完整的一行，不能折行
- alert 代码块的正文如果有多行，每行应该是独立的要点，不要在句子中间换行
- 不要使用 ASCII 边框字符（┌、└、│、─）画提示框，改用 ```alert 代码块
- 避免在 alert 中输出超长单行内容（建议每行不超过 50 字）

## 执行摘要格式示例（必须严格遵循此格式）

> **执行摘要**

- **量跌价升**：订单量下降12.5%，但销售额增长15.28%，平均客单价从$529提升至$697，涨幅31.74%。这表明销售结构优化，高价值SKU占比提升。
- **广告效率飞跃**：ROAS从不足1提升至2.70，每投入1美元广告可产生2.70美元销售额，广告投产比显著改善。
- **产品集中度**：TOP 2 SKU（MJQ-TR250C、MJQ-TR250E）贡献了99%的销售额，存在较高的产品集中度风险。

**格式要求**：
- 执行摘要必须是 **bullet list**，不能用普通段落
- 每条要点以 **【关键现象】** 开头（如量跌价升、广告效率飞跃），用简短有力的短语概括核心发现
- 冒号后跟数据说明和趋势判断，数据要具体（数字、百分比），判断要明确（"表明""意味着""反映"）
- 3-5条要点，覆盖销售、广告、库存中最值得关注的发现
- 不要用"核心发现""主要表现"等模糊词，每条要点都要能让读者一眼判断是好是坏

## 数据来源说明

- sales_by_date: 每日销售汇总（date, order_qty, sales_amount, unique_asins）
- ad_by_date: 每日广告数据（date, impressions, clicks, ad_spend, ad_sales, ad_orders, ctr, roas）
- inventory_summary: 库存汇总（available, out_of_stock_skus, aging_summary）
- top_skus: TOP SKU排行（sku, asin, order_qty, sales_amount）
- comparison_period: 对比周期数据
- project_context: 项目背景信息（由运营人员填写）
- sku_context: SKU 特殊状态（如清仓、秒杀等）

## 项目背景信息使用规则

生成洞察时必须遵循以下规则，结合运营人员提供的背景信息进行综合分析：

### 销量异常解读
- 如果某 SKU 正在"清仓"或做"促销/秒杀"活动，其销量增长应归因于促销活动而非自然增长
- 在分析中明确标注"促销驱动的增长"，不要将此类增长完全归功于运营策略

### 淡旺季判断
- 如果项目背景中标注了高峰期（如 Q4）和淡季（如 Q2），应将其作为正常季节性表现
- 不要将旺季销量高于淡季作为运营评价的加分项

### 库存分析
- 结合备货周期信息（如"交货周期 15 天"），判断当前库存水位是否合理
- 如果背景说"产能充足"但库存经常断货，需在洞察中特别指出矛盾

### 风险标注
- 如果发现数据与背景信息矛盾，应在洞察中明确指出
- 例如："广告数据表现不佳，但考虑到该项目为新开项目（爬坡期），此情况属正常"

### 运营评价边界
- 结合项目状态（新项目/增长期/成熟期）调整评价标准
- 新项目应以"是否按计划推进"为主要评价维度，而非绝对业绩

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


def _looks_like_ascii_alert(lines: list[str]) -> bool:
    if len(lines) < 3:
        return False
    has_box_char = any(re.search(r"[┌┐└┘│─]", line) for line in lines)
    has_warning_text = any(re.search(r"⚠️|警告|异常|提醒", line) for line in lines)
    return has_box_char and has_warning_text


def normalize_insight_markdown(content: str) -> str:
    """Wrap bare chart syntax lines into fenced chart code blocks and normalize warning blocks."""
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
            if not in_fence and stripped == "```":
                block_end = idx + 1
                block_lines: list[str] = []
                while block_end < len(lines) and not _is_fence_line(lines[block_end]):
                    block_lines.append(lines[block_end])
                    block_end += 1
                if block_end < len(lines) and _is_fence_line(lines[block_end]) and _looks_like_ascii_alert(block_lines):
                    normalized.append("```alert")
                    normalized.extend(block_lines)
                    normalized.append("```")
                    idx = block_end + 1
                    continue
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
    # 提取数据（去掉 context 用于 JSON 展示，保持 user_content 清晰）
    display_data = {k: v for k, v in data.items() if k not in ("project_context", "sku_context")}
    data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

    # 格式化项目背景信息
    project_context = data.get("project_context", {})
    sku_context = data.get("sku_context", {})
    project_context_text = _format_project_context_for_prompt(project_context)
    sku_context_text = _format_sku_context_for_prompt(sku_context)

    system_prompt = INSIGHT_SYSTEM_PROMPT.strip()

    user_content = f"""请根据以下数据生成洞察报告：

```json
{data_str}
```

## 项目背景信息（由运营人员填写，生成洞察时请结合以下信息进行综合分析）

### 项目背景
{project_context_text}

### SKU 特殊状态
{sku_context_text}"""

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
