"""Daily report email sender.

Re-exports shared utilities from email_sender.py.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from app.services.scheduled_report.email_sender import (
    _fmt_currency, _safe_html, _markdown_to_email_html,
    _color_delta, _arrow_delta, _color_positive,
    _basic_markdown_to_html, _inline_markdown, _country_label,
    _currency_code, _render_country_sub_header,
    _scale_html_fonts,
)

logger = logging.getLogger(__name__)


# ── Content sections builder (extracted for multi-country reuse) ──────────────


def _render_daily_content_sections(
    report_data: dict[str, Any],
    country_suffix: str = "",
) -> str:
    """Render all inner content <tr> blocks for one country.

    Args:
        report_data: Single-country report data dict.
        country_suffix: Label appended to section titles, e.g. " · 美国站".
    """
    sales     = report_data.get("sales", {})
    week_sales = report_data.get("week_sales", {})
    trend    = report_data.get("trend_days", [])
    top_skus = report_data.get("top_skus", [])
    inventory = report_data.get("inventory", {})
    ads      = report_data.get("ads", {})
    returns  = report_data.get("returns", {})
    alert_rows = report_data.get("alert_rows", [])
    sku_sales_detail = report_data.get("sku_sales_detail", [])

    country     = report_data.get("country", "US")
    date_range  = report_data.get("date_range", "")

    # 销售
    y_qty   = sales.get("yesterday_qty", 0)
    y_amt   = sales.get("yesterday_amount", 0.0)
    prev_qty = sales.get("prev_qty", 0)
    chg_pct = sales.get("change_pct", 0.0)
    wk_qty  = week_sales.get("week_qty", 0)
    wk_amt  = week_sales.get("week_amount", 0.0)

    is_up      = chg_pct >= 0
    delta_clr  = _color_delta(is_up)
    delta_icon = _arrow_delta(is_up)

    # 库存
    sku_cnt  = inventory.get("sku_count", 0)
    oos      = inventory.get("oos_skus", [])
    low_skus = inventory.get("low_stock_skus", [])
    avail    = inventory.get("total_available", 0)

    # 广告
    ad_spend = ads.get("spend", 0.0)
    ad_sales = ads.get("sales", 0.0)
    ad_roas  = ads.get("roas", 0.0)
    ad_acos  = ads.get("acos", 0.0)
    ad_ctr   = ads.get("ctr", 0.0)
    roas_clr = _color_positive(ad_roas, good_threshold=2.0)
    acos_clr = "#16A34A" if ad_acos <= 30 else "#DC2626"

    # 退货
    ret_qty  = returns.get("qty", 0)
    ret_rate = returns.get("rate", 0.0)
    ret_top  = returns.get("top_returns", [])
    ret_clr  = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"

    # ── 退货统计卡片 ──────────────────────────────
    ret_card1 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天退货总量</div>
      <div style="font-size: 42px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
    </td>"""

    ret_card2 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">退货率</div>
      <div style="font-size: 42px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_rate:.1f}<span style="font-size: 22px; font-weight: 600;">%</span></div>
    </td>"""

    # ── 7天趋势柱图 ────────────────────────────────
    max_q = max((d.get("qty", 0) for d in trend), default=1)
    trend_tds = ""
    for d in trend:
        q  = d.get("qty", 0)
        bar_h = max(4, int(q / max_q * 60)) if max_q > 0 else 4
        trend_tds += f"""
        <td width="14%" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 14px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 12px; color: #9CA3AF; margin-top: 3px; white-space: nowrap;">{d.get("date", "")}</div>
        </td>"""

    # ── 指标卡（每行 2 列）──────────────────────────
    card1 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">昨日销量</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827; line-height: 1;">{y_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
      <div style="font-size: 14px; color: {delta_clr}; font-weight: 700; margin-top: 6px;">{delta_icon} {abs(chg_pct):.1f}% vs 前日</div>
    </td>"""

    card2 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">昨日销售额</div>
      <div style="font-size: 42px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(y_amt, country)}</div>
      <div style="font-size: 14px; color: #6B7280; margin-top: 6px;">{_currency_code(country)}</div>
    </td>"""

    card3 = f"""<td width="50%" style="padding: 14px 10px 18px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天累计销量</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827; line-height: 1;">{wk_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
      <div style="font-size: 13px; color: #6B7280; margin-top: 6px;">{date_range}</div>
    </td>"""

    card4 = f"""<td width="50%" style="padding: 14px 10px 18px; text-align: center; border: 1px solid #10B981; background: #F0FDF4; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天累计销售额</div>
      <div style="font-size: 42px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(wk_amt, country)}</div>
      <div style="font-size: 13px; color: #6B7280; margin-top: 6px;">{_currency_code(country)}</div>
    </td>"""

    # ── 库存 + 广告（并列一行）────────────────────
    inv_rows_td = ""
    for label, val, val_clr in [
        ("SKU 总数", sku_cnt, "#111827"),
        ("可用总量", f"{avail:,}", "#111827"),
        ("缺货", len(oos), "#DC2626"),
        ("告急 ≤10件", len(low_skus), "#D97706"),
    ]:
        inv_rows_td += f"""<tr>
          <td style="padding: 10px 12px; font-size: 15px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="30%" style="padding: 10px 12px; font-size: 15px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    ads_rows_td = ""
    for label, val, val_clr in [
        ("广告花费", _fmt_currency(ad_spend, country), "#111827"),
        ("ROAS", f"{ad_roas:.2f}", roas_clr),
        ("ACOS", f"{ad_acos:.1f}%", acos_clr),
        ("CTR", f"{ad_ctr:.1f}%", "#111827"),
    ]:
        ads_rows_td += f"""<tr>
          <td style="padding: 10px 12px; font-size: 15px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="35%" style="padding: 10px 12px; font-size: 15px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    ret_rows_td = ""
    if ret_top:
        for r in ret_top[:3]:
            ret_rows_td += f"""<tr>
              <td style="padding: 10px 12px; font-size: 14px; color: #374151; border-bottom: 1px solid #F3F4F6;">{_safe_html(r.get("reason", "—"))}</td>
              <td width="30%" style="padding: 10px 12px; font-size: 14px; font-weight: 700; text-align: right; color: #DC2626;">{r.get("qty", 0)} 件</td>
            </tr>"""
    else:
        ret_rows_td = f"""<tr><td colspan="2" style="padding: 12px; font-size: 13px; color: #9CA3AF; text-align: center;">暂无退货数据</td></tr>"""

    # ── 库存告急（满宽警告条）────────────────
    alert_section = ""
    if alert_rows:
        alert_tds = ""
        for item in alert_rows[:6]:
            alert_tds += f"""<tr>
              <td style="padding: 10px 14px; font-size: 14px; color: #92400E; border-bottom: 1px solid #FDE68A;">
                <span style="background:{item.get("badge_color","#F59E0B")};color:white;font-size:12px;font-weight:700;padding:2px 8px;border-radius:3px;margin-right:6px;">{item.get("badge","告急")}</span>
                {item.get("sku","")} — 剩余 {item.get("qty","0")} 件
              </td>
            </tr>"""
        alert_section = f"""
        <tr>
          <td style="padding: 0 16px 12px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; overflow: hidden;">
              <tr><td style="padding: 12px 14px 8px; font-size: 14px; font-weight: 700; color: #92400E; border-bottom: 1px solid #FDE68A;">⚠️ 库存告急 / 缺货提醒</td></tr>
              <tr><td style="padding: 0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">{alert_tds}</table>
              </td></tr>
            </table>
          </td>
        </tr>"""

    # ── TOP SKU 表格（严格对齐，无 HOT 标签错位）─────
    sku_thead = """<thead>
      <tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 50%;">SKU</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: center; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">7天销量</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">7天销售额</th>
      </tr>
    </thead>"""

    sku_body = ""
    for idx, sku in enumerate(top_skus[:5]):
        bg      = "#EFF6FF" if idx == 0 else "#FFFFFF"
        sku_name = _safe_html(sku.get("sku", "—"))
        qty_s   = sku.get("qty", 0)
        amt_s   = _fmt_currency(sku.get("amount", 0.0), country)
        sku_badge = (' <span style="background:#FEF3C7;color:#D97706;font-size:12px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;">HOT</span>') if idx == 0 else ""
        sku_body += f"""<tr>
          <td width="50%" style="width: 50%; padding: 12px; font-size: 15px; color: #374151; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">
            <span style="font-weight: 700; line-height: 1;">{sku_name}</span>{sku_badge}
          </td>
          <td width="25%" style="width: 25%; padding: 12px; font-size: 15px; text-align: center; font-weight: 700; color: #1D4ED8; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap; vertical-align: middle;">{qty_s} 件</td>
          <td width="25%" style="width: 25%; padding: 12px; font-size: 15px; text-align: right; font-weight: 600; color: #059669; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">{amt_s}</td>
        </tr>"""

    # ── 销售 SKU 明细表格 ─────────────────────────────
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
      <!-- 昨日销售 SKU 明细 -->
      <tr>
        <td style="padding: 6px 16px 12px;">
          <div style="font-size: 14px; font-weight: 600; color: #6B7280; margin-bottom: 6px;">📋 昨日销售 SKU 明细{country_suffix}</div>
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

    # ── Assemble all content sections ──────────────────
    return f"""
      <!-- Section: 今日运营概况 -->
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid #2563EB; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827;">📌 今日运营概况{country_suffix}</div>
        </td>
      </tr>

      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card1}{card2}</tr>
          </table>
        </td>
      </tr>

      {sku_detail_section}

      <!-- Section: 近7天概况 -->
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid #6366F1; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827;">📈 近7天概况{country_suffix} <span style="font-size: 14px; font-weight: 400; color: #6B7280;">({date_range})</span></div>
        </td>
      </tr>

      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <tr>{card3}{card4}</tr>
          </table>
        </td>
      </tr>

      <!-- 7天趋势 -->
      <tr>
        <td style="padding: 0 16px 4px;">
          <div style="font-size: 14px; font-weight: 600; color: #6B7280; margin-bottom: 8px;">销量趋势{country_suffix}</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds}</tr>
          </table>
        </td>
      </tr>

      <!-- 库存 + 广告（并列一行） -->
      <tr>
        <td style="padding: 12px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" valign="top" style="padding-right: 6px;">
                <div style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 6px;">📦 库存状态{country_suffix}</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" height="180"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{inv_rows_td}</td></tr>
                </table>
              </td>
              <td width="50%" valign="top" style="padding-left: 6px;">
                <div style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 6px;">💰 广告数据{country_suffix}</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" height="180"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{ads_rows_td}</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Section: 7天退货分析 -->
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid #F59E0B; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827;">↩️ 7天退货分析{country_suffix}</div>
        </td>
      </tr>

      <!-- 退货统计卡片 -->
      <tr>
        <td style="padding: 6px 16px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{ret_card1}{ret_card2}</tr>
          </table>
        </td>
      </tr>

      <!-- TOP 退货原因 -->
      <tr>
        <td style="padding: 6px 16px 12px;">
          <div style="font-size: 14px; font-weight: 600; color: #6B7280; margin-bottom: 6px;">TOP 退货原因{country_suffix}</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #F9FAFB;">
                <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">退货原因</th>
                <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 30%;">数量</th>
              </tr>
            </thead>
            <tbody>{ret_rows_td}</tbody>
          </table>
        </td>
      </tr>

      <!-- 库存告急（全宽） -->
      {alert_section}

      <!-- Section: 近7天热销 SKU TOP 5 -->
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid #059669; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827;">🏆 近7天热销 SKU TOP 5{country_suffix}</div>
        </td>
      </tr>

      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse; table-layout: fixed;">
            {sku_thead}
            <tbody>{sku_body or '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无销售数据</td></tr>'}</tbody>
          </table>
        </td>
      </tr>"""



# ── Section-first renderers (for multi-country section-first layout) ──────────


def _section_kpi_cards(report_data: dict[str, Any], country: str) -> str:
    """📌 今日运营概况：昨日销量/销售额两张指标卡。"""
    sales = report_data.get("sales", {})
    y_qty = sales.get("yesterday_qty", 0)
    y_amt = sales.get("yesterday_amount", 0.0)
    chg_pct = sales.get("change_pct", 0.0)

    is_up = chg_pct >= 0
    delta_clr = _color_delta(is_up)
    delta_icon = _arrow_delta(is_up)

    card1 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">昨日销量</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827; line-height: 1;">{y_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
      <div style="font-size: 14px; color: {delta_clr}; font-weight: 700; margin-top: 6px;">{delta_icon} {abs(chg_pct):.1f}% vs 前日</div>
    </td>"""

    card2 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">昨日销售额</div>
      <div style="font-size: 42px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(y_amt, country)}</div>
      <div style="font-size: 14px; color: #6B7280; margin-top: 6px;">{_currency_code(country)}</div>
    </td>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card1}{card2}</tr>
          </table>
        </td>
      </tr>"""


def _section_sku_detail(report_data: dict[str, Any], country: str) -> str:
    """📋 昨日销售 SKU 明细。无数据返回空串。"""
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


def _section_7day_overview(report_data: dict[str, Any], country: str) -> str:
    """📈 近7天概况 + 趋势柱图。"""
    week_sales = report_data.get("week_sales", {})
    trend = report_data.get("trend_days", [])
    date_range = report_data.get("date_range", "")

    wk_qty = week_sales.get("week_qty", 0)
    wk_amt = week_sales.get("week_amount", 0.0)

    card3 = f"""<td width="50%" style="padding: 14px 10px 18px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天累计销量</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827; line-height: 1;">{wk_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
      <div style="font-size: 13px; color: #6B7280; margin-top: 6px;">{date_range}</div>
    </td>"""

    card4 = f"""<td width="50%" style="padding: 14px 10px 18px; text-align: center; border: 1px solid #10B981; background: #F0FDF4; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天累计销售额</div>
      <div style="font-size: 42px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(wk_amt, country)}</div>
      <div style="font-size: 13px; color: #6B7280; margin-top: 6px;">{_currency_code(country)}</div>
    </td>"""

    # 趋势柱图
    max_q = max((d.get("qty", 0) for d in trend), default=1)
    trend_tds = ""
    for d in trend:
        q = d.get("qty", 0)
        bar_h = max(4, int(q / max_q * 60)) if max_q > 0 else 4
        trend_tds += f"""
        <td width="14%" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 14px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 12px; color: #9CA3AF; margin-top: 3px; white-space: nowrap;">{d.get("date", "")}</div>
        </td>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <tr>{card3}{card4}</tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 0 16px 4px;">
          <div style="font-size: 14px; font-weight: 600; color: #6B7280; margin-bottom: 8px;">销量趋势（{date_range}）</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds}</tr>
          </table>
        </td>
      </tr>"""


def _section_inventory_ads(report_data: dict[str, Any], country: str) -> str:
    """📦 库存状态 + 💰 广告数据（并列一行）。"""
    inventory = report_data.get("inventory", {})
    ads = report_data.get("ads", {})

    sku_cnt = inventory.get("sku_count", 0)
    oos = inventory.get("oos_skus", [])
    low_skus = inventory.get("low_stock_skus", [])
    avail = inventory.get("total_available", 0)

    ad_spend = ads.get("spend", 0.0)
    ad_roas = ads.get("roas", 0.0)
    ad_acos = ads.get("acos", 0.0)
    ad_ctr = ads.get("ctr", 0.0)
    roas_clr = _color_positive(ad_roas, good_threshold=2.0)
    acos_clr = "#16A34A" if ad_acos <= 30 else "#DC2626"

    inv_rows_td = ""
    for label, val, val_clr in [
        ("SKU 总数", sku_cnt, "#111827"),
        ("可用总量", f"{avail:,}", "#111827"),
        ("缺货", len(oos), "#DC2626"),
        ("告急 ≤10件", len(low_skus), "#D97706"),
    ]:
        inv_rows_td += f"""<tr>
          <td style="padding: 10px 12px; font-size: 15px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="30%" style="padding: 10px 12px; font-size: 15px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    ads_rows_td = ""
    for label, val, val_clr in [
        ("广告花费", _fmt_currency(ad_spend, country), "#111827"),
        ("ROAS", f"{ad_roas:.2f}", roas_clr),
        ("ACOS", f"{ad_acos:.1f}%", acos_clr),
        ("CTR", f"{ad_ctr:.1f}%", "#111827"),
    ]:
        ads_rows_td += f"""<tr>
          <td style="padding: 10px 12px; font-size: 15px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="35%" style="padding: 10px 12px; font-size: 15px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 12px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="50%" valign="top" style="padding-right: 6px;">
                <div style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 6px;">📦 库存状态</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" height="180"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{inv_rows_td}</td></tr>
                </table>
              </td>
              <td width="50%" valign="top" style="padding-left: 6px;">
                <div style="font-size: 14px; font-weight: 700; color: #374151; margin-bottom: 6px;">💰 广告数据</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" height="180"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{ads_rows_td}</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>"""


def _section_returns(report_data: dict[str, Any], country: str) -> str:
    """↩️ 7天退货分析：统计卡片 + TOP 退货原因。"""
    returns = report_data.get("returns", {})
    ret_qty = returns.get("qty", 0)
    ret_rate = returns.get("rate", 0.0)
    ret_top = returns.get("top_returns", [])
    ret_clr = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"

    ret_card1 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">7天退货总量</div>
      <div style="font-size: 42px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_qty} <span style="font-size: 22px; font-weight: 600;">件</span></div>
    </td>"""

    ret_card2 = f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">退货率</div>
      <div style="font-size: 42px; font-weight: 900; color: {ret_clr}; line-height: 1;">{ret_rate:.1f}<span style="font-size: 22px; font-weight: 600;">%</span></div>
    </td>"""

    ret_rows_td = ""
    if ret_top:
        for r in ret_top[:3]:
            ret_rows_td += f"""<tr>
              <td style="padding: 10px 12px; font-size: 14px; color: #374151; border-bottom: 1px solid #F3F4F6;">{_safe_html(r.get("reason", "—"))}</td>
              <td width="30%" style="padding: 10px 12px; font-size: 14px; font-weight: 700; text-align: right; color: #DC2626;">{r.get("qty", 0)} 件</td>
            </tr>"""
    else:
        ret_rows_td = '<tr><td colspan="2" style="padding: 12px; font-size: 13px; color: #9CA3AF; text-align: center;">暂无退货数据</td></tr>'

    return f"""
      <tr>
        <td style="padding: 6px 16px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{ret_card1}{ret_card2}</tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 6px 16px 12px;">
          <div style="font-size: 14px; font-weight: 600; color: #6B7280; margin-bottom: 6px;">TOP 退货原因</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            <thead>
              <tr style="background: #F9FAFB;">
                <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">退货原因</th>
                <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 30%;">数量</th>
              </tr>
            </thead>
            <tbody>{ret_rows_td}</tbody>
          </table>
        </td>
      </tr>"""


def _section_stock_alerts(report_data: dict[str, Any], country: str) -> str:
    """⚠️ 库存告急全宽警告条。无数据返回空串。"""
    alert_rows = report_data.get("alert_rows", [])
    if not alert_rows:
        return ""

    alert_tds = ""
    for item in alert_rows[:6]:
        alert_tds += f"""<tr>
          <td style="padding: 10px 14px; font-size: 14px; color: #92400E; border-bottom: 1px solid #FDE68A;">
            <span style="background:{item.get("badge_color","#F59E0B")};color:white;font-size:12px;font-weight:700;padding:2px 8px;border-radius:3px;margin-right:6px;">{item.get("badge","告急")}</span>
            {item.get("sku","")} — 剩余 {item.get("qty","0")} 件
          </td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 0 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; overflow: hidden;">
            <tr><td style="padding: 12px 14px 8px; font-size: 14px; font-weight: 700; color: #92400E; border-bottom: 1px solid #FDE68A;">⚠️ 库存告急 / 缺货提醒</td></tr>
            <tr><td style="padding: 0;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">{alert_tds}</table>
            </td></tr>
          </table>
        </td>
      </tr>"""


def _section_top5_skus(report_data: dict[str, Any], country: str) -> str:
    """🏆 近7天热销 SKU TOP 5。"""
    top_skus = report_data.get("top_skus", [])

    sku_thead = """<thead>
      <tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 50%;">SKU</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: center; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">7天销量</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB; width: 25%;">7天销售额</th>
      </tr>
    </thead>"""

    sku_body = ""
    for idx, sku in enumerate(top_skus[:5]):
        bg = "#EFF6FF" if idx == 0 else "#FFFFFF"
        sku_name = _safe_html(sku.get("sku", "—"))
        qty_s = sku.get("qty", 0)
        amt_s = _fmt_currency(sku.get("amount", 0.0), country)
        sku_badge = (' <span style="background:#FEF3C7;color:#D97706;font-size:12px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;">HOT</span>') if idx == 0 else ""
        sku_body += f"""<tr>
          <td width="50%" style="width: 50%; padding: 12px; font-size: 15px; color: #374151; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">
            <span style="font-weight: 700; line-height: 1;">{sku_name}</span>{sku_badge}
          </td>
          <td width="25%" style="width: 25%; padding: 12px; font-size: 15px; text-align: center; font-weight: 700; color: #1D4ED8; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap; vertical-align: middle;">{qty_s} 件</td>
          <td width="25%" style="width: 25%; padding: 12px; font-size: 15px; text-align: right; font-weight: 600; color: #059669; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">{amt_s}</td>
        </tr>"""

    return f"""
      <tr>
        <td style="padding: 6px 16px 12px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width: 100%; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden; border-collapse: collapse; table-layout: fixed;">
            {sku_thead}
            <tbody>{sku_body or '<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 14px;">暂无销售数据</td></tr>'}</tbody>
          </table>
        </td>
      </tr>"""


_DAILY_SECTIONS = [
    {"emoji": "📌", "title": "今日运营概况",       "color": "#2563EB", "fn": _section_kpi_cards},
    {"emoji": "📋", "title": "昨日销售 SKU 明细",  "color": "#6B7280", "fn": _section_sku_detail},
    {"emoji": "📈", "title": "近7天概况",           "color": "#6366F1", "fn": _section_7day_overview},
    {"emoji": "",   "title": "库存状态 + 广告数据",  "color": "#6B7280", "fn": _section_inventory_ads},
    {"emoji": "↩️", "title": "7天退货分析",         "color": "#F59E0B", "fn": _section_returns},
    {"emoji": "",   "title": "库存告急 / 缺货提醒",  "color": "#92400E", "fn": _section_stock_alerts},
    {"emoji": "🏆", "title": "近7天热销 SKU TOP 5", "color": "#059669", "fn": _section_top5_skus},
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


def _wrap_html_shell(
    project_name: str,
    country_display: str,
    report_date: str,
    ai_summary_html: str,
    content_html: str,
    include_summary: bool,
) -> str:
    """Wrap content sections with the outer HTML shell (header, summary, CTA)."""
    dash_url = "https://dash.believeboy.com/dashboard"

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>每日运营报告 · {project_name}</title>
</head>
<body style="margin: 0; padding: 0; background: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F3F4F6; padding: 12px 0;">
  <tr><td>
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width: 850px; margin: 0 auto; background: white; border-radius: 50px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background: linear-gradient(135deg, #1F2937, #374151); padding: 24px 20px 22px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="52" style="vertical-align: middle; padding-right: 14px;">
                <img src="https://dash.believeboy.com/logo-email.png" width="52" height="52" alt="BelieveBoy" style="border-radius: 50%; display: block;" onerror="this.style.display='none'">
              </td>
              <td style="vertical-align: middle;">
                <div style="font-size: 22px; font-weight: 700; color: white;">每日运营报告</div>
                <div style="font-size: 14px; color: #9CA3AF; margin-top: 5px;">{project_name} · {country_display} · {report_date}</div>
              </td>
              <td width="90" align="right" style="vertical-align: middle;">
                <span style="display: inline-block; background: #2563EB; color: white; font-size: 13px; font-weight: 700; padding: 5px 14px; border-radius: 20px; white-space: nowrap;">每日报告</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- 运营摘要（截图模式下隐藏） -->
      {f'''<tr>
        <td style="padding: 20px 16px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;">
          <div style="border-left: 4px solid #1D4ED8; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827; margin-bottom: 12px;">📋 运营摘要</div>
          <div style="font-size: 15px; color: #1E3A5F; line-height: 1.7; padding-left: 14px;">{ai_summary_html}</div>
        </td>
      </tr>''' if include_summary else ''}

      {content_html}

      <!-- 数据说明 -->
      <tr>
        <td style="padding: 0 16px 10px;">
          <div style="padding: 12px 14px; background: #FFFBEB; border-left: 3px solid #F59E0B; border-radius: 6px;">
            <div style="font-size: 13px; color: #92400E; line-height: 1.6;">💡 数据来源于 Amazon Seller Central 自动同步，每日 15:00 准时推送。如有异常请登录仪表板核查。</div>
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
          <div style="margin-top: 12px; font-size: 13px; color: #9CA3AF;">BelieveBoy Dashboard · {report_date}</div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── Public renderers ─────────────────────────────────────────────────────────


def _render_daily_report_html(report_data: dict[str, Any], include_summary: bool = True) -> str:
    """构建每日报告 HTML 邮件（单站点路径，完全向后兼容）。"""
    country = report_data.get("country", "US")
    suffix = f" · {_country_label(country)}"

    ai_summary = _markdown_to_email_html(report_data.get("ai_summary", "暂无运营摘要"))
    project_name = report_data.get("project_name", "项目")
    report_date = report_data.get("report_date", date.today().isoformat())

    content = _render_daily_content_sections(report_data, country_suffix=suffix)
    return _scale_html_fonts(_wrap_html_shell(project_name, _country_label(country), report_date, ai_summary, content, include_summary), 1.25)


def _render_multi_country_html(
    countries: list[str],
    country_data: dict[str, dict[str, Any]],
    project_name: str,
    report_date: str,
    ai_summary: str,
    include_summary: bool = True,
) -> str:
    """Render a merged multi-country report with section-first layout.

    Each section header appears once, then all countries' data is shown
    underneath with country sub-header badges.
    """
    ai_summary_html = _markdown_to_email_html(ai_summary)
    country_display = " / ".join(_country_label(c) for c in countries)

    content_parts: list[str] = []
    for section in _DAILY_SECTIONS:
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

        # Section header (no country suffix)
        title = f"{section['emoji']} {section['title']}" if section["emoji"] else section["title"]
        content_parts.append(f"""
      <tr>
        <td style="padding: 20px 16px 10px;">
          <div style="border-left: 4px solid {section['color']}; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827;">{title}</div>
        </td>
      </tr>""")

        # Per-country content with sub-header badge
        for country in countries:
            data = country_data.get(country, {})
            section_html = renderer(data, country)
            if section_html.strip():
                content_parts.append(_render_country_sub_header(country))
                content_parts.append(section_html)

        # Light divider between major sections
        content_parts.append("""
      <tr>
        <td style="padding: 8px 16px 0;">
          <div style="border-bottom: 1px solid #F3F4F6;"></div>
        </td>
      </tr>""")

    combined_content = "\n".join(content_parts)
    return _wrap_html_shell(project_name, country_display, report_date, ai_summary_html, combined_content, include_summary)


# ── Email sender ─────────────────────────────────────────────────────────────


def send_scheduled_report_email(email: str, frequency: str, report_data: dict[str, Any], stage_callback=None) -> tuple[bool, str | None]:
    """
    Send scheduled report email via Resend.
    Returns (success, resend_id_or_error_message).
    """
    from app.core.config import get_settings
    import resend

    settings = get_settings()
    if not settings.resend_api_key:
        return False, "resend_api_key not configured"

    try:
        resend.api_key = settings.resend_api_key

        project_name = report_data.get("project_name", "项目")
        report_date = report_data.get("report_date", "")
        freq_label = {"daily": "每日", "weekly": "每周", "monthly": "每月"}.get(frequency, frequency)

        # Detect multi-country vs single-country
        raw_country = report_data.get("country", "US")
        country_list = [c.strip() for c in raw_country.split(",") if c.strip()]
        is_multi = len(country_list) > 1

        if is_multi:
            # Multi-country path
            country_data = report_data.get("country_data", {})
            email_html = _render_multi_country_html(
                country_list, country_data, project_name, report_date,
                report_data.get("ai_summary", ""), include_summary=True,
            )
            screenshot_html = _render_multi_country_html(
                country_list, country_data, project_name, report_date,
                report_data.get("ai_summary", ""), include_summary=False,
            )
            labels = [_country_label(c) for c in country_list]
            subject = f"BelieveBoy | {project_name} · {'/'.join(labels)} · {freq_label}运营报告 · {report_date}"
            country_for_file = "+".join(country_list)
        else:
            # Single-country path (existing behavior)
            email_html = _render_daily_report_html(report_data, include_summary=True)
            screenshot_html = _render_daily_report_html(report_data, include_summary=False)
            subject = f"BelieveBoy | {project_name} · {freq_label}运营报告 · {report_date}"
            country_for_file = country_list[0] if country_list else "US"

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email],
            "subject": subject,
            "html": email_html,
        }

        # 生成截图附件并上传到 R2
        try:
            from app.services.scheduled_report.screenshot import process_screenshot_and_upload
            if stage_callback:
                from app.models.scheduled_report import DeliveryStage
                stage_callback(DeliveryStage.CAPTURING_SCREENSHOT.value)
            email_attachment_name = f"{freq_label}报告_{project_name}_{country_for_file}_{report_date}.png"
            process_screenshot_and_upload(
                screenshot_html,
                report_data,
                params,
                project_name=project_name,
                email_attachment_name=email_attachment_name,
                frequency=frequency,
                country=country_for_file,
            )
        except Exception as e:
            logger.warning("截图生成跳过: %s", e)

        if stage_callback:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.SENDING.value)
        resp = resend.Emails.send(params)  # type: ignore[assignment]
        rid = resp.get("id", "")
        return True, rid

    except Exception as e:
        logger.error(f"Failed to send report email to {email}: {e}")
        return False, str(e)


def send_test_report_email(email: str, frequency: str) -> tuple[bool, str | None]:
    """Send a test report email to verify email configuration."""
    from app.core.config import get_settings
    import resend

    settings = get_settings()
    if not settings.resend_api_key:
        return False, "resend_api_key not configured"

    try:
        resend.api_key = settings.resend_api_key

        freq_label = {"daily": "每日", "weekly": "每周", "monthly": "每月"}.get(frequency, frequency)
        test_html = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, sans-serif; padding: 40px; text-align: center; background: #F3F4F6;">
  <div style="max-width: 500px; margin: 0 auto; background: white; border-radius: 12px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <div style="font-size: 48px; margin-bottom: 16px;">📧</div>
    <h2 style="color: #111827; margin: 0 0 8px;">测试邮件</h2>
    <p style="color: #6B7280; font-size: 14px;">这是一封来自 <strong>BelieveBoy Dashboard</strong> 的测试邮件。</p>
    <p style="color: #374151; font-size: 14px;">报告频率：{freq_label}</p>
    <div style="margin-top: 32px; padding: 16px; background: #F0FDF4; border-radius: 8px; border: 1px solid #BBF7D0;">
      <span style="color: #16A34A; font-size: 12px; font-weight: 600;">✅ 邮件发送功能正常</span>
    </div>
  </div>
</body>
</html>"""

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email],
            "subject": f"BelieveBoy Dashboard · {freq_label}运营报告配置测试",
            "html": test_html,
        }
        resp = resend.Emails.send(params)  # type: ignore[assignment]
        rid = resp.get("id", "")
        return True, rid

    except Exception as e:
        logger.error(f"Failed to send test email to {email}: {e}")
        return False, str(e)
