"""Weekly report email sender.

Re-exports shared utilities from email_sender.py.
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.scheduled_report.email_sender import (
    _fmt_currency, _safe_html, _markdown_to_email_html,
    _color_delta, _arrow_delta, _color_positive, _country_label,
    _currency_code, CURRENCY_SYMBOLS, CURRENCY_CODES,
    _render_country_sub_header,
    _scale_html_fonts,
)

logger = logging.getLogger(__name__)


# ── Helper functions ─────────────────────────────────────────────────────────


def _fmt_week_currency(val: float, country: str = "US") -> str:
    """周报专用货币格式化"""
    symbol = CURRENCY_SYMBOLS.get(country, "$")
    return f"{symbol}{val:,.2f}"


def _fmt_week_change(val: float) -> tuple[str, str, str]:
    """周报专用变化率格式化"""
    if val == 0:
        return "#6B7280", "持平", ""
    color = "#16A34A" if val > 0 else "#DC2626"
    icon = "↑" if val > 0 else "↓"
    return color, f"{icon} {abs(val):.1f}%", icon


def _render_week_kpi_card(label: str, current: str, prev: str, change: float, unit: str = "", highlight: bool = False) -> str:
    """渲染周报 KPI 卡片（每行 2 个，width=50%）"""
    color, change_str, _ = _fmt_week_change(change)
    bg_style = "background: #F0FDF4; border-color: #10B981;" if highlight else "background: white;"
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; {bg_style} vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 36px; font-weight: 900; color: #111827; line-height: 1;">{current}</div>
      <div style="font-size: 13px; color: #9CA3AF; margin: 4px 0;">{unit}</div>
      <div style="font-size: 14px; color: {color}; font-weight: 700; margin-top: 4px;">{change_str}</div>
    </td>"""


def _render_week_kpi_card_prev(label: str, current: str, unit: str = "") -> str:
    """渲染"上周数据"展示用的 KPI 卡片（无变化率）"""
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: #F9FAFB; vertical-align: top;">
      <div style="font-size: 14px; color: #9CA3AF; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 36px; font-weight: 900; color: #6B7280; line-height: 1;">{current}</div>
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
    bar_width = min(abs(pct) * 2, 100)
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


def _render_ads_comparison_cards(ads: dict, country: str = "US") -> str:
    """渲染广告效果对比卡片组"""
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

    currency_label = _currency_code(country)
    spend_card = _render_ad_card("花费", spend.get("current", 0), spend.get("prev", 0), spend.get("change", 0), currency_label, True)
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

    oos_alerts = [a for a in alerts if a.get("level") == "oos"]
    low_alerts = [a for a in alerts if a.get("level") == "low"]

    html = """<tr>
      <td style="padding: 12px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">"""

    if oos_alerts:
        html += f"""<tr>
          <td style="padding-bottom: 8px;">
            <div style="font-size: 13px; font-weight: 700; color: #DC2626; margin-bottom: 6px;">🚨 缺货 SKU ({len(oos_alerts)})</div>
            <div style="font-size: 13px; color: #374151;">{", ".join([_safe_html(a.get("sku", "")) for a in oos_alerts[:5]])}{"..." if len(oos_alerts) > 5 else ""}</div>
          </td>
        </tr>"""

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
    """渲染行动建议区块。"""
    if not action_items:
        return ""

    priority_icons = {"high": "🔴", "medium": "🟡", "low": "🟢"}

    items_html = ""
    for entry in action_items[:5]:
        if isinstance(entry, str):
            text = entry
            icon = "→"
        else:
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


# ── Content sections builder (extracted for multi-country reuse) ──────────────


def _render_weekly_content_sections(
    report_data: dict[str, Any],
    country_suffix: str = "",
) -> str:
    """Render all inner content <tr> blocks for one country (weekly report).

    Args:
        report_data: Single-country weekly report data dict.
        country_suffix: Label appended to section titles, e.g. " · 美国站".
    """
    country = report_data.get("country", "US")
    date_range = report_data.get("date_range", "")
    prev_week_range = report_data.get("prev_week_range", "")

    # 数据提取
    current_week = report_data.get("current_week", {})
    prev_week = report_data.get("prev_week", {})
    changes = report_data.get("changes", {})

    wk_qty = current_week.get("qty", 0)
    wk_amt = current_week.get("amount", 0.0)
    pr_qty = prev_week.get("qty", 0)
    pr_amt = prev_week.get("amount", 0.0)
    qty_chg = changes.get("qty_change", 0)
    amt_chg = changes.get("amount_change", 0)

    card_qty_curr = _render_week_kpi_card("本周销量", f"{wk_qty:,}", f"{pr_qty:,}", qty_chg, "件")
    card_amt_curr = _render_week_kpi_card("本周销售额", _fmt_week_currency(wk_amt, country), _fmt_week_currency(pr_amt, country), amt_chg, _currency_code(country), highlight=True)
    card_qty_prev = _render_week_kpi_card_prev("上周销量", f"{pr_qty:,}", "件")
    card_amt_prev = _render_week_kpi_card_prev("上周销售额", _fmt_week_currency(pr_amt, country), _currency_code(country))

    # 每日销量趋势
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

    # 周对比表格
    comparison_rows = [
        {"label": "📦 销量（件）", "current": f"{wk_qty:,}", "prev": f"{pr_qty:,}", "change": qty_chg},
        {"label": f"💰 销售额（{_currency_code(country)}）", "current": _fmt_week_currency(wk_amt, country), "prev": _fmt_week_currency(pr_amt, country), "change": amt_chg},
    ]
    avg_price_curr = current_week.get("avg_price", 0)
    avg_price_prev = prev_week.get("avg_price", 0)
    avg_price_chg = changes.get("avg_price_change", 0)
    if avg_price_curr > 0 or avg_price_prev > 0:
        comparison_rows.append({
            "label": f"📊 平均客单价（{_currency_code(country)}）",
            "current": _fmt_week_currency(avg_price_curr, country),
            "prev": _fmt_week_currency(avg_price_prev, country),
            "change": avg_price_chg,
        })
    comparison_table = _render_week_comparison_table(comparison_rows)

    # Top SKU 对比
    top_skus = report_data.get("top_skus_comparison", [])
    top_sku_table = _render_top_sku_comparison_table(top_skus)

    # 归因分析
    attribution = report_data.get("attribution", [])
    attribution_rows = ""
    for item in attribution[:8]:
        is_positive = item.get("contribution", 0) > 0
        attribution_rows += _render_attribution_bar(
            item.get("contribution", 0),
            item.get("pct", 0),
            is_positive,
            _safe_html(item.get("sku", ""))[:20],
        )
    attribution_table = f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">SKU</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 140px;">贡献量</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">占比</th>
      </tr></thead><tbody>{attribution_rows or '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF;">暂无数据</td></tr>'}</tbody>
    </table>"""

    # 广告对比
    ads_comparison = report_data.get("ads_comparison", {})
    ads_cards = _render_ads_comparison_cards(ads_comparison, country)

    # 库存告警
    inventory_alerts = report_data.get("inventory_alerts", [])
    inventory_section = _render_inventory_alerts_section(inventory_alerts)

    # 退货数据
    returns_data = report_data.get("returns_data", {})
    ret_qty = returns_data.get("qty", 0)
    ret_rate = returns_data.get("rate", 0.0)
    ret_clr = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"

    # SKU 销售明细
    sku_sales_detail = report_data.get("sku_sales_detail", [])
    sku_detail_section = ""
    if sku_sales_detail:
        detail_rows = ""
        for idx, item in enumerate(sku_sales_detail):
            bg = "#FFFFFF" if idx % 2 == 0 else "#FAFAFA"
            s_sku = _safe_html(item.get("sku", "—"))
            s_name = _safe_html(item.get("product_name", "—"))
            s_qty = item.get("qty", 0)
            s_amt = _fmt_currency(item.get("amount", 0.0), country)
            detail_rows += f"""<tr>
              <td style="padding: 10px 12px; font-size: 13px; color: #374151; font-weight: 600; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">{s_sku}</td>
              <td style="padding: 10px 12px; font-size: 12px; color: #6B7280; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; max-width: 160px;">{s_name}</td>
              <td style="padding: 10px 12px; font-size: 17px; font-weight: 800; color: #1D4ED8; text-align: right; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap;">{s_qty}</td>
              <td style="padding: 10px 12px; font-size: 16px; font-weight: 700; color: #059669; text-align: right; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap;">{s_amt}</td>
            </tr>"""

        sku_detail_section = f"""
      {_render_weekly_section_header("📋", f"销售 SKU 明细{country_suffix}", date_range)}
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse; table-layout: fixed;">
            <thead>
              <tr style="background: #F9FAFB;">
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 28%;">SKU</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 32%;">品名</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 15%;">数量</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">销售额</th>
              </tr>
            </thead>
            <tbody>{detail_rows}</tbody>
          </table>
        </td>
      </tr>"""

    returns_section = ""
    if ret_qty > 0 or ret_rate > 0:
        returns_section = f"""
      {_render_weekly_section_header("↩️", f"本周退货概况{country_suffix}")}
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

    # 归因分析总结
    attribution_summary = report_data.get("attribution_summary", "")
    attribution_summary_section = ""
    if attribution_summary:
        attribution_summary_html = _markdown_to_email_html(attribution_summary)
        attribution_summary_section = f"""<tr>
        <td style="padding: 4px 16px 12px;">
          <div style="font-size: 14px; color: #374151; line-height: 1.6; padding: 10px 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px;">{attribution_summary_html}</div>
        </td>
      </tr>"""

    # 行动建议
    action_items = report_data.get("action_items", [])
    action_section = _render_action_items_section(action_items)

    # 告警列表
    alerts = report_data.get("alerts", [])
    alert_section = _render_alert_section(alerts)

    # ── Assemble all content sections ──────────────────
    return f"""
      {_render_weekly_section_header("📌", f"本周运营概况{country_suffix}")}
      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_curr}{card_amt_curr}</tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_prev}{card_amt_prev}</tr>
          </table>
        </td>
      </tr>

      {sku_detail_section}

      {_render_weekly_section_header("📈", f"周销量趋势{country_suffix}", date_range)}
      <tr>
        <td style="padding: 0 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds if trend_tds else '<td style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无趋势数据</td>'}</tr>
          </table>
        </td>
      </tr>

      {_render_weekly_section_header("📈", f"周对比分析{country_suffix}", prev_week_range)}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {comparison_table}
        </td>
      </tr>

      {_render_weekly_section_header("🏆", f"热销 SKU 表现{country_suffix}", "上周 vs 上上周")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {top_sku_table}
        </td>
      </tr>

      {_render_weekly_section_header("🎯", f"销量变化归因{country_suffix}", "本周 vs 上周各 SKU 贡献")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {attribution_table}
        </td>
      </tr>

      {attribution_summary_section}

      {_render_weekly_section_header("💰", f"广告效果对比{country_suffix}", "本周 vs 上周")}
      <tr>
        <td style="padding: 6px 16px 12px;">
          {ads_cards}
        </td>
      </tr>

      {returns_section}

      {inventory_section if inventory_section else ''}

      {action_section}

      {alert_section}"""



# ── Section-first renderers (for multi-country section-first layout) ──────────


def _section_week_kpi(report_data: dict[str, Any], country: str) -> str:
    """📌 本周运营概况：本周+上周 KPI 卡片。"""
    current_week = report_data.get("current_week", {})
    prev_week = report_data.get("prev_week", {})
    changes = report_data.get("changes", {})

    wk_qty = current_week.get("qty", 0)
    wk_amt = current_week.get("amount", 0.0)
    pr_qty = prev_week.get("qty", 0)
    pr_amt = prev_week.get("amount", 0.0)
    qty_chg = changes.get("qty_change", 0)
    amt_chg = changes.get("amount_change", 0)

    card_qty_curr = _render_week_kpi_card("本周销量", f"{wk_qty:,}", f"{pr_qty:,}", qty_chg, "件")
    card_amt_curr = _render_week_kpi_card("本周销售额", _fmt_week_currency(wk_amt, country), _fmt_week_currency(pr_amt, country), amt_chg, _currency_code(country), highlight=True)
    card_qty_prev = _render_week_kpi_card_prev("上周销量", f"{pr_qty:,}", "件")
    card_amt_prev = _render_week_kpi_card_prev("上周销售额", _fmt_week_currency(pr_amt, country), _currency_code(country))

    return f"""
      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_curr}{card_amt_curr}</tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty_prev}{card_amt_prev}</tr>
          </table>
        </td>
      </tr>"""


def _section_week_sku_detail(report_data: dict[str, Any], country: str) -> str:
    """📋 销售 SKU 明细。无数据返回空串。"""
    sku_sales_detail = report_data.get("sku_sales_detail", [])
    if not sku_sales_detail:
        return ""

    detail_rows = ""
    for idx, item in enumerate(sku_sales_detail):
        bg = "#FFFFFF" if idx % 2 == 0 else "#FAFAFA"
        s_sku = _safe_html(item.get("sku", "—"))
        s_name = _safe_html(item.get("product_name", "—"))
        s_qty = item.get("qty", 0)
        s_amt = _fmt_currency(item.get("amount", 0.0), country)
        detail_rows += f"""<tr>
          <td style="padding: 10px 12px; font-size: 13px; color: #374151; font-weight: 600; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">{s_sku}</td>
          <td style="padding: 10px 12px; font-size: 12px; color: #6B7280; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; overflow: hidden; text-overflow: ellipsis; max-width: 160px;">{s_name}</td>
          <td style="padding: 10px 12px; font-size: 17px; font-weight: 800; color: #1D4ED8; text-align: right; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap;">{s_qty}</td>
          <td style="padding: 10px 12px; font-size: 16px; font-weight: 700; color: #059669; text-align: right; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle; white-space: nowrap;">{s_amt}</td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse; table-layout: fixed;">
            <thead>
              <tr style="background: #F9FAFB;">
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 28%;">SKU</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 32%;">品名</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 15%;">数量</th>
                <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">销售额</th>
              </tr>
            </thead>
            <tbody>{detail_rows}</tbody>
          </table>
        </td>
      </tr>"""


def _section_week_trend(report_data: dict[str, Any], country: str) -> str:
    """📈 周销量趋势柱图。"""
    daily_trend = report_data.get("daily_trend", [])
    date_range = report_data.get("date_range", "")
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

    trend_html = trend_tds if trend_tds else '<td style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无趋势数据</td>'

    return f"""
      <tr>
        <td style="padding: 0 16px 12px;">
          <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">{date_range}</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_html}</tr>
          </table>
        </td>
      </tr>"""


def _section_week_comparison(report_data: dict[str, Any], country: str) -> str:
    """📈 周对比分析表格。"""
    current_week = report_data.get("current_week", {})
    prev_week = report_data.get("prev_week", {})
    changes = report_data.get("changes", {})

    wk_qty = current_week.get("qty", 0)
    wk_amt = current_week.get("amount", 0.0)
    pr_qty = prev_week.get("qty", 0)
    pr_amt = prev_week.get("amount", 0.0)
    qty_chg = changes.get("qty_change", 0)
    amt_chg = changes.get("amount_change", 0)

    comparison_rows = [
        {"label": "📦 销量（件）", "current": f"{wk_qty:,}", "prev": f"{pr_qty:,}", "change": qty_chg},
        {"label": f"💰 销售额（{_currency_code(country)}）", "current": _fmt_week_currency(wk_amt, country), "prev": _fmt_week_currency(pr_amt, country), "change": amt_chg},
    ]
    avg_price_curr = current_week.get("avg_price", 0)
    avg_price_prev = prev_week.get("avg_price", 0)
    avg_price_chg = changes.get("avg_price_change", 0)
    if avg_price_curr > 0 or avg_price_prev > 0:
        comparison_rows.append({
            "label": f"📊 平均客单价（{_currency_code(country)}）",
            "current": _fmt_week_currency(avg_price_curr, country),
            "prev": _fmt_week_currency(avg_price_prev, country),
            "change": avg_price_chg,
        })
    comparison_table = _render_week_comparison_table(comparison_rows)

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          {comparison_table}
        </td>
      </tr>"""


def _section_week_top_skus(report_data: dict[str, Any], country: str) -> str:
    """🏆 热销 SKU 表现。"""
    top_skus = report_data.get("top_skus_comparison", [])
    top_sku_table = _render_top_sku_comparison_table(top_skus)
    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          {top_sku_table}
        </td>
      </tr>"""


def _section_week_attribution(report_data: dict[str, Any], country: str) -> str:
    """🎯 销量变化归因（条形图 + 文字总结）。"""
    attribution = report_data.get("attribution", [])
    attribution_summary = report_data.get("attribution_summary", "")

    attribution_rows = ""
    for item in attribution[:8]:
        is_positive = item.get("contribution", 0) > 0
        attribution_rows += _render_attribution_bar(
            item.get("contribution", 0),
            item.get("pct", 0),
            is_positive,
            _safe_html(item.get("sku", ""))[:20],
        )
    attribution_table = f"""<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">SKU</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 140px;">贡献量</th>
        <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">占比</th>
      </tr></thead><tbody>{attribution_rows or '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF;">暂无数据</td></tr>'}</tbody>
    </table>"""

    result = f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          {attribution_table}
        </td>
      </tr>"""

    if attribution_summary:
        summary_html = _markdown_to_email_html(attribution_summary)
        result += f"""
      <tr>
        <td style="padding: 4px 16px 12px;">
          <div style="font-size: 14px; color: #374151; line-height: 1.6; padding: 10px 12px; background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 6px;">{summary_html}</div>
        </td>
      </tr>"""

    return result


def _section_week_ads(report_data: dict[str, Any], country: str) -> str:
    """💰 广告效果对比卡片。"""
    ads_comparison = report_data.get("ads_comparison", {})
    ads_cards = _render_ads_comparison_cards(ads_comparison, country)
    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          {ads_cards}
        </td>
      </tr>"""


def _section_week_returns(report_data: dict[str, Any], country: str) -> str:
    """↩️ 本周退货概况。无数据返回空串。"""
    returns_data = report_data.get("returns_data", {})
    ret_qty = returns_data.get("qty", 0)
    ret_rate = returns_data.get("rate", 0.0)
    if ret_qty <= 0 and ret_rate <= 0:
        return ""

    ret_clr = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"
    return f"""
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


def _section_week_inventory_alerts(report_data: dict[str, Any], country: str) -> str:
    """📦 库存告警。无数据返回空串。"""
    inventory_alerts = report_data.get("inventory_alerts", [])
    return _render_inventory_alerts_section(inventory_alerts)


def _section_week_action_items(report_data: dict[str, Any], country: str) -> str:
    """💡 行动建议。无数据返回空串。"""
    action_items = report_data.get("action_items", [])
    return _render_action_items_section(action_items)


def _section_week_alerts(report_data: dict[str, Any], country: str) -> str:
    """⚠️ 告警区块。无数据返回空串。"""
    alerts = report_data.get("alerts", [])
    return _render_alert_section(alerts)


_WEEKLY_SECTIONS = [
    {"emoji": "📌", "title": "本周运营概况",   "color": "#2563EB", "fn": _section_week_kpi},
    {"emoji": "📋", "title": "销售 SKU 明细",  "color": "#6B7280", "fn": _section_week_sku_detail},
    {"emoji": "📈", "title": "周销量趋势",      "color": "#6366F1", "fn": _section_week_trend},
    {"emoji": "📈", "title": "周对比分析",      "color": "#2563EB", "fn": _section_week_comparison},
    {"emoji": "🏆", "title": "热销 SKU 表现",  "color": "#059669", "fn": _section_week_top_skus},
    {"emoji": "🎯", "title": "销量变化归因",    "color": "#8B5CF6", "fn": _section_week_attribution},
    {"emoji": "💰", "title": "广告效果对比",    "color": "#16A34A", "fn": _section_week_ads},
    {"emoji": "↩️", "title": "本周退货概况",   "color": "#F59E0B", "fn": _section_week_returns},
    {"emoji": "📦", "title": "库存告警",        "color": "#DC2626", "fn": _section_week_inventory_alerts},
    {"emoji": "💡", "title": "行动建议",        "color": "#065F46", "fn": _section_week_action_items},
    {"emoji": "⚠️", "title": "需要关注",       "color": "#991B1B", "fn": _section_week_alerts},
]


# ── HTML shell (header + summary + content + CTA) ────────────────────────────


def _render_country_divider() -> str:
    """Visual separator between country sections in a multi-country report."""
    return """
      <tr>
        <td style="padding: 20px 16px 4px;">
          <div style="border-top: 3px solid #E5E7EB; margin: 8px 0;"></div>
        </td>
      </tr>"""


def _wrap_weekly_html_shell(
    project_name: str,
    country_display: str,
    report_date: str,
    week_number: str,
    date_range: str,
    ai_summary_html: str,
    content_html: str,
    include_summary: bool,
    *,
    for_screenshot: bool = False,
) -> str:
    """Wrap weekly content sections with the outer HTML shell.

    Args:
        for_screenshot: True 时使用手机端窄宽度 (400px)，适配手机端截图查看。
    """
    dash_url = "https://dash.believeboy.com/dashboard"
    year = report_date[:4] if report_date else ""
    max_width = "420px" if for_screenshot else "850px"

    if for_screenshot:
        outer_style = "margin: 0; padding: 0; background: white; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
        wrapper_style = "background: white;"
        inner_style = f"max-width: {max_width}; width: 100%; background: white;"
    else:
        outer_style = "margin: 0; padding: 0; background: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;"
        wrapper_style = "background: #F3F4F6; padding: 12px 0;"
        inner_style = f"max-width: {max_width}; margin: 0 auto; background: white; border-radius: 50px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>每周运营报告 · {project_name}</title>
</head>
<body style="{outer_style}">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="{wrapper_style}">
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="{inner_style}">

      <!-- Header -->
      <tr>
        <td style="background: linear-gradient(135deg, #1F2937, #374151); padding: 24px 20px 22px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="52" style="vertical-align: middle; padding-right: 14px;">
                <img src="https://dash.believeboy.com/logo-email.png" width="52" height="52" alt="BelieveBoy" style="border-radius: 50%; display: block;" onerror="this.style.display='none'">
              </td>
              <td style="vertical-align: middle;">
                <div style="font-size: 22px; font-weight: 700; color: white;">每周运营报告</div>
                <div style="font-size: 14px; color: #9CA3AF; margin-top: 5px;">{project_name} · {country_display} · {year} 第 {week_number} 周（{date_range}）</div>
              </td>
              <td width="90" align="right" style="vertical-align: middle;">
                <span style="display: inline-block; background: #059669; color: white; font-size: 13px; font-weight: 700; padding: 5px 14px; border-radius: 20px; white-space: nowrap;">每周报告</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- 报表总结（截图模式下隐藏） -->
      {'<tr><td style="padding: 20px 16px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;"><div style="border-left: 4px solid #1D4ED8; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 10px;">🔍 报表总结</div><div style="font-size: 15px; color: #1E3A5F; line-height: 1.7; padding-left: 14px;">' + ai_summary_html + '</div></td></tr>' if include_summary else ''}

      {content_html}

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
          <div style="margin-top: 12px; font-size: 13px; color: #9CA3AF;">BelieveBoy Dashboard · {year} 第 {week_number} 周</div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── Public renderers ─────────────────────────────────────────────────────────


def _render_weekly_report_html(report_data: dict[str, Any], include_summary: bool = True, *, for_screenshot: bool = False) -> str:
    """构建每周报告 HTML 邮件（单站点路径，完全向后兼容）。

    Args:
        for_screenshot: True 时使用手机端窄宽度，不做字号缩放。
    """
    project_name = report_data.get("project_name", "项目")
    country = report_data.get("country", "US")
    week_number = report_data.get("week_number", "")
    date_range = report_data.get("date_range", "")
    report_date = report_data.get("report_date", "")

    ai_summary = _markdown_to_email_html(report_data.get("ai_summary", "暂无报表总结"))
    suffix = f" · {_country_label(country)}"
    content = _render_weekly_content_sections(report_data, country_suffix=suffix)
    html = _wrap_weekly_html_shell(project_name, _country_label(country), report_date, str(week_number), date_range, ai_summary, content, include_summary, for_screenshot=for_screenshot)
    return html if for_screenshot else _scale_html_fonts(html, 1.25)


def _render_multi_country_weekly_html(
    countries: list[str],
    country_data: dict[str, dict[str, Any]],
    project_name: str,
    report_date: str,
    week_number: str,
    date_range: str,
    ai_summary: str,
    include_summary: bool = True,
    *,
    for_screenshot: bool = False,
) -> str:
    """Render a merged multi-country weekly report with section-first layout."""
    ai_summary_html = _markdown_to_email_html(ai_summary)
    country_display = " / ".join(_country_label(c) for c in countries)

    content_parts: list[str] = []
    for section in _WEEKLY_SECTIONS:
        renderer = section["fn"]

        # Check if any country has content for this section
        has_content = False
        for country in countries:
            data = country_data.get(country, {})
            if renderer(data, country).strip():
                has_content = True
                break

        if not has_content:
            continue

        # Section header
        title = f"{section['emoji']} {section['title']}" if section["emoji"] else section["title"]
        content_parts.append(f"""
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid {section['color']}; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827;">{title}</div>
        </td>
      </tr>""")

        # Per-country content with sub-header badge
        for country in countries:
            data = country_data.get(country, {})
            section_html = renderer(data, country)
            if section_html.strip():
                content_parts.append(_render_country_sub_header(country))
                content_parts.append(section_html)

        # Light divider
        content_parts.append("""
      <tr>
        <td style="padding: 8px 16px 0;">
          <div style="border-bottom: 1px solid #F3F4F6;"></div>
        </td>
      </tr>""")

    combined_content = "\n".join(content_parts)
    html = _wrap_weekly_html_shell(project_name, country_display, report_date, str(week_number), date_range, ai_summary_html, combined_content, include_summary, for_screenshot=for_screenshot)
    return html if for_screenshot else _scale_html_fonts(html, 1.25)


# ── Email sender ─────────────────────────────────────────────────────────────


def send_weekly_report_email(email: str, report_data: dict[str, Any], stage_callback=None) -> tuple[bool, str | None]:
    """发送周报邮件。"""
    from app.core.config import get_settings

    settings = get_settings()
    if not settings.resend_api_key:
        return False, "resend_api_key not configured"

    try:
        import resend
        resend.api_key = settings.resend_api_key

        project_name = report_data.get("project_name", "项目")
        week_number = report_data.get("week_number", "")
        report_date = report_data.get("report_date", "")

        # Detect multi-country vs single-country
        raw_country = report_data.get("country", "US")
        country_list = [c.strip() for c in raw_country.split(",") if c.strip()]
        is_multi = len(country_list) > 1

        if is_multi:
            country_data = report_data.get("country_data", {})
            date_range = report_data.get("date_range", "")
            html = _render_multi_country_weekly_html(
                country_list, country_data, project_name, report_date,
                str(week_number), date_range,
                report_data.get("ai_summary", ""), include_summary=True,
            )
            screenshot_html = _render_multi_country_weekly_html(
                country_list, country_data, project_name, report_date,
                str(week_number), date_range,
                report_data.get("ai_summary", ""), include_summary=False,
                for_screenshot=True,
            )
            labels = [_country_label(c) for c in country_list]
            subject = f"BelieveBoy | {project_name} · {'/'.join(labels)} · {report_date[:4]} 第 {week_number} 周 周报"
            country_for_file = "+".join(country_list)
        else:
            html = _render_weekly_report_html(report_data, include_summary=True)
            screenshot_html = _render_weekly_report_html(report_data, include_summary=False, for_screenshot=True)
            subject = f"BelieveBoy | {project_name} · {report_date[:4]} 第 {week_number} 周 周报"
            country_for_file = country_list[0] if country_list else "US"

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email],
            "subject": subject,
            "html": html,
        }

        # 生成截图附件（不含报表总结，纯数据结构展示）
        try:
            from app.services.scheduled_report.screenshot import process_screenshot_and_upload
            if stage_callback:
                from app.models.scheduled_report import DeliveryStage
                stage_callback(DeliveryStage.CAPTURING_SCREENSHOT.value)
            email_attachment_name = f"周报_{project_name}_{country_for_file}_{week_number}.png"
            process_screenshot_and_upload(
                screenshot_html,
                report_data,
                params,
                project_name=project_name,
                email_attachment_name=email_attachment_name,
                frequency="weekly",
                country=country_for_file,
            )
        except Exception as e:
            logger.warning("截图生成跳过: %s", e)

        if stage_callback:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.SENDING.value)
        resp = resend.Emails.send(params)
        rid = resp.get("id", "")
        return True, rid

    except Exception as e:
        logger.error(f"Failed to send weekly report email to {email}: {e}")
        return False, str(e)
