"""AI-powered summary generator for daily reports."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """你是一位跨境电商运营专家。请根据用户提供的数据，为运营团队生成一段简洁的日报摘要。

叙事要点：
- 描述"今日"的单量和销售额（vs 前日）
- 描述近7天的累计数据（vs 上周期）
- 关注库存状态和广告效果
- 提示任何需要关注的问题

要求：
1. 识别最重要的变化（增长/下降超过10%时标注出来）
2. 指出需要关注的核心问题
3. 总字数控制在 100-150 字
4. 用中文回复，风格专业简洁
5. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成摘要"
6. 不要输出任何"建议"或"建议措施"相关内容

禁止输出：
- 不要在正文中附带字数统计，如"(字数：100字)"
- 不要输出标题、分隔线、签名等元信息
- 只输出纯正文摘要段落，不要有多余格式
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

        user_content = json.dumps(report_data, ensure_ascii=False, indent=2)
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
    
    # 今日数据
    today_qty = sales.get("yesterday_qty", 0)
    today_amt = sales.get("yesterday_amount", 0.0)
    vs_prev = sales.get("change_pct", 0.0)
    
    # 7天累计数据
    p7d_qty = week_sales.get("week_qty", 0)
    p7d_amt = week_sales.get("week_amount", 0.0)
    prev_qty = prev_week_sales.get("week_qty", 0)
    prev_amt = prev_week_sales.get("week_amount", 0.0)
    
    # 计算变化率
    p7d_chg = ((p7d_qty - prev_qty) / prev_qty * 100) if prev_qty > 0 else 0
    p7d_amt_chg = ((p7d_amt - prev_amt) / prev_amt * 100) if prev_amt > 0 else 0
    
    # 日报叙事
    dir_icon = "↑" if vs_prev >= 0 else "↓"
    return (
        f"今日销售 {today_qty:,} 件（{dir_icon} {abs(vs_prev):.1f}% vs 前日）。"
        f"近7天累计 {p7d_qty:,} 件，销售额 ${p7d_amt:,.2f}"
        f"（{p7d_chg:+.1f}% vs 上周期）。"
    )
