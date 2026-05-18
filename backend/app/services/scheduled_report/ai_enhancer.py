"""AI-powered summary and insight generator for scheduled reports."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是一位跨境电商运营专家。
请根据以下数据，为运营团队生成一段简洁的报告摘要。

要求：
1. 识别最重要的变化（增长/下降 > 10% 标出）
2. 指出需要关注的问题
3. 给出 1-2 条具体建议
4. 总字数控制在 150-200 字
5. 用中文回复，风格专业简洁
6. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成摘要"

数据：
{report_data}"""


def generate_ai_summary(
    frequency: str,
    report_data: dict[str, Any],
) -> str:
    """调用 AI 服务生成报告摘要。"""
    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        logger.warning("AI_CHAT_PROVIDER_API_KEY not configured, using fallback summary")
        return _generate_fallback_summary(frequency, report_data)

    try:
        from app.services.ai_insight_generator import generate_insight

        prompt = SYSTEM_PROMPT.format(report_data=json.dumps(report_data, ensure_ascii=False, indent=2))

        result = generate_insight(
            prompt=prompt,
            user_id=None,
            conversation_id=None,
            insight_type="scheduled_report_summary",
        )

        if result and result.get("content"):
            return result["content"].strip()
        return _generate_fallback_summary(frequency, report_data)

    except Exception as e:
        logger.error(f"AI summary generation failed: {e}")
        return _generate_fallback_summary(frequency, report_data)


def _generate_fallback_summary(frequency: str, report_data: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础摘要。"""
    sales = report_data.get("sales", {})
    ads = report_data.get("ads", {})

    if frequency == "daily":
        qty = sales.get("today_order_qty", 0)
        amount = sales.get("today_sales_amount", 0)
        change = sales.get("sales_change_pct", 0)
        roas = ads.get("period_roas", 0)
        return (
            f"今日销售 {qty:,} 件，销售额 ¥{amount:,.2f}，"
            f"{'较昨日上升' if change >= 0 else '较昨日下降'} {abs(change):.1f}%。"
            f"广告 ROAS {roas:.2f}。"
        )
    elif frequency == "weekly":
        week_sales = report_data.get("week_sales", {})
        qty = week_sales.get("total_qty", 0)
        return f"本周累计销售 {qty:,} 件，详情请查看完整报告。"
    else:
        financial = report_data.get("financial_summary", {})
        revenue = financial.get("total_revenue", 0)
        profit = financial.get("net_profit", 0)
        return f"本月收入 ¥{revenue:,.2f}，净利润 ¥{profit:,.2f}。详情请查看完整报告。"
