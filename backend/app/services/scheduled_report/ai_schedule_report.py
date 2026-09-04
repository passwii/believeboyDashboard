"""Scheduled-report AI summary generator (consolidated, isolated module).

Consolidates the per-frequency LLM-summary logic previously spread across
``ai_enhancer_{daily,weekly,monthly}.py`` into a single, failure-isolated
entry point:

    generate_summary(frequency, payload, *, model=None, timeout_sec=None)

Design goals (BLF-772 / BLF-770 D1-D3):
- One isolated AI-summary entry point for scheduled reports.
- Failure domain is separate from ``app.services.ai.chat`` / insight services:
  this module only talks to the shared LLM primitive layer
  (``app.services.ai.llm``) and degrades to a built-in fallback on any
  timeout / error / missing key.
- Per-frequency system prompt, user-content builder, and fallback.

This module is created in Phase 1 (BLF-772) and wired into the report
builders / dispatcher in Phase 2a (BLF-773). The original ``ai_enhancer_*``
files are intentionally kept unchanged in Phase 1.
"""

from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
from typing import Any

from app.services.scheduled_report.ai_timeout import get_ai_timeout_sec
from app.services.scheduled_report.email_sender import (
    CURRENCY_CODES,
    CURRENCY_SYMBOLS,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# System prompts (frozen copies of ai_enhancer_{daily,weekly,monthly})
# ---------------------------------------------------------------------------

SYSTEM_PROMPT_DAILY = """你是一位跨境电商运营专家。请根据用户提供的数据，为运营团队生成一段简洁的日报摘要。

叙事要点（严格按此顺序）：
- 每个站点输出两行：第一行站点名，第二行销售数据
- 销售数据只需要三个指标：今日销量、近7天累计、库存 —— 不需要输出"较前一日增长/下降 X%"等单日对比分析
- 今日销量格式：`销量{quantity}单{金额}`，如 `销量8单/€208.11`
- 近7天累计格式：`近7天累计{quantity}单{金额}`，如 `近7天累计39单/€1,005.34`
- 库存格式：`库存{total_available}件`，如有在途则追加 `在途{in_transit}件`；如有缺货/告急SKU可另起一行标注
- 三个指标用中文逗号连接成一行，如：`销量8单/€208.11，近7天累计39单/€1,005.34，库存693件`

⚠️ 货币单位（必须与站点匹配）：
- 美国站(US) → 美元(USD), 金额写如 "$1,234.56" 或 "1,234.56美元"
- 德国站(DE) → 欧元(EUR), 金额写如 "€1,234.56" 或 "1,234.56欧元"
- 英国站(UK) → 英镑(GBP), 金额写如 "£1,234.56" 或 "1,234.56英镑"
- 数据中的 country 字段标识站点，金额必须使用对应站点货币
- 绝对不能对美国站使用欧元，或对英国站使用美元

强制格式规则：
1. **每个站点两行**（站点名独占一行，数据行跟在下一行）：
    示例（德国站）：
    ```
    ◉ 德国站
    销量8单/€208.11，近7天累计39单/€1,005.34，库存693件
    ```
    示例（美国站）：
    ```
    ◉ 美国站
    销量6单/$167.70，近7天累计16单/$464.60，库存225件
    ```
2. **站点之间用一个空行隔开**，确保每个站点形成独立的块。
3. 数据行**不要加括号**，不要输出"较前一日增长/下降 X%"，不要用中文逗号串接多余并列事实。
4. 库存行格式：`库存{total_available}件`，如有在途则 `库存{total_available}件在途{in_transit}件`（不加括号、不加逗号也行，保持简洁）；如有缺货/告急SKU则在该站点块内另起一行标注，如 `2个SKU缺货`。

要求：
1. 使用 bullet point（以 ◉ 开头）形式组织内容，每点独立成块，每个国家一个块
2. 多国家时每条以"XX站"开头，如"◉ 德国站"
3. 单国家时直接写数据即可（不需要站点名行）
4. 识别最重要的变化（如销量骤增/骤降、缺货），但**不要**输出单日环比百分比
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

SYSTEM_PROMPT_WEEKLY = """你是一位专业的跨境电商运营分析师。
请根据用户提供的周报数据，生成深度的运营分析报告。

分析维度（请逐一分析）：
1. 销售表现：本周 vs 上周的销量、销售额变化，重点分析变化原因
2. 归因分析：哪些 SKU 贡献了增长/下滑，贡献占比如何
3. 预警信号：识别需要关注的异常（销量下滑、退货率上升、库存告急等）
4. 积极信号：哪些表现超预期，值得保持或放大
5. 行动建议：基于数据分析给出 3-5 条具体的可执行建议

数据解读规则：
- 销量变化 >10%：标记为显著变化，需重点分析
- 销量变化 >20%：标记为剧烈变化，需立即关注
- 退货率 >3%：标记为偏高，需关注
- ACOS >25%：标记为偏高，广告效率需优化
- 库存 <7 天：标记为库存告急，需补货

输出要求：
1. 总字数控制在 300-400 字
2. 结构清晰，分段落输出（先用中文输出各分析维度的标题，再输出对应的中文分析内容）
3. 积极信号和预警信号分类呈现
4. 行动建议要具体、可执行，避免泛泛而谈
5. 保持专业简洁的运营报告风格
6. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成周度分析"
7. 只输出分析内容，不要输出其他说明

## 项目背景信息使用规则
生成分析时必须结合运营人员提供的背景信息进行综合分析：
- 如果某 SKU 正在"清仓"或做"促销/秒杀"，销量变化应归因于促销而非自然趋势
- 淡旺季数据应作为正常季节性表现，不作为运营加分项
- 结合备货周期和产能信息评估库存策略
- 结合项目状态调整评价标准（新项目看推进度，成熟期看绝对业绩）
- 发现数据与背景矛盾时，明确指出
"""

SYSTEM_PROMPT_MONTHLY = """你是一位专业的跨境电商运营分析师。
请根据用户提供的月度报告数据，生成深度的运营分析报告。

分析维度（请逐一分析）：
1. 销售表现：本月 vs 上月（环比）及 vs 去年同月（同比）的销量、销售额变化，重点分析变化原因
2. 归因分析：哪些 SKU 贡献了增长/下滑，贡献占比如何
3. 预警信号：识别需要关注的异常（销量下滑、退货率上升、库存告急等）
4. 积极信号：哪些表现超预期，值得保持或放大
5. 行动建议：基于月度数据给出 3-5 条具体的战略性建议

数据解读规则：
- 销量环比变化 >15%：标记为显著变化，需重点分析
- 销量同比变化 >30%：标记为年度趋势，需关注
- 退货率 >3%：标记为偏高，需关注
- ACOS >25%：标记为偏高，广告效率需优化
- 库存 <15 天：标记为库存告急，需补货

输出要求：
1. 总字数控制在 400-500 字
2. 结构清晰，分段落输出（先用中文输出各分析维度的标题，再输出对应的中文分析内容）
3. 积极信号和预警信号分类呈现
4. 行动建议要具体、可执行，偏向战略层面
5. 保持专业简洁的运营报告风格
6. 如果数据全为 0 或无有效数据，返回"暂无足够数据生成月度分析"
7. 只输出分析内容，不要输出其他说明

## 项目背景信息使用规则
生成分析时必须结合运营人员提供的背景信息进行综合分析：
- 如果某 SKU 正在"清仓"或做"促销/秒杀"，销量变化应归因于促销而非自然趋势
- 淡旺季数据应作为正常季节性表现，不作为运营加分项
- 结合备货周期和产能信息评估库存策略
- 结合项目状态调整评价标准（新项目看推进度，成熟期看绝对业绩）
- 发现数据与背景矛盾时，明确指出
"""

SYSTEM_PROMPTS: dict[str, str] = {
    "daily": SYSTEM_PROMPT_DAILY,
    "weekly": SYSTEM_PROMPT_WEEKLY,
    "monthly": SYSTEM_PROMPT_MONTHLY,
}


# ---------------------------------------------------------------------------
# Model resolution
# ---------------------------------------------------------------------------


def _resolve_effective_ai_model(model: str | None, settings: Any) -> str:
    """Resolve the effective model name.

    Uses the caller-supplied ``model`` when given, otherwise falls back to the
    default model resolved from the configured provider. Mirrors the resolution
    used by the original per-frequency enhancers.
    """
    from app.services.ai.llm import resolve_available_models

    _models, default_model = resolve_available_models(settings)
    return model if model else default_model


# ---------------------------------------------------------------------------
# Output cleaning (daily strips meta-info pollution)
# ---------------------------------------------------------------------------


def _clean_ai_output(text: str) -> str:
    """移除 AI 输出中常见的元信息污染（字数统计、标题行等）。"""
    text = re.sub(r"\s*[（(]\s*(?:字数[：:]?\s*|共|约)\d+\s*字\s*[)）]", "", text)
    text = re.sub(r"\s*[-—]+\s*字数[：:]\s*\d+\s*字\s*$", "", text)
    return text.strip()


# ---------------------------------------------------------------------------
# User-content builders
# ---------------------------------------------------------------------------


def _build_daily_user_content(payload: dict[str, Any]) -> str:
    """Build the daily user prompt (includes a per-country currency note)."""
    from app.services.scheduled_report.context_helpers import (
        format_project_context_for_prompt,
        format_sku_context_for_prompt,
    )

    ctx_project = payload.get("project_context")
    ctx_sku = payload.get("sku_context")
    ctx_factory = payload.get("sku_factory_info_text", "")

    display_data = {
        k: v
        for k, v in payload.items()
        if k not in ("project_context", "sku_context", "sku_factory_info_text")
    }

    is_multi = bool(payload.get("multi_country") or payload.get("countries"))
    if is_multi:
        country_codes = list(payload.get("countries", {}).keys())
    else:
        country_codes = [payload.get("country", "US")]
    currency_note_lines = []
    for cc in country_codes:
        symbol = CURRENCY_SYMBOLS.get(cc, "$")
        code = CURRENCY_CODES.get(cc, "USD")
        currency_note_lines.append(f"  - {cc} → {symbol} ({code})")
    currency_note = "\n".join(currency_note_lines)

    data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

    project_context_text = format_project_context_for_prompt(ctx_project)
    sku_context_text = format_sku_context_for_prompt(ctx_sku)

    return f"""请根据以下数据生成日报摘要：

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


def _build_periodic_user_content(payload: dict[str, Any], intro: str) -> str:
    """Build the weekly/monthly user prompt (no currency note)."""
    from app.services.scheduled_report.context_helpers import (
        format_project_context_for_prompt,
        format_sku_context_for_prompt,
    )

    ctx_project = payload.get("project_context")
    ctx_sku = payload.get("sku_context")
    ctx_factory = payload.get("sku_factory_info_text", "")

    display_data = {
        k: v
        for k, v in payload.items()
        if k not in ("project_context", "sku_context", "sku_factory_info_text")
    }
    data_str = json.dumps(display_data, ensure_ascii=False, indent=2)

    project_context_text = format_project_context_for_prompt(ctx_project)
    sku_context_text = format_sku_context_for_prompt(ctx_sku)

    return f"""{intro}

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


def _build_user_content(frequency: str, payload: dict[str, Any]) -> str:
    if frequency == "daily":
        return _build_daily_user_content(payload)
    if frequency == "weekly":
        return _build_periodic_user_content(
            payload, "请根据以下周报数据生成深度运营分析："
        )
    # monthly (default)
    return _build_periodic_user_content(
        payload, "请根据以下月度报告数据生成深度运营分析："
    )


# ---------------------------------------------------------------------------
# Fallbacks (frozen copies of ai_enhancer_{daily,weekly,monthly} fallbacks)
# ---------------------------------------------------------------------------


def _fmt_curr(amount: float, country: str = "") -> str:
    symbols = {"US": "$", "DE": "€", "UK": "£"}
    symbol = symbols.get(country, "$")
    return f"{symbol}{amount:,.2f}"


def _fallback_daily_summary(payload: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础日报摘要。"""
    sales = payload.get("sales", {})
    week_sales = payload.get("week_sales", {})
    inventory = payload.get("inventory", {})
    ads = payload.get("ads", {})
    country = payload.get("country", "US")

    today_qty = sales.get("yesterday_qty", 0)
    today_amt = sales.get("yesterday_amount", 0.0)

    p7d_qty = week_sales.get("week_qty", 0)
    p7d_amt = week_sales.get("week_amount", 0.0)

    total_available = inventory.get("total_available", 0)
    in_transit = inventory.get("in_transit", 0)
    oos_count = len(inventory.get("oos_skus", []))
    low_count = len(inventory.get("low_stock_skus", []))

    ad_roas = ads.get("roas", 0)
    ad_acos = ads.get("acos", 0)

    lines = []

    amt_str = f"/{_fmt_curr(today_amt, country)}" if today_amt > 0 else ""
    p7d_amt_str = f"/{_fmt_curr(p7d_amt, country)}" if p7d_amt > 0 else ""

    inv_parts = [f"库存{total_available}件"]
    if in_transit > 0:
        inv_parts.append(f"在途{in_transit}件")
    if oos_count > 0:
        inv_parts.append(f"{oos_count}个SKU缺货")
    if low_count > 0:
        inv_parts.append(f"{low_count}个SKU告急")

    lines.append(
        f"- 销量{today_qty}单{amt_str}，近7天累计{p7d_qty}单{p7d_amt_str}，{'，'.join(inv_parts)}"
    )

    if ad_roas > 0 or ad_acos > 0:
        roas_status = "良好" if ad_roas >= 2 else "偏低"
        lines.append(f"- 广告 ROAS {ad_roas:.2f}（{roas_status}），ACOS {ad_acos:.1f}%")

    return "\n".join(lines)


def _fallback_weekly_summary(payload: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础周报告摘要。"""
    current = payload.get("current_week", {}) or {}
    prev = payload.get("prev_week", {}) or {}
    changes = payload.get("changes", {}) or {}
    alerts = payload.get("alerts", []) or []
    top_skus = payload.get("top_skus_comparison", []) or []

    if not isinstance(current, dict):
        current = {}
    if not isinstance(prev, dict):
        prev = {}
    if not isinstance(changes, dict):
        changes = {}

    top_skus = list(top_skus)[:3]

    curr_qty = current.get("qty", 0)
    curr_amount = current.get("amount", 0)
    prev_qty = prev.get("qty", 0)
    prev_amount = prev.get("amount", 0)

    qty_change = changes.get("qty_change")
    amount_change = changes.get("amount_change")

    summary_parts = []

    summary_parts.append(f"本周销售 {curr_qty:,} 件，销售额 ${curr_amount:,.2f}。")
    if qty_change is None:
        summary_parts.append("销量环比无上期基数（上周为 0，本周新增）。")
    else:
        qty_dir = "↑" if qty_change >= 0 else "↓"
        summary_parts.append(f"销量环比 {qty_dir} {abs(qty_change):.1f}%。")
    if amount_change is None:
        summary_parts.append("销售额环比无上期基数（上周为 0，本周新增）。")
    else:
        amount_dir = "↑" if amount_change >= 0 else "↓"
        summary_parts.append(f"销售额环比 {amount_dir} {abs(amount_change):.1f}%。")

    if top_skus:
        top_sku = top_skus[0]
        sku_name = top_sku.get("sku", "N/A")
        sku_change = top_sku.get("change")
        if sku_change is None:
            summary_parts.append(f"热销 SKU：{sku_name}（上周无销量，本周新增）。")
        else:
            sku_dir = "↑" if sku_change >= 0 else "↓"
            summary_parts.append(
                f"热销 SKU：{sku_name}（{sku_dir} {abs(sku_change):.1f}%）。"
            )

    if alerts:
        critical = [a for a in alerts if a.get("type") == "critical"]
        if critical:
            summary_parts.append(
                f"⚠️ 需关注：{critical[0].get('message', '存在异常情况')}。"
            )
        else:
            warning = [a for a in alerts if a.get("type") == "warning"]
            if warning:
                summary_parts.append(
                    f"提示：{warning[0].get('message', '存在需关注项')}。"
                )

    return " ".join(summary_parts)


def _fallback_monthly_summary(payload: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础月报告摘要。"""
    current = payload.get("current_month", {}) or {}
    prev = payload.get("prev_month", {}) or {}
    yoy = payload.get("yoy_month", {}) or {}
    mom_changes = payload.get("mom_changes", {}) or {}
    yoy_changes = payload.get("yoy_changes", {}) or {}
    alerts = payload.get("alerts", []) or []
    top_skus = payload.get("top_skus_comparison", []) or []

    if not isinstance(current, dict):
        current = {}
    if not isinstance(prev, dict):
        prev = {}
    if not isinstance(mom_changes, dict):
        mom_changes = {}
    if not isinstance(yoy_changes, dict):
        yoy_changes = {}

    top_skus = list(top_skus)[:3]

    curr_qty = current.get("qty", 0)
    curr_amount = current.get("amount", 0)
    prev_qty = prev.get("qty", 0)

    qty_mom = mom_changes.get("qty_change", 0)
    amount_mom = mom_changes.get("amount_change", 0)
    qty_yoy = yoy_changes.get("qty_change", 0)
    qty_dir = "↑" if qty_mom >= 0 else "↓"
    amount_dir = "↑" if amount_mom >= 0 else "↓"
    yoy_dir = "↑" if qty_yoy >= 0 else "↓"

    summary_parts = []

    summary_parts.append(f"本月销售 {curr_qty:,} 件，销售额 ${curr_amount:,.2f}。")
    summary_parts.append(
        f"销量环比 {qty_dir} {abs(qty_mom):.1f}%，同比 {yoy_dir} {abs(qty_yoy):.1f}%。"
    )

    if top_skus:
        top_sku = top_skus[0]
        sku_name = top_sku.get("sku", "N/A")
        sku_change = top_sku.get("mom_change", 0)
        sku_dir = "↑" if sku_change >= 0 else "↓"
        summary_parts.append(
            f"热销 SKU：{sku_name}（环比 {sku_dir} {abs(sku_change):.1f}%）。"
        )

    if alerts:
        critical = [a for a in alerts if a.get("type") == "critical"]
        if critical:
            summary_parts.append(
                f"⚠️ 需关注：{critical[0].get('message', '存在异常情况')}。"
            )
        else:
            warning = [a for a in alerts if a.get("type") == "warning"]
            if warning:
                summary_parts.append(
                    f"提示：{warning[0].get('message', '存在需关注项')}。"
                )

    return " ".join(summary_parts)


def _fallback_summary(frequency: str, payload: dict[str, Any]) -> str:
    if frequency == "daily":
        return _fallback_daily_summary(payload)
    if frequency == "weekly":
        return _fallback_weekly_summary(payload)
    return _fallback_monthly_summary(payload)


# ---------------------------------------------------------------------------
# Inner AI call (wrapped by a timeout in generate_summary)
# ---------------------------------------------------------------------------


def _call_ai_inner(frequency: str, payload: dict[str, Any], model: str | None) -> str:
    """Perform the LLM call. Raises on any failure so the caller falls back."""
    from app.core.config import get_settings
    from app.services.ai.llm import (
        build_llm_config,
        generate_assistant_content,
        resolve_available_models,
    )

    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        raise RuntimeError("AI_CHAT_PROVIDER_API_KEY not configured")

    use_model = _resolve_effective_ai_model(model, settings)
    llm_config = build_llm_config(
        settings=settings,
        model=use_model,
        system_prompt=SYSTEM_PROMPTS.get(frequency, SYSTEM_PROMPT_DAILY),
        reasoning_effort=None,
    )

    user_content = _build_user_content(frequency, payload)
    result = generate_assistant_content(
        llm_config=llm_config,
        messages=[],
        user_content=user_content,
    )

    if result and result.strip():
        if frequency == "daily":
            return _clean_ai_output(result.strip())
        return result.strip()
    raise RuntimeError("AI summary returned empty content")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def generate_summary(
    frequency: str,
    payload: dict[str, Any],
    *,
    model: str | None = None,
    timeout_sec: float | None = None,
) -> str:
    """Generate the scheduled-report AI summary for ``frequency``.

    Args:
        frequency: "daily" / "weekly" / "monthly".
        payload: report data dict (same shape the original enhancers consumed).
        model: explicit model override; falls back to the default model when
            ``None``.
        timeout_sec: max seconds to wait for the LLM. When ``None``, resolved
            per-frequency from env via ``get_ai_timeout_sec``. A value ``<= 0``
            disables AI and returns the non-LLM fallback immediately.

    Returns:
        The AI-generated summary, or a built-in fallback when AI is disabled,
        times out, or errors. Never raises.
    """
    frequency = (frequency or "daily").strip().lower()
    secs = timeout_sec if timeout_sec is not None else get_ai_timeout_sec(frequency)

    # Non-LLM fallback: AI explicitly disabled (timeout 0) or no API key.
    if secs <= 0:
        return _fallback_summary(frequency, payload)

    from app.core.config import get_settings

    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        logger.warning(
            "AI_CHAT_PROVIDER_API_KEY not configured, using fallback %s summary",
            frequency,
        )
        return _fallback_summary(frequency, payload)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_call_ai_inner, frequency, payload, model)
            return future.result(timeout=secs)
    except FuturesTimeout:
        logger.warning(
            "%s AI summary timed out (%.0fs) — using fallback", frequency, secs
        )
        return _fallback_summary(frequency, payload)
    except Exception as e:
        logger.warning("%s AI summary failed, using fallback: %s", frequency, e)
        return _fallback_summary(frequency, payload)
