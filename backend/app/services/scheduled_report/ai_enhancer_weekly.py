"""AI-powered weekly report summary and insight generator.

This module handles weekly report-specific AI analysis including:
- Week-over-week comparison insights
- Change attribution analysis
- Alert detection and prioritization
- Actionable recommendations
"""

from __future__ import annotations

import json
import logging
from typing import Any

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# System prompt for weekly report AI analysis
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

# Simplified system prompt for fallback scenarios
FALLBACK_SYSTEM_PROMPT = """你是一位跨境电商运营分析师。
请根据数据生成简洁的周报摘要。
要求：150-200字，分段落，风格专业，只输出分析内容。"""


WEEKLY_AI_TIMEOUT_SEC = 30


def generate_weekly_ai_summary(
    report_data: dict[str, Any],
    model: str | None = None,
    timeout: float | None = None,
) -> str:
    """调用 AI 服务生成周报告深度分析，支持可配置超时。

    使用线程级超时机制，确保在 ThreadPoolExecutor 工作线程中也能生效。
    超时后立即返回 fallback 摘要，不阻塞后续截图和邮件发送。

    Args:
        report_data: 包含周报告完整数据的字典
        model: 指定 AI 模型名称，空则使用默认模型
        timeout: AI 调用最大等待秒数，默认 WEEKLY_AI_TIMEOUT_SEC

    Returns:
        AI 生成的周报告分析文本
    """
    secs = timeout if timeout is not None else WEEKLY_AI_TIMEOUT_SEC

    if secs <= 0:
        return _generate_fallback_weekly_summary(report_data)

    from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

    def _call_weekly_ai():
        return _call_weekly_ai_inner(report_data, model)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(_call_weekly_ai)
            return future.result(timeout=secs)
    except FuturesTimeout:
        logger.warning(
            "Weekly AI summary timed out (%.0fs) — using fallback",
            secs,
        )
        return _generate_fallback_weekly_summary(report_data)
    except Exception as e:
        logger.warning("Weekly AI summary failed, using fallback: %s", e)
        return _generate_fallback_weekly_summary(report_data)


def _call_weekly_ai_inner(
    report_data: dict[str, Any],
    model: str | None = None,
) -> str:
    """Inner function for weekly AI call (extracted for timeout wrapping)."""
    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        logger.warning("AI_CHAT_PROVIDER_API_KEY not configured, using fallback weekly summary")
        return _generate_fallback_weekly_summary(report_data)

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
        system_prompt=SYSTEM_PROMPT_WEEKLY,
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

    user_content = f"""请根据以下周报数据生成深度运营分析：

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
        return result.strip()
    return _generate_fallback_weekly_summary(report_data)


def _generate_fallback_weekly_summary(report_data: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础周报告摘要。
    
    包含：
    - 本周 vs 上周对比
    - 关键变化摘要
    - 简单预警提示
    """
    current = report_data.get("current_week", {}) or {}
    prev = report_data.get("prev_week", {}) or {}
    changes = report_data.get("changes", {}) or {}
    alerts = report_data.get("alerts", []) or []
    top_skus = report_data.get("top_skus_comparison", []) or []

    if not isinstance(current, dict):
        current = {}
    if not isinstance(prev, dict):
        prev = {}
    if not isinstance(changes, dict):
        changes = {}

    top_skus = list(top_skus)[:3]

    # 基础数据
    curr_qty = current.get("qty", 0)
    curr_amount = current.get("amount", 0)
    prev_qty = prev.get("qty", 0)
    prev_amount = prev.get("amount", 0)

    # 变化方向
    qty_change = changes.get("qty_change", 0)
    amount_change = changes.get("amount_change", 0)
    qty_dir = "↑" if qty_change >= 0 else "↓"
    amount_dir = "↑" if amount_change >= 0 else "↓"

    # 构建摘要
    summary_parts = []

    # 销售概览
    summary_parts.append(f"本周销售 {curr_qty:,} 件，销售额 ${curr_amount:,.2f}。")
    summary_parts.append(f"销量环比 {qty_dir} {abs(qty_change):.1f}%，销售额环比 {amount_dir} {abs(amount_change):.1f}%。")

    # Top SKU 亮点
    if top_skus:
        top_sku = top_skus[0]
        sku_name = top_sku.get("sku", "N/A")
        sku_change = top_sku.get("change", 0)
        sku_dir = "↑" if sku_change >= 0 else "↓"
        summary_parts.append(f"热销 SKU：{sku_name}（{sku_dir} {abs(sku_change):.1f}%）。")

    # 预警提示
    if alerts:
        critical = [a for a in alerts if a.get("type") == "critical"]
        if critical:
            summary_parts.append(f"⚠️ 需关注：{critical[0].get('message', '存在异常情况')}。")
        else:
            warning = [a for a in alerts if a.get("type") == "warning"]
            if warning:
                summary_parts.append(f"提示：{warning[0].get('message', '存在需关注项')}。")

    return " ".join(summary_parts)


def generate_weekly_attribution_analysis(
    report_data: dict[str, Any],
    model: str | None = None,
) -> str:
    """生成归因分析文本，专门分析销售变化的原因。

    Args:
        report_data: 包含 attribution 数据的报告字典
        model: 指定 AI 模型名称，空则使用默认模型

    Returns:
        归因分析文本
    """
    settings = get_settings()
    if not settings.ai_chat_provider_api_key:
        return _fallback_attribution_analysis(report_data)

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
            system_prompt="你是电商数据分析师。分析以下 SKU 贡献数据，用 bullet point 列出关键发现。要求：每条一句话，最多 5 条，直接输出要点，不要标题或多余说明。使用标准 markdown 列表格式（以 - 开头）。格式示例：\n- SKU-A 贡献最大（+40件，占比26%）\n- SKU-B 为新品首周，表现强劲",
            reasoning_effort=None,
        )

        attribution_data = report_data.get("attribution", [])
        user_content = json.dumps({"attribution": attribution_data}, ensure_ascii=False, indent=2)
        result = generate_assistant_content(
            llm_config=llm_config,
            messages=[],
            user_content=user_content,
        )

        return result.strip() if result else _fallback_attribution_analysis(report_data)

    except Exception as e:
        logger.error(f"Weekly attribution analysis failed: {e}")
        return _fallback_attribution_analysis(report_data)


def _fallback_attribution_analysis(report_data: dict[str, Any]) -> str:
    """当 AI 服务不可用时，生成基础归因分析。"""
    attribution = report_data.get("attribution", [])
    if not attribution:
        return "暂无 SKU 归因数据。"

    positive = [a for a in attribution if a.get("type") == "positive"]
    negative = [a for a in attribution if a.get("type") == "negative"]

    parts = []
    if positive:
        total_pos = sum(a.get("contribution", 0) for a in positive)
        parts.append(f"正向贡献：{len(positive)} 个 SKU 贡献 {total_pos} 件销量。")
        top_pos = positive[0]
        parts.append(f"最大正向贡献：{top_pos.get('sku', 'N/A')} 贡献 {top_pos.get('contribution', 0):+} 件（占比 {top_pos.get('pct', 0):.1f}%）。")

    if negative:
        total_neg = sum(a.get("contribution", 0) for a in negative)
        parts.append(f"负向贡献：{len(negative)} 个 SKU 导致 {total_neg} 件销量下滑。")
        top_neg = negative[0]
        parts.append(f"最大下滑：{top_neg.get('sku', 'N/A')} 减少 {abs(top_neg.get('contribution', 0))} 件（占比 {top_neg.get('pct', 0):.1f}%）。")

    return " ".join(parts) if parts else "本周销售变化主要由头部 SKU 驱动。"


def generate_weekly_alert_insights(
    report_data: dict[str, Any],
) -> str:
    """生成预警信号分析，包括严重程度和建议。
    
    Args:
        report_data: 包含 alerts 数据的报告字典
    
    Returns:
        预警分析文本（包含优先级和建议）
    """
    alerts = report_data.get("alerts", [])
    if not alerts:
        return "本周无显著预警信号。"

    # 按严重程度分组
    critical = [a for a in alerts if a.get("type") == "critical"]
    warning = [a for a in alerts if a.get("type") == "warning"]
    positive = [a for a in alerts if a.get("type") == "positive"]

    parts = []

    if critical:
        parts.append(f"🔴 严重（{len(critical)} 项）：")
        for a in critical[:2]:
            parts.append(f"  · {a.get('message', '异常')}")
            if a.get("action"):
                parts.append(f"    → 建议：{a.get('action')}")

    if warning:
        parts.append(f"🟡 注意（{len(warning)} 项）：")
        for a in warning[:3]:
            parts.append(f"  · {a.get('message', '需关注')}")
            if a.get("action"):
                parts.append(f"    → 建议：{a.get('action')}")

    if positive:
        parts.append(f"🟢 积极（{len(positive)} 项）：")
        for a in positive[:2]:
            parts.append(f"  · {a.get('message', '表现良好')}")

    return "\n".join(parts)


def generate_weekly_action_items(
    report_data: dict[str, Any],
) -> list[dict[str, str]]:
    """从周报数据中提取行动建议，并按优先级排序。
    
    Args:
        report_data: 完整的周报告数据
    
    Returns:
        行动建议列表，每项包含 priority, item, reason
    """
    alerts = report_data.get("alerts", [])
    actions = []

    # 从预警中提取行动建议
    for alert in alerts:
        action = alert.get("action")
        if action:
            priority = "high" if alert.get("type") == "critical" else "medium"
            actions.append({
                "priority": priority,
                "item": action,
                "reason": alert.get("message", ""),
            })

    # 归因分析建议
    attribution = report_data.get("attribution", [])
    negative = [a for a in attribution if a.get("type") == "negative" and a.get("change", 0) < -10]
    if negative:
        top_neg = negative[0]
        actions.append({
            "priority": "high",
            "item": f"调查 {top_neg.get('sku', 'N/A')} 销量下滑原因",
            "reason": f"该 SKU 销量下降 {abs(top_neg.get('change', 0)):.1f}%",
        })

    # 库存预警建议
    inventory = report_data.get("inventory_alerts", [])
    oos = [i for i in inventory if i.get("level") == "oos"]
    if oos:
        actions.append({
            "priority": "high",
            "item": f"SKU {oos[0].get('sku', 'N/A')} 缺货，需立即补货",
            "reason": f"库存为 {oos[0].get('available_qty', 0)} 件",
        })

    # 按优先级排序
    priority_order = {"high": 0, "medium": 1, "low": 2}
    actions.sort(key=lambda x: priority_order.get(x["priority"], 2))

    return actions[:5]  # 最多返回 5 条


def detect_weekly_anomalies(
    current_week: dict[str, Any],
    prev_week: dict[str, Any],
    ads_comparison: dict[str, Any],
    returns_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """检测周报告中的异常信号。
    
    检测规则：
    - 销量变化 >15%：标记为显著异常
    - 退货率 >3%：标记为偏高
    - ACOS 上升 >20%：标记为广告效率恶化
    - 均单价变化 >10%：标记为价格异常
    
    Args:
        current_week: 本周数据
        prev_week: 上周数据
        ads_comparison: 广告对比数据
        returns_data: 退货数据
    
    Returns:
        异常信号列表，每项包含 type, severity, message, value, threshold
    """
    anomalies = []

    # 销量异常
    curr_qty = current_week.get("qty", 0)
    prev_qty = prev_week.get("qty", 0)
    if prev_qty > 0:
        qty_change = ((curr_qty - prev_qty) / prev_qty) * 100
        if abs(qty_change) > 15:
            severity = "critical" if abs(qty_change) > 25 else "warning"
            direction = "大幅上升" if qty_change > 0 else "大幅下滑"
            anomalies.append({
                "type": "sales",
                "severity": severity,
                "message": f"销量{direction} {abs(qty_change):.1f}%",
                "value": curr_qty,
                "threshold": 15,
                "action": "检查竞品动态和库存情况" if qty_change < 0 else "分析增长原因并保持",
            })

    # 均单价异常
    curr_price = current_week.get("avg_price", 0)
    prev_price = prev_week.get("avg_price", 0)
    if prev_price > 0:
        price_change = ((curr_price - prev_price) / prev_price) * 100
        if abs(price_change) > 10:
            direction = "上涨" if price_change > 0 else "下降"
            anomalies.append({
                "type": "price",
                "severity": "warning",
                "message": f"均单价{direction} {abs(price_change):.1f}%",
                "value": curr_price,
                "threshold": 10,
                "action": "检查是否有促销活动或价格调整" if price_change < 0 else "确认价格策略是否正确",
            })

    # 退货率异常
    return_rate = returns_data.get("rate", 0)
    if return_rate > 3:
        severity = "critical" if return_rate > 5 else "warning"
        anomalies.append({
            "type": "returns",
            "severity": severity,
            "message": f"退货率 {return_rate:.1f}% 超过警戒线",
            "value": return_rate,
            "threshold": 3,
            "action": "检查物流合作和产品质量",
        })

    # ACOS 异常
    curr_acos = ads_comparison.get("acos", {}).get("current", 0)
    prev_acos = ads_comparison.get("acos", {}).get("prev", 0)
    if prev_acos > 0:
        acos_change = ((curr_acos - prev_acos) / prev_acos) * 100
        if acos_change > 20:
            anomalies.append({
                "type": "acos",
                "severity": "warning",
                "message": f"ACOS 上升 {acos_change:.1f}%",
                "value": curr_acos,
                "threshold": 20,
                "action": "优化广告投放策略",
            })

    return anomalies
