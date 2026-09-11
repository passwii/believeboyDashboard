"""Monthly report email sender.

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
    fallback_summary_text,
)
from app.services.scheduled_report.email_sender_weekly import (
    _render_inventory_alerts_section, _render_action_items_section,
)
from app.services.scheduled_report._name_utils import (
    sanitize_filename_segment,
    truncate_project_name_for_subject,
)

logger = logging.getLogger(__name__)


def _get_logo_src(for_screenshot: bool) -> str:
    """截图模式优先用本地 base64 data URI，邮件模式保持外网 URL。"""
    if not for_screenshot:
        return "https://dash.believeboy.com/logo-email.png"
    from app.services.scheduled_report.screenshot import get_logo_src_for_screenshot
    return get_logo_src_for_screenshot()


# ── Helper functions ─────────────────────────────────────────────────────────


def _fmt_month_currency(val: float, country: str = "US") -> str:
    """月报专用货币格式化"""
    symbol = CURRENCY_SYMBOLS.get(country, "$")
    return f"{symbol}{val:,.2f}"


def _fmt_month_change(val: float) -> tuple[str, str, str]:
    """月报专用变化率格式化"""
    if val == 0:
        return "#6B7280", "持平", ""
    color = "#16A34A" if val > 0 else "#DC2626"
    icon = "↑" if val > 0 else "↓"
    return color, f"{icon} {abs(val):.1f}%", icon


def _render_month_kpi_card(label: str, current: str, prev: str, change: float, highlight: bool = False) -> str:
    """渲染月报 KPI 卡片（带变化率）"""
    color, change_str, _ = _fmt_month_change(change)
    bg_style = "background: #F0FDF4; border-color: #10B981;" if highlight else "background: white;"
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; {bg_style} vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 36px; font-weight: 900; color: #111827; line-height: 1;">{current}</div>
      <div style="font-size: 14px; color: {color}; font-weight: 700; margin-top: 6px;">{change_str}</div>
    </td>"""


def _render_month_kpi_card_ref(label: str, current: str) -> str:
    """渲染月报参考值 KPI 卡片（无变化率）"""
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: #F9FAFB; vertical-align: top;">
      <div style="font-size: 14px; color: #9CA3AF; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 36px; font-weight: 900; color: #6B7280; line-height: 1;">{current}</div>
    </td>"""


def _render_month_section_header(emoji: str, title: str, subtitle: str = "") -> str:
    """渲染月报 section 标题"""
    return f"""<tr>
      <td style="padding: 20px 16px 10px;">
        <div style="border-left: 4px solid #2563EB; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827;">{emoji} {title}</div>
        {f'<div style="font-size: 12px; color: #6B7280; margin-top: 2px; padding-left: 14px;">{subtitle}</div>' if subtitle else ''}
      </td>
    </tr>"""


# ── Content sections (for multi-country section-first layout) ────────────────


def _section_month_kpi(report_data: dict[str, Any], country: str) -> str:
    """📌 月度运营概况：本月+参考值 KPI 卡片。"""
    curr = report_data.get("current_month", {})
    prev = report_data.get("prev_month", {})
    yoy = report_data.get("yoy_month", {})
    mom = report_data.get("mom_changes", {})

    wk_qty = curr.get("qty", 0)
    wk_amt = curr.get("amount", 0.0)
    pr_qty = prev.get("qty", 0)
    pr_amt = prev.get("amount", 0.0)
    yoy_qty = yoy.get("qty", 0)
    yoy_amt = yoy.get("amount", 0.0)
    qty_chg = mom.get("qty_change", 0)
    amt_chg = mom.get("amount_change", 0)

    card_qty = _render_month_kpi_card("本月销量", f"{wk_qty:,}", f"{pr_qty:,}", qty_chg)
    card_amt = _render_month_kpi_card("本月销售额", _fmt_month_currency(wk_amt, country), _fmt_month_currency(pr_amt, country), amt_chg, highlight=True)
    card_prev = _render_month_kpi_card_ref("上月销量", f"{pr_qty:,}")
    card_yoy = _render_month_kpi_card_ref("去年同月销量", f"{yoy_qty:,}")

    return f"""
      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty}{card_amt}</tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_prev}{card_yoy}</tr>
          </table>
        </td>
      </tr>"""


def _section_month_sku_detail(report_data: dict[str, Any], country: str) -> str:
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


def _section_month_trend(report_data: dict[str, Any], country: str) -> str:
    """📈 月内周趋势。无数据返回空串。"""
    weekly_trend = report_data.get("weekly_trend", [])
    if not weekly_trend:
        return ""

    max_qty = max((w.get("qty", 0) for w in weekly_trend), default=1) or 1
    cols_count = len(weekly_trend)
    col_pct = f"{100 // cols_count}%" if cols_count > 0 else "25%"

    trend_tds = ""
    for w in weekly_trend:
        q = w.get("qty", 0)
        bar_h = max(4, int(q / max_qty * 60))
        label = w.get("label", "")
        date_range = f"{w.get('start', '')[-5:]}~{w.get('end', '')[-5:]}"
        trend_tds += f"""
        <td width="{col_pct}" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 14px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q:,}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 11px; color: #6B7280; margin-top: 3px; white-space: nowrap;">{label}</div>
          <div style="font-size: 10px; color: #9CA3AF; white-space: nowrap;">{date_range}</div>
        </td>"""

    return f"""
      <tr>
        <td style="padding: 0 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds if trend_tds else '<td style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无趋势数据</td>'}</tr>
          </table>
        </td>
      </tr>"""


def _section_month_comparison(report_data: dict[str, Any], country: str) -> str:
    """📈 月对比分析。单表 5 列（本月/上月/环比/去年同月/同比）。"""
    curr = report_data.get("current_month", {})
    prev = report_data.get("prev_month", {})
    yoy = report_data.get("yoy_month", {})
    mom = report_data.get("mom_changes", {})
    yoy_c = report_data.get("yoy_changes", {})

    wk_qty = curr.get("qty", 0)
    wk_amt = curr.get("amount", 0.0)
    wk_price = curr.get("avg_price", 0)
    pr_qty = prev.get("qty", 0)
    pr_amt = prev.get("amount", 0.0)
    pr_price = prev.get("avg_price", 0)
    yoy_qty = yoy.get("qty", 0)
    yoy_amt = yoy.get("amount", 0.0)
    yoy_price = yoy.get("avg_price", 0)

    def _fmt_val(val, fmt_type):
        if fmt_type == "qty":
            return f"{int(val):,}"
        elif fmt_type == "amt":
            return _fmt_month_currency(val, country)
        else:
            return _fmt_month_currency(val, country)

    rows_data = [
        ("销量", wk_qty, pr_qty, yoy_qty, mom.get("qty_change", 0), yoy_c.get("qty_change", 0), "qty"),
        ("销售额", wk_amt, pr_amt, yoy_amt, mom.get("amount_change", 0), yoy_c.get("amount_change", 0), "amt"),
    ]
    if wk_price > 0 or pr_price > 0:
        rows_data.append(("平均客单价", wk_price, pr_price, yoy_price, mom.get("avg_price_change", 0), yoy_c.get("avg_price_change", 0), "price"))

    header = """<thead><tr style="background: #F9FAFB;">
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; text-transform: uppercase; letter-spacing: 0.5px;">指标</th>
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">本月</th>
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">上月</th>
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">环比</th>
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">去年同月</th>
      <th style="padding: 10px 12px; font-size: 12px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">同比</th>
    </tr></thead>"""

    body = ""
    for label, cv, pv, yv, mom_pct, yoy_pct, fmt_type in rows_data:
        mc, ms, _ = _fmt_month_change(mom_pct)
        yc, ys, _ = _fmt_month_change(yoy_pct)
        body += f"""<tr>
          <td style="padding: 12px; font-size: 14px; color: #374151; font-weight: 500; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; font-weight: 600; color: #111827; border-bottom: 1px solid #F3F4F6;">{_fmt_val(cv, fmt_type)}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{_fmt_val(pv, fmt_type)}</td>
          <td style="padding: 12px; font-size: 13px; font-weight: 700; text-align: right; color: {mc}; border-bottom: 1px solid #F3F4F6;">{ms}</td>
          <td style="padding: 12px; font-size: 14px; text-align: right; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{_fmt_val(yv, fmt_type)}</td>
          <td style="padding: 12px; font-size: 13px; font-weight: 700; text-align: right; color: {yc}; border-bottom: 1px solid #F3F4F6;">{ys}</td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse;">
            {header}
            <tbody>{body}</tbody>
          </table>
        </td>
      </tr>"""


def _section_month_top_skus(report_data: dict[str, Any], country: str) -> str:
    """🏆 热销 SKU 表现（三级对比）。无数据返回空串。"""
    top_skus = report_data.get("top_skus_comparison", [])
    if not top_skus:
        return ""

    header = """<thead><tr style="background: #F9FAFB;">
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">SKU</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">本月</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">上月</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">环比</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">去年同月</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">同比</th>
      <th style="padding: 10px 8px; font-size: 11px; color: #6B7280; text-align: center; font-weight: 600; border-bottom: 1px solid #E5E7EB;">状态</th>
    </tr></thead>"""

    body = ""
    for idx, sku in enumerate(top_skus[:8]):
        bg = "#EFF6FF" if idx == 0 else "#FFFFFF"
        sku_name = _safe_html(sku.get("sku", "—"))
        curr_qty = sku.get("curr_qty", sku.get("current", 0))
        prev_qty = sku.get("prev_qty", sku.get("prev", 0))
        yoy_qty = sku.get("yoy_qty", 0)
        mom_change = sku.get("mom_change", sku.get("change", 0))
        yoy_change = sku.get("yoy_change", 0)
        is_new = sku.get("new", False)

        mc, ms, _ = _fmt_month_change(mom_change)
        yc, ys, _ = _fmt_month_change(yoy_change)

        if is_new:
            status = '<span style="background: #059669; color: white; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">NEW</span>'
        elif mom_change > 50:
            status = '<span style="background: #DBEAFE; color: #1D4ED8; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">↑ 强势</span>'
        elif mom_change < -30:
            status = '<span style="background: #FEE2E2; color: #DC2626; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px;">↓ 预警</span>'
        else:
            status = ""

        body += f"""<tr>
          <td style="padding: 10px 8px; font-size: 13px; color: #374151; font-weight: 600; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100px;">{sku_name}</td>
          <td style="padding: 10px 8px; font-size: 14px; text-align: right; font-weight: 700; color: #1D4ED8; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{curr_qty:,}</td>
          <td style="padding: 10px 8px; font-size: 13px; text-align: right; color: #6B7280; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{prev_qty:,}</td>
          <td style="padding: 10px 8px; font-size: 12px; font-weight: 700; text-align: right; color: {mc}; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{ms}</td>
          <td style="padding: 10px 8px; font-size: 13px; text-align: right; color: #6B7280; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{yoy_qty:,}</td>
          <td style="padding: 10px 8px; font-size: 12px; font-weight: 700; text-align: right; color: {yc}; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap;">{ys}</td>
          <td style="padding: 10px 8px; text-align: center; background: {bg}; border-bottom: 1px solid #F3F4F6;">{status}</td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse;">
            {header}
            <tbody>{body}</tbody>
          </table>
        </td>
      </tr>"""


def _section_month_ads(report_data: dict[str, Any], country: str) -> str:
    """💰 广告效果对比（环比+同比双标签）。无数据返回空串。"""
    ads = report_data.get("ads_comparison", {})
    if not ads:
        return ""

    def _render_ad_card(label: str, current: Any, mom_change: float, yoy_change: float, unit: str = "", good_high: bool = True) -> str:
        curr_val = current if isinstance(current, (int, float)) else 0

        if good_high:
            mc = "#16A34A" if mom_change > 0 else "#DC2626"
            yc = "#16A34A" if yoy_change > 0 else "#DC2626"
        else:
            mc = "#16A34A" if mom_change < 0 else "#DC2626" if mom_change > 0 else "#6B7280"
            yc = "#16A34A" if yoy_change < 0 else "#DC2626" if yoy_change > 0 else "#6B7280"

        _, ms, _ = _fmt_month_change(mom_change)
        _, ys, _ = _fmt_month_change(yoy_change)

        return f"""<td width="25%" style="padding: 14px 6px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
          <div style="font-size: 11px; color: #6B7280; margin-bottom: 6px; text-transform: uppercase;">{label}</div>
          <div style="font-size: 28px; font-weight: 800; color: #111827; line-height: 1;">{curr_val:.2f}</div>
          <div style="font-size: 12px; color: #9CA3AF; margin: 3px 0;">{unit}</div>
          <div style="font-size: 11px; color: {mc}; font-weight: 600;">环比 {ms}</div>
          <div style="font-size: 11px; color: {yc}; font-weight: 600;">同比 {ys}</div>
        </td>"""

    spend = ads.get("spend", {})
    roas = ads.get("roas", {})
    acos = ads.get("acos", {})
    ctr = ads.get("ctr", {})
    ad_ratio_all = ads.get("ad_ratio_all", {})

    currency_label = _currency_code(country)
    spend_card = _render_ad_card("花费", spend.get("current", 0), spend.get("mom_change", 0), spend.get("yoy_change", 0), currency_label, True)
    roas_card = _render_ad_card("ROAS", roas.get("current", 0), roas.get("mom_change", 0), roas.get("yoy_change", 0), "广告回报率", True)
    acos_card = _render_ad_card("ACOS", acos.get("current", 0), acos.get("mom_change", 0), acos.get("yoy_change", 0), "%", False)
    ctr_card = _render_ad_card("CTR", ctr.get("current", 0), ctr.get("mom_change", 0), ctr.get("yoy_change", 0), "%", True)
    ratio_card = _render_ad_card("广告占比", ad_ratio_all.get("current", 0), ad_ratio_all.get("mom_change", 0), ad_ratio_all.get("yoy_change", 0), "%", False)

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <tr>{spend_card}{roas_card}{acos_card}{ctr_card}{ratio_card}</tr>
          </table>
        </td>
      </tr>"""


def _section_month_returns(report_data: dict[str, Any], country: str) -> str:
    """↩️ 退货及库存概况。无数据返回空串。"""
    returns_data = report_data.get("returns_data", {})
    ret_qty = returns_data.get("qty", 0)
    ret_rate = returns_data.get("rate", 0.0)
    ret_top = returns_data.get("top_returns", [])
    inv_summary = report_data.get("inventory_summary", {})
    inv_total = inv_summary.get("total_available", 0)
    inv_sku_cnt = inv_summary.get("sku_count", 0)
    inv_low_cnt = inv_summary.get("low_stock_count", 0)
    inv_oos_cnt = inv_summary.get("oos_count", 0)
    inv_in_transit = inv_summary.get("in_transit", 0)
    if ret_qty <= 0 and ret_rate <= 0 and inv_total <= 0:
        return ""

    ret_clr = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"
    inv_rows = ""
    for label, val, val_clr in [
        ("在售 SKU 数", inv_sku_cnt, "#111827"),
        ("可用库存总量", f"{inv_total:,}", "#111827"),
        ("在途库存", f"{inv_in_transit:,}", "#111827"),
        ("低库存告急", inv_low_cnt, "#D97706"),
        ("缺货", inv_oos_cnt, "#DC2626"),
    ]:
        inv_rows += f"""<tr>
              <td style="padding: 6px 12px; font-size: 12px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
              <td width="35%" style="padding: 6px 12px; font-size: 13px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
            </tr>"""

    ret_reason_rows = ""
    if ret_top:
        for r in ret_top[:5]:
            ret_reason_rows += f"""<tr>
              <td style="padding: 6px 12px; font-size: 12px; color: #374151; border-bottom: 1px solid #F3F4F6;">{_safe_html(r.get("reason", "—"))}</td>
              <td width="30%" style="padding: 6px 12px; font-size: 13px; font-weight: 700; text-align: right; color: #DC2626;">{r.get("qty", 0)}</td>
            </tr>"""
    ret_reason_table = (
        f"""
            <tr>
              <td colspan="2" style="padding: 10px 12px 4px; font-size: 12px; font-weight: 600; color: #6B7280; border-bottom: 1px solid #E5E7EB;">↩️ 退货原因 TOP</td>
            </tr>
            {ret_reason_rows}"""
    ) if ret_top else ""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <tr>
              <td width="50%" style="padding: 16px 10px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
                <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">退货数量</div>
                <div style="font-size: 36px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_qty}</div>
              </td>
              <td width="50%" style="padding: 16px 10px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
                <div style="font-size: 12px; color: #6B7280; margin-bottom: 6px;">退货率</div>
                <div style="font-size: 36px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_rate:.1f}%</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding: 10px 12px 4px; font-size: 12px; font-weight: 600; color: #6B7280; border-bottom: 1px solid #E5E7EB;">📦 库存状态</td>
            </tr>
            {inv_rows}
            {ret_reason_table}
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


def _section_month_alerts(report_data: dict[str, Any], country: str) -> str:
    """⚠️ 告警区块。无数据返回空串。"""
    alerts = report_data.get("alerts", [])
    return _render_alert_section(alerts)


def _section_month_action_items(report_data: dict[str, Any], country: str) -> str:
    """✅ 行动建议。无数据返回空串。"""
    action_items = report_data.get("action_items", [])
    return _render_action_items_section(action_items)


# ── Sections list (for multi-country section-first layout) ───────────────────


_MONTHLY_SECTIONS = [
    {"emoji": "📌", "title": "月度运营概况", "color": "#2563EB", "fn": _section_month_kpi},
    {"emoji": "📋", "title": "销售 SKU 明细", "color": "#6B7280", "fn": _section_month_sku_detail},
    {"emoji": "📈", "title": "月内周趋势", "color": "#6366F1", "fn": _section_month_trend},
    {"emoji": "📈", "title": "月对比分析", "color": "#2563EB", "fn": _section_month_comparison},
    {"emoji": "🏆", "title": "热销 SKU 表现", "color": "#059669", "fn": _section_month_top_skus},
    {"emoji": "💰", "title": "广告效果对比", "color": "#16A34A", "fn": _section_month_ads},
    {"emoji": "↩️", "title": "退货及库存概况", "color": "#F59E0B", "fn": _section_month_returns},
    {"emoji": "⚠️", "title": "警报", "color": "#DC2626", "fn": _section_month_alerts},
    {"emoji": "✅", "title": "行动建议", "color": "#2563EB", "fn": _section_month_action_items},
]


# ── Combined multi-country section (BLF-813) ─────────────────────────────────

# 板块之间的浅色分隔行（多站点布局共用）
_LIGHT_DIVIDER = """
      <tr>
        <td style="padding: 8px 16px 0;">
          <div style="border-bottom: 1px solid #F3F4F6;"></div>
        </td>
      </tr>"""


def _section_month_combined_trend(
    countries: list[str],
    country_data: dict[str, dict[str, Any]],
) -> str:
    """🌐 整体销售情况（多站点汇总）：把各站点的月内周趋势柱状图合并为一条整体柱状图。

    BLF-813：仅出现在多站点报告的正文开头，先给整体、再进按站点分列的原有板块。
    只汇总销量件数（各站点币种不同，销售额不可跨站点直接相加）。
    所有站点均无周趋势数据时返回空串（该环节自动省略）。
    """
    totals: dict[str, dict[str, Any]] = {}
    for country in countries:
        for w in country_data.get(country, {}).get("weekly_trend", []):
            start = str(w.get("start", "")).strip()
            end = str(w.get("end", "")).strip()
            if not start and not end:
                continue
            try:
                qty = int(w.get("qty", 0) or 0)
            except (TypeError, ValueError):
                qty = 0
            key = f"{start}~{end}"
            slot = totals.setdefault(
                key,
                {"qty": 0, "label": str(w.get("label", "")).strip(), "start": start, "end": end},
            )
            slot["qty"] += qty
    if not totals:
        return ""

    site_labels = " / ".join(_country_label(c) for c in countries)
    max_qty = max(v["qty"] for v in totals.values()) or 1
    cols_count = len(totals)
    col_pct = f"{100 // cols_count}%" if cols_count > 0 else "25%"
    trend_tds = ""
    for key in sorted(totals):
        slot = totals[key]
        q = slot["qty"]
        label = slot["label"]
        date_range = f"{slot['start'][-5:]}~{slot['end'][-5:]}" if slot["start"] or slot["end"] else ""
        bar_h = max(4, int(q / max_qty * 60))
        trend_tds += f"""
        <td width="{col_pct}" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 14px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q:,}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 11px; color: #6B7280; margin-top: 3px; white-space: nowrap;">{label}</div>
          <div style="font-size: 10px; color: #9CA3AF; white-space: nowrap;">{date_range}</div>
        </td>"""

    return f"""
      <!-- Section: 整体销售情况（多站点汇总） -->
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid #0891B2; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827;">🌐 整体销售情况（多站点汇总）</div>
        </td>
      </tr>
      <tr>
        <td style="padding: 0 16px 12px;">
          <div style="font-size: 13px; color: #6B7280; margin-bottom: 8px;">月内各周销量合计 · 已合并 {site_labels} · 单位：件</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds}</tr>
          </table>
        </td>
      </tr>"""


def _render_monthly_content_sections(
    report_data: dict[str, Any],
    country_suffix: str = "",
) -> str:
    """渲染所有月报内容 section（供单国家渲染和多国家布局共用）。"""
    country = report_data.get("country", "US")

    parts: list[str] = []
    for section in _MONTHLY_SECTIONS:
        renderer = section["fn"]
        title = f"{section['emoji']} {section['title']}" if section["emoji"] else section["title"]

        # Section header
        parts.append(f"""
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid {section['color']}; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827;">{title}{country_suffix}</div>
        </td>
      </tr>""")

        # Section content
        content = renderer(report_data, country)
        if content:
            parts.append(content)

        # Divider
        parts.append("""
      <tr>
        <td style="padding: 8px 16px 0;">
          <div style="border-bottom: 1px solid #F3F4F6;"></div>
        </td>
      </tr>""")

    return "\n".join(parts)


# ── HTML shell ───────────────────────────────────────────────────────────────


def _wrap_monthly_html_shell(
    project_name: str,
    country_display: str,
    report_date: str,
    month_label: str,
    date_range: str,
    ai_summary_html: str,
    content_html: str,
    include_summary: bool,
    *,
    for_screenshot: bool = False,
    logo_src: str = "https://dash.believeboy.com/logo-email.png",
) -> str:
    """Wrap monthly content sections with the outer HTML shell.

    Args:
        for_screenshot: True 时使用手机端窄宽度 (420px)，适配手机端截图查看。
        logo_src: 邮件 logo 的 src（截图模式可传入 base64 data URI 避免外网请求）。
    """
    max_width = "420px" if for_screenshot else "850px"
    year = report_date[:4] if report_date else ""

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
<title>每月运营报告 · {project_name}</title>
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
                <img src="{logo_src}" width="52" height="52" alt="BelieveBoy" style="border-radius: 50%; display: block;" onerror="this.style.display='none'">
              </td>
              <td style="vertical-align: middle;">
                <div style="font-size: 22px; font-weight: 700; color: white;">每月运营报告</div>
                <div style="font-size: 14px; color: #9CA3AF; margin-top: 5px;">{project_name} · {country_display} · {month_label}（{date_range}）</div>
              </td>
              <td width="90" align="right" style="vertical-align: middle;">
                <span style="display: inline-block; background: #2563EB; color: white; font-size: 13px; font-weight: 700; padding: 5px 14px; border-radius: 20px; white-space: nowrap;">每月报告</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- 报表总结（截图模式下隐藏） -->
      {'<tr><td style="padding: 20px 16px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;"><div style="border-left: 4px solid #1D4ED8; padding-left: 10px; font-size: 16px; font-weight: 700; color: #111827; margin-bottom: 10px;">🔍 报表总结</div><div style="font-size: 15px; color: #1E3A5F; line-height: 1.7; padding-left: 14px;">' + ai_summary_html + '</div></td></tr>' if include_summary else ''}

      {content_html}

      <!-- Footer -->
      <tr>
        <td style="padding: 24px 20px 20px; text-align: center; background: #F9FAFB; border-top: 1px solid #E5E7EB;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align: middle; padding-bottom: 8px;">
                <img src="{logo_src}" width="28" height="28" alt="BelieveBoy" style="border-radius: 50%; display: inline-block; vertical-align: middle; margin-right: 8px;" onerror="this.style.display='none'">
                <span style="font-size: 15px; font-weight: 700; color: #374151; vertical-align: middle;">BelieveBoy Dashboard</span>
              </td>
            </tr>
            <tr>
              <td style="font-size: 12px; color: #9CA3AF; line-height: 1.8;">
                {project_name} · {year}年{month_label} · {date_range}
              </td>
            </tr>
          </table>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── Public renderers ─────────────────────────────────────────────────────────


def _render_monthly_report_html(report_data: dict[str, Any], include_summary: bool = True, *, for_screenshot: bool = False) -> str:
    """构建每月报告 HTML 邮件（单站点路径）。"""
    project_name = report_data.get("project_name", "项目")
    country = report_data.get("country", "US")
    month_label = report_data.get("month_label", "")
    date_range = report_data.get("date_range", "")
    report_date = report_data.get("report_date", "")

    ai_summary = _markdown_to_email_html(report_data.get("ai_summary", "暂无报表总结"))
    suffix = f" · {_country_label(country)}"
    content = _render_monthly_content_sections(report_data, country_suffix=suffix)
    logo_src = _get_logo_src(for_screenshot)
    html = _wrap_monthly_html_shell(project_name, _country_label(country), report_date, month_label, date_range, ai_summary, content, include_summary, for_screenshot=for_screenshot, logo_src=logo_src)
    return html if for_screenshot else _scale_html_fonts(html, 1.25)


def _render_multi_country_monthly_html(
    countries: list[str],
    country_data: dict[str, dict[str, Any]],
    project_name: str,
    report_date: str,
    month_label: str,
    date_range: str,
    ai_summary: str,
    include_summary: bool = True,
    *,
    for_screenshot: bool = False,
) -> str:
    """Render a merged multi-country monthly report with section-first layout."""
    ai_summary_html = _markdown_to_email_html(ai_summary)
    country_display = " / ".join(_country_label(c) for c in countries)

    content_parts: list[str] = []

    # BLF-813：多站点报告开头先给「整体销售情况」合并柱状图，再进按站点分列的板块
    combined_section = _section_month_combined_trend(countries, country_data)
    if combined_section:
        content_parts.append(combined_section)
        content_parts.append(_LIGHT_DIVIDER)

    for section in _MONTHLY_SECTIONS:
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
        content_parts.append(_LIGHT_DIVIDER)

    combined_content = "\n".join(content_parts)
    logo_src = _get_logo_src(for_screenshot)
    html = _wrap_monthly_html_shell(project_name, country_display, report_date, month_label, date_range, ai_summary_html, combined_content, include_summary, for_screenshot=for_screenshot, logo_src=logo_src)
    return html if for_screenshot else _scale_html_fonts(html, 1.25)


# ── Email sender ─────────────────────────────────────────────────────────────


def send_monthly_report_email(email: str, report_data: dict[str, Any], stage_callback=None, skip_email: bool = False) -> tuple[bool, str | None]:
    """发送月报邮件。

    当 ``email`` 为空或 ``skip_email=True`` 时，仍渲染 HTML、生成截图并上传 R2，
    但跳过实际的 Resend 发送（返回 ("skipped_email")）。
    """
    from app.core.config import get_settings

    settings = get_settings()
    should_send = bool(email) and not skip_email
    if should_send and not settings.resend_api_key:
        return False, "resend_api_key not configured"

    try:
        project_name = report_data.get("project_name", "项目")
        month_label = report_data.get("month_label", "")
        report_date = report_data.get("report_date", "")
        year = report_date[:4] if report_date else ""

        # Detect multi-country vs single-country
        raw_country = report_data.get("country", "US")
        country_list = [c.strip() for c in raw_country.split(",") if c.strip()]
        is_multi = len(country_list) > 1

        # BLF-1014：AI 摘要不再在构建期生成 → 邮件摘要段落会整段消失。
        # 用纯格式化兜底文本填回（零 LLM 调用），保证段落始终渲染。
        report_data["ai_summary"] = fallback_summary_text(report_data, "monthly")
        include_ai_summary = bool(report_data["ai_summary"].strip())

        if is_multi:
            country_data = report_data.get("country_data", {})
            date_range = report_data.get("date_range", "")
            html = _render_multi_country_monthly_html(
                country_list, country_data, project_name, report_date,
                month_label, date_range,
                report_data.get("ai_summary", ""), include_summary=include_ai_summary,
            )
            screenshot_html = _render_multi_country_monthly_html(
                country_list, country_data, project_name, report_date,
                month_label, date_range,
                report_data.get("ai_summary", ""), include_summary=False,
                for_screenshot=True,
            )
            labels = [_country_label(c) for c in country_list]
            subject = f"BelieveBoy | {truncate_project_name_for_subject(project_name)} · {'/'.join(labels)} · {month_label} 月报"
            country_for_file = "+".join(country_list)
        else:
            html = _render_monthly_report_html(report_data, include_summary=include_ai_summary)
            screenshot_html = _render_monthly_report_html(report_data, include_summary=False, for_screenshot=True)
            subject = f"BelieveBoy | {truncate_project_name_for_subject(project_name)} · {_country_label(country_list[0] if country_list else 'US')} · {month_label} 月报"
            country_for_file = country_list[0] if country_list else "US"

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email] if should_send else [],
            "subject": subject,
            "html": html,
        }

        # 生成截图附件
        try:
            from app.services.scheduled_report.screenshot import process_screenshot_and_upload
            if stage_callback:
                from app.models.scheduled_report import DeliveryStage
                stage_callback(DeliveryStage.CAPTURING_SCREENSHOT.value)
            email_attachment_name = f"月报_{sanitize_filename_segment(project_name)}_{country_for_file}_{month_label}.png"
            process_screenshot_and_upload(
                screenshot_html,
                report_data,
                params,
                project_name=project_name,
                email_attachment_name=email_attachment_name,
                frequency="monthly",
                country=country_for_file,
            )
        except Exception as e:
            logger.warning("截图生成跳过: %s", e)

        if not should_send:
            logger.info("跳过 Resend 发送（email=%r skip_email=%s）", email, skip_email)
            return True, "skipped_email"

        if stage_callback:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.SENDING.value)
        import resend
        resend.api_key = settings.resend_api_key
        resp = resend.Emails.send(params)
        rid = resp.get("id", "")
        return True, rid

    except Exception as e:
        logger.error(f"Failed to send monthly report email to {email}: {e}")
        return False, str(e)
