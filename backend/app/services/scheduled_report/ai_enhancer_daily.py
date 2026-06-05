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
- 首先描述"昨日"的单量和销售额 → 对比对象**只能是前一日（yesterday vs prev_day）**，绝对不能拿单日数据和近7天累计做对比
- 然后在括号内附上近7天累计数据作为参考
- 最后关注库存状态和广告效果（ROAS/ACOS）

⚠️ 对比逻辑（最重要，违反即为错误）：
- "昨日销量"的涨跌判断**仅基于 vs 前一日**（change_pct 字段）
- 近7天累计数据放在括号内作为补充参考，**绝对不能**用来判断单日涨跌
- 错误示例："昨日6单，较前一日大幅下降（近7天累计39单）" → 这是拿单日 vs 7天累计得出"大幅下降"，逻辑错误
- 正确示例："昨日6单/141.94欧元，较前一日增长12.5%（近7天累计39单/981.04欧元）"

⚠️ 货币单位（必须与站点匹配）：
- 美国站(US) → 美元(USD), 金额写如 "$1,234.56" 或 "1,234.56美元"
- 德国站(DE) → 欧元(EUR), 金额写如 "€1,234.56" 或 "1,234.56欧元"
- 英国站(UK) → 英镑(GBP), 金额写如 "£1,234.56" 或 "1,234.56英镑"
- 数据中的 country 字段标识站点，金额必须使用对应站点货币
- 绝对不能对美国站使用欧元，或对英国站使用美元

强制格式规则：
1. **近7天累计数据**必须跟在单日数据后面，用括号标注：
   格式：`（近7天累计{quantity}单/{amount}）`
   示例（德国站）：`昨日6单/€141.94，较前一日增长12.5%（近7天累计39单/€981.04）`
   示例（美国站）：`昨日6单/$1,234.56，较前一日增长12.5%（近7天累计39单/$9,810.40）`
2. **库存状况**必须包含可用库存和在途数量：
   格式：`库存{total_available}件在途{in_transit}件`
   示例：`库存285件在途665件`
   如果有缺货/告急SKU则另外标注，如：`库存285件在途665件，2个SKU缺货`

要求：
1. 使用 bullet point（以 ◉ 开头）形式组织内容，每点独立一行，每个国家一条
2. 多国家时每条以"XX站"开头，如"◉ 德国站昨日6单/141.94欧元..."
3. 单国家时直接写数据即可
4. 识别最重要的变化（增长/下降超过10%时明确标注百分比和方向）
5. 指出需要关注的核心问题（缺货、广告ACOS过高、退货率异常等）
6. 用中文回复，风格专业简洁
7. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成摘要"
8. 不要输出任何"建议"或"建议措施"相关内容

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
        from app.services.scheduled_report.email_sender import CURRENCY_SYMBOLS, CURRENCY_CODES

        # Separate context fields from data for structured prompt
        ctx_project = report_data.get("project_context")
        ctx_sku = report_data.get("sku_context")
        ctx_factory = report_data.get("sku_factory_info_text", "")

        display_data = {
            k: v for k, v in report_data.items()
            if k not in ("project_context", "sku_context", "sku_factory_info_text")
        }

        # Inject currency mapping for each country in the data
        is_multi = bool(report_data.get("multi_country") or report_data.get("countries"))
        if is_multi:
            country_codes = list(report_data.get("countries", {}).keys())
        else:
            country_codes = [report_data.get("country", "US")]
        currency_note_lines = []
        for cc in country_codes:
            symbol = CURRENCY_SYMBOLS.get(cc, "$")
            code = CURRENCY_CODES.get(cc, "USD")
            currency_note_lines.append(f"  - {cc} → {symbol} ({code})")
        currency_note = "\n".join(currency_note_lines)

        data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

        project_context_text = format_project_context_for_prompt(ctx_project)
        sku_context_text = format_sku_context_for_prompt(ctx_sku)

        user_content = f"""请根据以下数据生成日报摘要：

```json
{data_str}
```

## 货币对照表（必须严格遵守）
{currency_note}

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
    country = report_data.get("country", "US")

    today_qty = sales.get("yesterday_qty", 0)
    today_amt = sales.get("yesterday_amount", 0.0)
    vs_prev = sales.get("change_pct", 0.0)

    p7d_qty = week_sales.get("week_qty", 0)
    p7d_amt = week_sales.get("week_amount", 0.0)
    prev_qty = prev_week_sales.get("week_qty", 0)
    prev_amt = prev_week_sales.get("week_amount", 0.0)

    p7d_chg = ((p7d_qty - prev_qty) / prev_qty * 100) if prev_qty > 0 else 0
    p7d_amt_chg = ((p7d_amt - prev_amt) / prev_amt * 100) if prev_amt > 0 else 0

    total_available = inventory.get("total_available", 0)
    in_transit = inventory.get("in_transit", 0)
    oos_count = len(inventory.get("oos_skus", []))
    low_count = len(inventory.get("low_stock_skus", []))

    ad_roas = ads.get("roas", 0)
    ad_acos = ads.get("acos", 0)

    lines = []

    dir_icon = "↑" if vs_prev >= 0 else "↓"
    amt_str = f"/{_fmt_curr(today_amt, country)}" if today_amt > 0 else ""
    p7d_amt_str = f"/{_fmt_curr(p7d_amt, country)}" if p7d_amt > 0 else ""
    lines.append(
        f"- 昨日销量{today_qty}单{amt_str}，较前一日"
        f"{'增长' if vs_prev >= 0 else '下降'}{abs(vs_prev):.1f}%"
        f"（近7天累计{p7d_qty}单{p7d_amt_str}）"
    )

    inv_parts = [f"库存{total_available}件"]
    if in_transit > 0:
        inv_parts.append(f"在途{in_transit}件")
    if oos_count > 0:
        inv_parts.append(f"{oos_count}个SKU缺货")
    if low_count > 0:
        inv_parts.append(f"{low_count}个SKU告急")
    lines.append(f"- {'，'.join(inv_parts)}")

    if ad_roas > 0 or ad_acos > 0:
        roas_status = "良好" if ad_roas >= 2 else "偏低"
        lines.append(f"- 广告 ROAS {ad_roas:.2f}（{roas_status}），ACOS {ad_acos:.1f}%")

    return "\n".join(lines)


def _fmt_curr(amount: float, country: str = "") -> str:
    symbols = {"US": "$", "DE": "€", "UK": "£"}
    units = {"US": "美元", "DE": "欧元", "UK": "英镑"}
    symbol = symbols.get(country, "$")
    unit = units.get(country, "美元")
    if amount >= 1000:
        return f"{symbol}{amount:,.0f}"
    return f"{symbol}{amount:.2f}"
