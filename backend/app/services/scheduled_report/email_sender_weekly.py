"""Weekly report email sender.

Re-exports shared utilities from email_sender.py.
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.scheduled_report.email_sender import (
    _fmt_currency, _safe_html, _markdown_to_email_html,
    _color_delta, _arrow_delta, _color_positive,
)

logger = logging.getLogger(__name__)


def _fmt_week_currency(val: float) -> str:
    """周报专用货币格式化"""
    return f"${val:,.2f}"


def _fmt_week_change(val: float) -> tuple[str, str, str]:
    """周报专用变化率格式化"""
    if val == 0:
        return "#6B7280", "持平", ""
    color = "#16A34A" if val > 0 else "#DC2626"
    icon = "↑" if val > 0 else "↓"
    return color, f"{icon} {abs(val):.1f}%", icon


def _render_week_kpi_card(label: str, current: str, prev: str, change: float, unit: str = "", highlight: bool = False) -> str:
    """渲染周报 KPI 卡片（每行 2 个，width=50%）

    Args:
        show_change: 是否显示变化率。传 None 时不显示（用于"上周"卡片）
    """
    color, change_str, _ = _fmt_week_change(change)
    bg_style = "background: #F0FDF4; border-color: #10B981;" if highlight else "background: white;"
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; {bg_style} vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827; line-height: 1;">{current}</div>
      <div style="font-size: 13px; color: #9CA3AF; margin: 4px 0;">{unit}</div>
      <div style="font-size: 14px; color: {color}; font-weight: 700; margin-top: 4px;">{change_str}</div>
    </td>"""


def _render_week_kpi_card_prev(label: str, current: str, unit: str = "") -> str:
    """渲染"上周数据"展示用的 KPI 卡片（无变化率）"""
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: #F9FAFB; vertical-align: top;">
      <div style="font-size: 14px; color: #9CA3AF; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 42px; font-weight: 900; color: #6B7280; line-height: 1;">{current}</div>
      <div style="font-size: 13px; color: #D1D5DB; margin: 4px 0;">{unit}</div>
    </td>"""


def _render_week_comparison_table(rows: list[dict]) -> str:
    """渲染周报对比表格"""
    if not rows:
        return '<tr><td colspan="4" style="padding: 16px; text-align: center; color: #9CA3AF;">暂无数据</td></tr>'

    html = """<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; text-transform: uppercase; letter-spacing: 0.5px;">指标</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">本周</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">上周</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">变化</th>
      </tr></thead><tbody>"""

    for row in rows:
        color, change_str, _ = _fmt_week_change(row.get("change", 0))
        html += f"""<tr>
          <td style="padding: 12px; font-size: 14px; color: #374151; font-weight: 500; border-bottom: 1px solid #F3F4F6;">{row.get("label", "")}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; font-weight: 600; color: #111827; border-bottom: 1px solid #F3F4F6;">{row.get("current", "")}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{row.get("prev", "")}</td>
          <td style="padding: 12px; font-size: 13px; font-weight: 700; text-align: right; color: {color}; border-bottom: 1px solid #F3F4F6;">{change_str}</td>
        </tr>"""

    html += "</tbody></table>"
    return html


def _render_attribution_bar(contribution: int, pct: float, is_positive: bool, label: str) -> str:
    """渲染归因条形图（水平条）"""
    color = "#16A34A" if is_positive else "#DC2626"
    icon = "+" if is_positive else ""
    bar_width = min(abs(pct) * 2, 100)  # 放大显示，最多 100%
    return f"""<tr>
      <td style="padding: 8px 10px; font-size: 14px; color: #374151; font-weight: 500; border-bottom: 1px solid #F3F4F6; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{label}</td>
      <td style="padding: 8px 10px; width: 140px;">
        <div style="background: #E5E7EB; border-radius: 4px; height: 10px; overflow: hidden;">
          <div style="background: {color}; width: {bar_width}%; height: 100%;"></div>
        </div>
      </td>
      <td style="padding: 8px 10px; font-size: 13px; color: {color}; font-weight: 700; text-align: right; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{icon}{pct:.1f}%</td>
    </tr>"""


def _render_weekly_section_header(emoji: str, title: str, subtitle: str = "") -> str:
    """渲染周报 section 标题"""
    return f"""<tr>
      <td style="padding: 20px 16px 10px;">
        <div style="border-left: 4px solid #2563EB; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827;">{emoji} {title}</div>
        {f'<div style="font-size: 12px; color: #6B7280; margin-top: 2px; padding-left: 14px;">{subtitle}</div>' if subtitle else ''}
      </td>
    </tr>"""


def _render_top_sku_comparison_table(top_skus: list[dict]) -> str:
    """渲染 Top SKU 周对比表格"""
    if not top_skus:
        return '<tr><td colspan="5" style="padding: 16px; text-align: center; color: #9CA3AF;">暂无数据</td></tr>'

    header = """<thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">SKU</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">本周</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">上周</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">变化</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: center; font-weight: 600; border-bottom: 1px solid #E5E7EB;">状态</th>
      </tr></thead>"""

    body = ""
    for idx, sku in enumerate(top_skus[:8]):
        bg = "#EFF6FF" if idx == 0 else "#FFFFFF"
        sku_name = _safe_html(sku.get("sku", "—"))
        current = sku.get("current", 0)
        prev = sku.get("prev", 0)
        change = sku.get("change", 0)
        is_new = sku.get("new", False)

        color, change_str, _ = _fmt_week_change(change)

        # 状态标记
        if is_new:
            status = '<span style="background: #059669; color: white; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">NEW</span>'
        elif change > 50:
            status = '<span style="background: #DBEAFE; color: #1D4ED8; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">↑ 强势</span>'
        elif change < -30:
            status = '<span style="background: #FEE2E2; color: #DC2626; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">↓ 预警</span>'
        else:
            status = ""

        body += f"""<tr>
          <td style="padding: 12px; font-size: 14px; color: #374151; font-weight: 600; background: {bg}; border-bottom: 1px solid #F3F4F6;">{sku_name}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; font-weight: 700; color: #1D4ED8; background: {bg}; border-bottom: 1px solid #F3F4F6;">{current:,}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; color: #6B7280; background: {bg}; border-bottom: 1px solid #F3F4F6;">{prev:,}</td>
          <td style="padding: 12px; font-size: 13px; font-weight: 700; text-align: right; color: {color}; background: {bg}; border-bottom: 1px solid #F3F4F6;">{change_str}</td>
          <td style="padding: 12px; text-align: center; background: {bg}; border-bottom: 1px solid #F3F4F6;">{status}</td>
        </tr>"""

    return f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse;">
      {header}
      <tbody>{body}</tbody>
    </table>"""


def _render_ads_comparison_cards(ads: dict) -> str:
    """渲染广告效果对比卡片组"""
    # 提取数据
    spend = ads.get("spend", {})
    roas = ads.get("roas", {})
    acos = ads.get("acos", {})
    ctr = ads.get("ctr", {})

    def _render_ad_card(label: str, current: Any, prev: Any, change: float, unit: str = "", good_high: bool = True) -> str:
        curr_val = current if isinstance(current, (int, float)) else 0
        prev_val = prev if isinstance(prev, (int, float)) else 0

        color, change_str, _ = _fmt_week_change(change)
        if good_high:
            color = "#16A34A" if change > 0 else "#DC2626"
        else:
            color = "#16A34A" if change < 0 else "#DC2626" if change > 0 else "#6B7280"

        return f"""<td width="25%" style="padding: 14px 6px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
          <div style="font-size: 11px; color: #6B7280; margin-bottom: 6px; text-transform: uppercase;">{label}</div>
          <div style="font-size: 28px; font-weight: 800; color: #111827; line-height: 1;">{curr_val:.2f}</div>
          <div style="font-size: 12px; color: #9CA3AF; margin: 3px 0;">{unit}</div>
          <div style="font-size: 12px; color: {color}; font-weight: 600;">{change_str}</div>
        </td>"""

    # 渲染卡片行
    spend_card = _render_ad_card("花费", spend.get("current", 0), spend.get("prev", 0), spend.get("change", 0), "USD", True)
    roas_card = _render_ad_card("ROAS", roas.get("current", 0), roas.get("prev", 0), roas.get("change", 0), "广告回报率", True)
    acos_card = _render_ad_card("ACOS", acos.get("current", 0), acos.get("prev", 0), acos.get("change", 0), "%", False)
    ctr_card = _render_ad_card("CTR", ctr.get("current", 0), ctr.get("prev", 0), ctr.get("change", 0), "%", True)

    return f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <tr>{spend_card}{roas_card}{acos_card}{ctr_card}</tr>
    </table>"""


def _render_inventory_alerts_section(alerts: list[dict]) -> str:
    """渲染库存告警区块"""
    if not alerts:
        return ""

    # 分类
    oos_alerts = [a for a in alerts if a.get("level") == "oos"]
    low_alerts = [a for a in alerts if a.get("level") == "low"]

    html = """<tr>
      <td style="padding: 12px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">"""

    # 缺货 SKU
    if oos_alerts:
        html += f"""<tr>
          <td style="padding-bottom: 8px;">
            <div style="font-size: 13px; font-weight: 700; color: #DC2626; margin-bottom: 6px;">🚨 缺货 SKU ({len(oos_alerts)})</div>
            <div style="font-size: 13px; color: #374151;">{", ".join([_safe_html(a.get("sku", "")) for a in oos_alerts[:5]])}{"..." if len(oos_alerts) > 5 else ""}</div>
          </td>
        </tr>"""

    # 告急 SKU
    if low_alerts:
        html += f"""<tr>
          <td>
            <div style="font-size: 13px; font-weight: 700; color: #F59E0B; margin-bottom: 6px;">⚠️ 库存告急 ({len(low_alerts)})</div>
            <div style="font-size: 13px; color: #374151;">{", ".join([f"{_safe_html(a.get('sku', ''))}({a.get('available_qty', 0)}件)" for a in low_alerts[:5]])}{"..." if len(low_alerts) > 5 else ""}</div>
          </td>
        </tr>"""

    html += """</table>
      </td>
    </tr>"""
    return html


def _render_action_items_section(action_items: list) -> str:
    """渲染行动建议区块。

    action_items 格式: [{"priority": "high", "item": "...", "reason": "..."}]
    """
    if not action_items:
        return ""

    priority_icons = {"high": "🔴", "medium": "🟡", "low": "🟢"}

    items_html = ""
    for entry in action_items[:5]:
        if isinstance(entry, str):
            text = entry
            icon = "→"
        else:
            # 兼容 item / action 两种 key
            text = entry.get("item") or entry.get("action", "")
            reason = entry.get("reason", "")
            p = entry.get("priority", "medium")
            icon = priority_icons.get(p, "→")
            if reason:
                text = f"{text} <span style='color:#6B7280;font-size:13px;'>({reason})</span>"
        items_html += f"""<tr>
          <td style="padding: 10px 14px; font-size: 14px; color: #374151; border-bottom: 1px solid #D1FAE5;">
            <span style="margin-right: 6px;">{icon}</span>
            {text}
          </td>
        </tr>"""

    return f"""<tr>
      <td style="padding: 12px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 8px; overflow: hidden;">
          <tr><td style="padding: 10px 14px 6px; font-size: 13px; font-weight: 700; color: #065F46; border-bottom: 1px solid #D1FAE5;">💡 本周行动建议</td></tr>
          {items_html}
        </table>
      </td>
    </tr>"""


def _render_alert_section(alerts: list[dict]) -> str:
    """渲染告警区块"""
    critical = [a for a in alerts if a.get("type") == "critical"]
    warning = [a for a in alerts if a.get("type") == "warning"]

    if not critical and not warning:
        return ""

    html = """<tr>
      <td style="padding: 12px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; overflow: hidden;">
          <tr><td style="padding: 10px 14px 6px; font-size: 13px; font-weight: 700; color: #991B1B; border-bottom: 1px solid #FECACA;">⚠️ 需要关注</td></tr>"""

    for alert in (critical + warning)[:5]:
        severity_color = "#DC2626" if alert.get("type") == "critical" else "#F59E0B"
        message = alert.get("message", "")
        action = alert.get("action", "")
        html += f"""<tr>
          <td style="padding: 10px 14px; font-size: 14px; color: #374151; border-bottom: 1px solid #FEE2E2;">
            <span style="background:{severity_color};color:white;font-size:11px;font-weight:700;padding:2px 8px;border-radius:3px;margin-right:6px;vertical-align: middle;">{alert.get("type", "").upper()}</span>
            <span style="font-weight: 600;">{message}</span>
            {f'<span style="color: #6B7280; font-size: 13px;"> → {action}</span>' if action else ''}
          </td>
        </tr>"""

    html += """</table>
      </td>
    </tr>"""
    return html


def _render_weekly_report_html(report_data: dict[str, Any], include_summary: bool = True) -> str:
    """构建每周报告 HTML 邮件（完整版，利用所有数据）。

    Args:
        report_data: 完整的周报告数据字典
        include_summary: 是否包含报表总结区块。截图模式设为 False。
    """
    from datetime import date

    # ── 基础信息 ──────────────────────────────────────
    project_name = report_data.get("project_name", "项目")
    country = report_data.get("country", "US")
    week_number = report_data.get("week_number", "")
    date_range = report_data.get("date_range", "")
    prev_week_range = report_data.get("prev_week_range", "")
    dash_url = report_data.get("dash_url", "https://dash.believeboy.com/dashboard")

    # ── AI 摘要 ──────────────────────────────────────
    ai_summary = _markdown_to_email_html(report_data.get("ai_summary", "暂无报表总结"))

    # ── 数据提取 ──────────────────────────────────────
    current_week = report_data.get("current_week", {})
    prev_week = report_data.get("prev_week", {})
    changes = report_data.get("changes", {})

    # KPI 计算
    wk_qty = current_week.get("qty", 0)
    wk_amt = current_week.get("amount", 0.0)
    pr_qty = prev_week.get("qty", 0)
    pr_amt = prev_week.get("amount", 0.0)
    qty_chg = changes.get("qty_change", 0)
    amt_chg = changes.get("amount_change", 0)

    # 每行 2 个 KPI 卡片
    card_qty_curr = _render_week_kpi_card("本周销量", f"{wk_qty:,}", f"{pr_qty:,}", qty_chg, "件")
    card_amt_curr = _render_week_kpi_card("本周销售额", _fmt_week_currency(wk_amt), _fmt_week_currency(pr_amt), amt_chg, "USD", highlight=True)
    card_qty_prev = _render_week_kpi_card_prev("上周销量", f"{pr_qty:,}", "件")
    card_amt_prev = _render_week_kpi_card_prev("上周销售额", _fmt_week_currency(pr_amt), "USD")

    # ── 上周每日销量趋势（柱状图） ──────────────────────
    daily_trend = report_data.get("daily_trend", [])
    max_trend_qty = max((d.get("qty", 0) for d in daily_trend), default=1) or 1
    trend_tds = ""
    for d in daily_trend:
        q = d.get("qty", 0)
        bar_h = max(4, int(q / max_trend_qty * 60))
        weekday_label = d.get("weekday", d.get("date", ""))
        date_label = d.get("date", "")
        trend_tds += f"""
        <td width="14%" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 14px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 11px; color: #6B7280; margin-top: 3px; white-space: nowrap;">{weekday_label}</div>
          <div style="font-size: 10px; color: #9CA3AF; white-space: nowrap;">{date_label}</div>
        </td>"""

    # ── 周对比表格 ──────────────────────────────────────
    comparison_rows = [
        {"label": "📦 销量（件）", "current": f"{wk_qty:,}", "prev": f"{pr_qty:,}", "change": qty_chg},
        {"label": "💰 销售额（USD）", "current": _fmt_week_currency(wk_amt), "prev": _fmt_week_currency(pr_amt), "change": amt_chg},
    ]
    # 平均客单价
    avg_price_curr = current_week.get("avg_price", 0)
    avg_price_prev = prev_week.get("avg_price", 0)
    avg_price_chg = changes.get("avg_price_change", 0)
    if avg_price_curr > 0 or avg_price_prev > 0:
        comparison_rows.append({
            "label": "📊 平均客单价（USD）",
            "current": _fmt_week_currency(avg_price_curr),
            "prev": _fmt_week_currency(avg_price_prev),
            "change": avg_price_chg,
        })
    comparison_table = _render_week_comparison_table(comparison_rows)

    # ── Top SKU 对比 ──────────────────────────────────────
    top_skus = report_data.get("top_skus_comparison", [])
    top_sku_table = _render_top_sku_comparison_table(top_skus)

    # ── 归因分析 ──────────────────────────────────────
    attribution = report_data.get("attribution", [])
    attribution_rows = ""
    for item in attribution[:8]:
        is_positive = item.get("contribution", 0) > 0
        attribution_rows += _render_attribution_bar(
            item.get("contribution", 0),
            item.get("pct", 0),
            is_positive,
            _safe_html(item.get("sku", ""))[:20],  # 截断过长的 SKU 名
        )
    attribution_table = f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">SKU</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 140px;">贡献量</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">占比</th>
      </tr></thead><tbody>{attribution_rows or '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF;">暂无数据</td></tr>'}</tbody>
    </table>"""

    # ── 广告对比 ──────────────────────────────────────
    ads_comparison = report_data.get("ads_comparison", {})
    ads_cards = _render_ads_comparison_cards(ads_comparison)

    # ── 库存告警 ──────────────────────────────────────
    inventory_alerts = report_data.get("inventory_alerts", [])
    inventory_section = _render_inventory_alerts_section(inventory_alerts)

    # ── 退货数据 ──────────────────────────────────────
    returns_data = report_data.get("returns_data", {})
    ret_qty = returns_data.get("qty", 0)
    ret_rate = returns_data.get("rate", 0.0)
    ret_clr = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"
    returns_section = ""
    if ret_qty > 0 or ret_rate > 0:
        returns_section = f"""
      {_render_weekly_section_header("↩️", "本周退货概况")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <tr>
              <td width="50%" style="padding: 16px 10px; text-align: center; border: 1px solid #E5E7EB; background: white;">
                <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">退货数量</div>
                <div style="font-size: 36px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_qty}</div>
                <div style="font-size: 12px; color: #9CA3AF; margin-top: 4px;">件</div>
              </td>
              <td width="50%" style="padding: 16px 10px; text-align: center; border: 1px solid #E5E7EB; background: white;">
                <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">退货率</div>
                <div style="font-size: 36px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_rate:.1f}%</div>
                <div style="font-size: 12px; color: #9CA3AF; margin-top: 4px;">{"正常" if ret_rate <= 1 else "偏高" if ret_rate <= 3 else "告警"}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>"""

    # ── 归因分析总结（AI 文本） ──────────────────────────
    attribution_summary = report_data.get("attribution_summary", "")
    attribution_summary_section = ""
    if attribution_summary:
        attribution_summary_html = _markdown_to_email_html(attribution_summary)
        attribution_summary_section = f"""<tr>
        <td style="padding: 4px 16px 12px;">
          <div style="font-size: 14px; color: #374151; line-height: 1.6; padding: 10px 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px;">{attribution_summary_html}</div>
        </td>
      </tr>"""

    # ── 行动建议 ──────────────────────────────────────
    action_items = report_data.get("action_items", [])
    action_section = _render_action_items_section(action_items)

    # ── 告警列表 ──────────────────────────────────────
    alerts = report_data.get("alerts", [])
    alert_section = _render_alert_section(alerts)

    # ── 完整 HTML ──────────────────────────────────────
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>每周运营报告 · {project_name}</title>
</head>
<body style="margin: 0; padding: 0; background: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F3F4F6; padding: 12px 0;">
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width: 680px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background: linear-gradient(135deg, #1F2937, #374151); padding: 24px 20px 22px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align: middle;">
                <div style="font-size: 22px; font-weight: 700; color: white;">📊 每周运营报告</div>
                <div style="font-size: 14px; color: #9CA3AF; margin-top: 5px;">{project_name} · {country} · Week {week_number} · {date_range}</div>
              </td>
              <td width="90" align="right" style="vertical-align: middle;">
                <span style="display: inline-block; background: #059669; color: white; font-size: 13px; font-weight: 700; padding: 5px 14px; border-radius: 20px; white-space: nowrap;">每周报告</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- 报表总结（截图模式下隐藏） -->
      {'<tr><td style="padding: 20px 16px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;"><div style="border-left: 4px solid #1D4ED8; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 10px;">🔍 报表总结</div><div style="font-size: 15px; color: #1E3A5F; line-height: 1.7; padding-left: 14px;">' + ai_summary + '</div></td></tr>' if include_summary else ''}

      <!-- KPI 卡片：行1 本周 -->
      {_render_weekly_section_header("📌", "本周运营概况")}
      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_curr}{card_amt_curr}</tr>
          </table>
        </td>
      </tr>

      <!-- KPI 卡片：行2 上周 -->
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_prev}{card_amt_prev}</tr>
          </table>
        </td>
      </tr>

      <!-- 周销量趋势 -->
      {_render_weekly_section_header("📈", "周销量趋势", date_range)}
      <tr>
        <td style="padding: 0 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds if trend_tds else '<td style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无趋势数据</td>'}</tr>
          </table>
        </td>
      </tr>

      <!-- 周对比 -->
      {_render_weekly_section_header("📈", "周对比分析", prev_week_range)}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {comparison_table}
        </td>
      </tr>

      <!-- Top SKU 对比 -->
      {_render_weekly_section_header("🏆", "热销 SKU 表现", "上周 vs 上上周")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {top_sku_table}
        </td>
      </tr>

      <!-- 归因分析 -->
      {_render_weekly_section_header("🎯", "销量变化归因", "本周 vs 上周各 SKU 贡献")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {attribution_table}
        </td>
      </tr>

      <!-- 归因分析总结 -->
      {attribution_summary_section}

      <!-- 广告效果 -->
      {_render_weekly_section_header("💰", "广告效果对比", "本周 vs 上周")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {ads_cards}
        </td>
      </tr>

      <!-- 退货概况 -->
      {returns_section}

      <!-- 库存告警 -->
      {inventory_section if inventory_section else ''}

      <!-- 行动建议 -->
      {action_section}

      <!-- 告警列表 -->
      {alert_section}

      <!-- 数据说明 -->
      <tr>
        <td style="padding: 0 16px 10px;">
          <div style="padding: 12px 14px; background: #FFFBEB; border-left: 3px solid #F59E0B; border-radius: 6px;">
            <div style="font-size: 13px; color: #92400E; line-height: 1.6;">💡 数据来源于 Amazon Seller Central 自动同步，每周一 09:00 准时推送。如有异常请登录仪表板核查。</div>
          </div>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="padding: 12px 16px 24px; text-align: center; border-top: 1px solid #F3F4F6;">
          <a href="{dash_url}"
             style="display: inline-block; background: #2563EB; color: white; text-decoration: none; padding: 13px 32px; border-radius: 8px; font-size: 16px; font-weight: 700;">
            查看完整仪表板 →
          </a>
          <div style="margin-top: 12px; font-size: 13px; color: #9CA3AF;">BelieveBoy Dashboard · Week {week_number}</div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


def send_weekly_report_email(email: str, report_data: dict[str, Any]) -> tuple[bool, str | None]:
    """发送周报邮件。"""
    from app.core.config import get_settings

    settings = get_settings()
    if not settings.resend_api_key:
        return False, "resend_api_key not configured"

    try:
        import resend
        resend.api_key = settings.resend_api_key

        # 邮件 HTML（含报表总结）
        html = _render_weekly_report_html(report_data, include_summary=True)
        project_name = report_data.get("project_name", "项目")
        week_number = report_data.get("week_number", "")

        subject = f"📊 {project_name} · Week {week_number} 周报"

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email],
            "subject": subject,
            "html": html,
        }

        # 生成截图附件（不含报表总结，纯数据结构展示）
        try:
            from app.services.scheduled_report.screenshot import html_to_png
            screenshot_html = _render_weekly_report_html(report_data, include_summary=False)
            png_bytes = html_to_png(screenshot_html)
            if png_bytes:
                import base64
                filename = f"周报_{project_name}_{week_number}.png"
                params["attachments"] = [{
                    "filename": filename,
                    "content": base64.b64encode(png_bytes).decode("ascii"),
                    "content_type": "image/png",
                }]

                try:
                    from datetime import datetime
                    from app.services.r2_service import upload_bytes_to_r2
                    from app.services.upload_service import _safe_project_folder_name

                    settings = get_settings()
                    project_slug = _safe_project_folder_name(project_name)
                    country = report_data.get("country", "US")
                    report_date = report_data.get("report_date", "")
                    ts = datetime.now().strftime("%Y%m%dT%H%M%S")
                    r2_filename = f"{report_date}_weekly_{country}_{ts}.png"

                    r2_result = upload_bytes_to_r2(
                        settings=settings,
                        data=png_bytes,
                        filename=r2_filename,
                        project_slug=project_slug,
                        file_type="scheduled-reports",
                        content_type="image/png",
                    )
                    logger.info("截图已上传到 R2: key=%s url=%s", r2_result["key"], r2_result["url"])
                except Exception as r2_err:
                    logger.warning("截图上传到 R2 失败（邮件已发送）: %s", r2_err)
        except Exception as e:
            logger.warning("截图生成跳过: %s", e)

        resp = resend.Emails.send(params)
        rid = resp.get("id", "")
        return True, rid

    except Exception as e:
        logger.error(f"Failed to send weekly report email to {email}: {e}")
        return False, str(e)