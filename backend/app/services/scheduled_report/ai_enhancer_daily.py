"""AI-powered summary generator for daily reports."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是一位跨境电商运营专家。请根据用户提供的数据，为运营团队生成一段简洁的日报摘要。

叙事要点（严格按此顺序）：
- 首先描述"今日"的单量和销售额（对比对象永远是 vs 前一日，绝对不要和近7天数据混淆）
- 然后描述近7天的累计数据（vs 上周期同天数）
- 最后关注库存状态（缺货/告急）和广告效果（ROAS/ACOS）

要求：
1. 使用 bullet point（以 - 开头）形式组织内容，每点独立一行
2. 每条 bullet point 控制在 20-30 字，整体不超过 5 条
3. 识别最重要的变化（增长/下降超过10%时明确标注百分比和方向）
4. 指出需要关注的核心问题（缺货、广告ACOS过高、退货率异常等）
5. 用中文回复，风格专业简洁
6. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成摘要"
7. 不要输出任何"建议"或"建议措施"相关内容

禁止输出：
- 不要在正文中附带字数统计，如"(字数：100字)"
- 不要输出标题、分隔线、签名等元信息
- 不要用加粗、斜体等格式标注，只输出纯文本 bullet point
- 只输出 bullet point 列表，不要有多余的前言或结语

## 项目背景信息使用规则
生成摘要时必须结合运营人员提供的背景信息进行综合分析：
- 如果某 SKU 正在"清仓"或做"促销/秒杀"活动，其销量增长应归因于促销活动而非自然增长
- 如果背景中标注了高峰期和淡季，应将其作为正常季节性表现，不要作为运营加分项
- 结合备货周期和产能信息判断库存水位是否合理
- 结合项目状态（新项目/爬坡期/成熟期）调整评价标准
- 如果数据与背景信息矛盾，应明确指出
"""


def _clean_ai_output(text: str) -> str:
    """移除 AI 输出中常见的元信息污染（字数统计、标题行等）。"""
    # 移除 "(字数：N字)" / "(共N字)" / "(约N字)" 等变体
    text = re.sub(r"\s*[（(]\s*(?:字数[：:]?\s*|共|约)\d+\s*字\s*[)）]", "", text)
    # 移除末尾独立的 "--- 字数：N字" 之类
    text = re.sub(r"\s*[-—]+\s*字数[：:]\s*\d+\s*字\s*$", "", text)
    return text.strip()


def generate_ai_summary(
    frequency: str,
    report_data: dict[str, Any],
    model: str | None = None,
) -> str:
    """调用 AI 服务生成日报摘要。

    Args:
        frequency: 报告类型 ("daily" / "weekly" / "monthly")
        report_data: 包含 sales/week_sales/prev_week_sales 等数据
        model: 指定 AI 模型名称，空则使用默认模型
    """
    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        logger.warning("AI_CHAT_PROVIDER_API_KEY not configured, using fallback summary")
        return _generate_fallback_summary(frequency, report_data)

    try:
        from app.services.ai.llm import (
            build_llm_config,
            generate_assistant_content,
            resolve_available_models,
        )

        _models, default_model = resolve_available_models(settings)
        use_model = model if model else default_model
        llm_config = build_llm_config(
            settings=settings,
            model=use_model,
            system_prompt=SYSTEM_PROMPT,
            reasoning_effort=None,
        )

        from app.services.scheduled_report.context_helpers import (
            format_project_context_for_prompt,
            format_sku_context_for_prompt,
        )

        # Separate context fields from data for structured prompt
        ctx_project = report_data.get("project_context")
        ctx_sku = report_data.get("sku_context")
        ctx_factory = report_data.get("sku_factory_info_text", "")

        display_data = {
            k: v for k, v in report_data.items()
            if k not in ("project_context", "sku_context", "sku_factory_info_text")
        }
        data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

        project_context_text = format_project_context_for_prompt(ctx_project)
        sku_context_text = format_sku_context_for_prompt(ctx_sku)

        user_content = f"""请根据以下数据生成日报摘要：

```json
{data_str}
```

## 项目背景信息（由运营人员填写）

### 项目背景
{project_context_text}

### SKU 特殊状态
{sku_context_text}

### 产品属性（Top/预警 SKU）
{ctx_factory}"""
        result = generate_assistant_content(
            llm_config=llm_config,
            messages=[],
            user_content=user_content,
        )

        if result and result.strip():
            return _clean_ai_output(result.strip())
        return _generate_fallback_summary(frequency, report_data)

    except Exception as e:
        logger.error(f"AI summary generation failed: {e}")
        return _generate_fallback_summary(frequency, report_data)


def _generate_fallback_summary(frequency: str, report_data: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础摘要。"""
    sales = report_data.get("sales", {})
    week_sales = report_data.get("week_sales", {})
    prev_week_sales = report_data.get("prev_week_sales", {})
    inventory = report_data.get("inventory", {})
    ads = report_data.get("ads", {})

    today_qty = sales.get("yesterday_qty", 0)
    today_amt = sales.get("yesterday_amount", 0.0)
    vs_prev = sales.get("change_pct", 0.0)

    p7d_qty = week_sales.get("week_qty", 0)
    p7d_amt = week_sales.get("week_amount", 0.0)
    prev_qty = prev_week_sales.get("week_qty", 0)
    prev_amt = prev_week_sales.get("week_amount", 0.0)

    p7d_chg = ((p7d_qty - prev_qty) / prev_qty * 100) if prev_qty > 0 else 0
    p7d_amt_chg = ((p7d_amt - prev_amt) / prev_amt * 100) if prev_amt > 0 else 0

    oos_count = len(inventory.get("oos_skus", []))
    low_count = len(inventory.get("low_stock_skus", []))

    ad_roas = ads.get("roas", 0)
    ad_acos = ads.get("acos", 0)

    lines = []

    dir_icon = "↑" if vs_prev >= 0 else "↓"
    lines.append(f"- 昨日销量 {today_qty:,} 件，{dir_icon} {abs(vs_prev):.1f}% vs 前日")
    if today_amt > 0:
        lines.append(f"- 昨日销售额 ${today_amt:,.2f}")

    p7d_dir = "↑" if p7d_chg >= 0 else "↓"
    amt_dir = "↑" if p7d_amt_chg >= 0 else "↓"
    lines.append(f"- 近7天累计 {p7d_qty:,} 件（{p7d_dir} {abs(p7d_chg):.1f}% vs 上周期）")
    if p7d_amt > 0:
        lines.append(f"- 近7天销售额 ${p7d_amt:,.2f}（{amt_dir} {abs(p7d_amt_chg):.1f}% vs 上周期）")

    if oos_count > 0 or low_count > 0:
        alerts = []
        if oos_count > 0:
            alerts.append(f"{oos_count} 个 SKU 缺货")
        if low_count > 0:
            alerts.append(f"{low_count} 个 SKU 库存告急(≤10件)")
        lines.append(f"- 库存风险：{'，'.join(alerts)}")

    if ad_roas > 0 or ad_acos > 0:
        roas_status = "良好" if ad_roas >= 2 else "偏低"
        lines.append(f"- 广告 ROAS {ad_roas:.2f}（{roas_status}），ACOS {ad_acos:.1f}%")

    return "\n".join(lines)
