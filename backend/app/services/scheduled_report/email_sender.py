"""Scheduled report email sender using Resend."""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

import resend

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def _fmt_currency(val: float) -> str:
    return f"${val:,.2f}"


def _color_positive(val: float, good_threshold: float = 0) -> str:
    """绿色正数 / 红色负数（相对于阈值）"""
    return "#16A34A" if val >= good_threshold else "#DC2626"


def _color_delta(positive: bool) -> str:
    return "#16A34A" if positive else "#DC2626"


def _arrow_delta(positive: bool) -> str:
    return "↑" if positive else "↓"


def _safe_html(text: str) -> str:
    return (text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;"))


def _render_daily_report_html(report_data: dict[str, Any]) -> str:
    """构建每日报告 HTML 邮件（table-based 响应式，确保 Gmail App 移动端显示正常。"""

    # ── 提取数据 ──────────────────────────────────────
    sales     = report_data.get("sales", {})
    week_sales = report_data.get("week_sales", {})
    trend    = report_data.get("trend_days", [])
    top_skus = report_data.get("top_skus", [])
    inventory = report_data.get("inventory", {})
    ads      = report_data.get("ads", {})
    returns  = report_data.get("returns", {})
    alert_rows = report_data.get("alert_rows", [])

    ai_summary   = _safe_html(report_data.get("ai_summary", "暂无 AI 摘要"))
    project_name = report_data.get("project_name", "项目")
    country     = report_data.get("country", "US")
    report_date = report_data.get("report_date", date.today().isoformat())
    dash_url    = "https://dash.believeboy.com/dashboard"

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
    ad_ords  = ads.get("orders", 0)
    roas_clr = _color_positive(ad_roas, good_threshold=2.0)
    acos_clr = _color_positive(ad_acos, good_threshold=30)  # ACOS 越低越好
    acos_clr = "#16A34A" if ad_acos <= 30 else "#DC2626"

    # 退货
    ret_qty  = returns.get("qty", 0)
    ret_rate = returns.get("rate", 0.0)
    ret_top  = returns.get("top_returns", [])
    ret_clr  = "#DC2626" if ret_rate > 3 else "#F59E0B" if ret_rate > 1 else "#16A34A"

    # ── 7天趋势柱图 ────────────────────────────────
    max_q = max((d.get("qty", 0) for d in trend), default=1)
    trend_tds = ""
    for d in trend:
        q  = d.get("qty", 0)
        bar_h = max(4, int(q / max_q * 60)) if max_q > 0 else 4
        trend_tds += f"""
        <td width="14%" style="text-align: center; padding: 0 2px; vertical-align: bottom;">
          <div style="font-size: 11px; font-weight: 700; color: #1D4ED8; margin-bottom: 3px;">{q}</div>
          <div style="background: #DBEAFE; border-radius: 3px 3px 0 0; height: {bar_h}px; margin: 0 auto; min-height: 4px;"></div>
          <div style="font-size: 10px; color: #9CA3AF; margin-top: 3px; white-space: nowrap;">{d.get("date", "")}</div>
        </td>"""

    # ── 指标卡（每行 2 列）──────────────────────────
    # 行 1: 昨日销量 | 昨日销售额
    # 行 2: 7天累计销量 | 7天累计销售额
    card1 = f"""<td width="50%" style="padding: 14px 8px 10px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 10px; color: #6B7280; margin-bottom: 6px;">昨日销量</div>
      <div style="font-size: 32px; font-weight: 900; color: #111827; line-height: 1;">{y_qty} <span style="font-size: 16px; font-weight: 600;">件</span></div>
      <div style="font-size: 11px; color: {delta_clr}; font-weight: 700; margin-top: 5px;">{delta_icon} {abs(chg_pct):.1f}% vs 前日</div>
    </td>"""

    card2 = f"""<td width="50%" style="padding: 14px 8px 10px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 10px; color: #6B7280; margin-bottom: 6px;">昨日销售额</div>
      <div style="font-size: 32px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(y_amt)}</div>
      <div style="font-size: 11px; color: #6B7280; margin-top: 5px;">USD</div>
    </td>"""

    card3 = f"""<td width="50%" style="padding: 10px 8px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 10px; color: #6B7280; margin-bottom: 6px;">7天累计销量</div>
      <div style="font-size: 32px; font-weight: 900; color: #111827; line-height: 1;">{wk_qty} <span style="font-size: 16px; font-weight: 600;">件</span></div>
      <div style="font-size: 11px; color: #6B7280; margin-top: 5px;">{report_data.get("date_range", "")}</div>
    </td>"""

    card4 = f"""<td width="50%" style="padding: 10px 8px 14px; text-align: center; border: 1px solid #10B981; background: #F0FDF4; vertical-align: top;">
      <div style="font-size: 10px; color: #6B7280; margin-bottom: 6px;">7天累计销售额</div>
      <div style="font-size: 32px; font-weight: 900; color: #059669; line-height: 1;">{_fmt_currency(wk_amt)}</div>
      <div style="font-size: 11px; color: #6B7280; margin-top: 5px;">USD</div>
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
          <td style="padding: 8px 12px; font-size: 12px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="30%" style="padding: 8px 12px; font-size: 12px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    ads_rows_td = ""
    for label, val, val_clr in [
        ("广告花费", _fmt_currency(ad_spend), "#111827"),
        ("ROAS", f"{ad_roas:.2f}", roas_clr),
        ("ACOS", f"{ad_acos:.1f}%", acos_clr),
        ("CTR / 订单", f"{ad_ctr:.1f}% / {ad_ords} 单", "#111827"),
    ]:
        ads_rows_td += f"""<tr>
          <td style="padding: 8px 12px; font-size: 12px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{label}</td>
          <td width="35%" style="padding: 8px 12px; font-size: 12px; font-weight: 700; text-align: right; color: {val_clr};">{val}</td>
        </tr>"""

    ret_rows_td = ""
    if ret_top:
        for r in ret_top[:3]:
            ret_rows_td += f"""<tr>
              <td style="padding: 8px 12px; font-size: 12px; color: #374151; border-bottom: 1px solid #F3F4F6;">{_safe_html(r.get("reason", "—"))}</td>
              <td width="30%" style="padding: 8px 12px; font-size: 12px; font-weight: 700; text-align: right; color: #DC2626;">{r.get("qty", 0)} 件</td>
            </tr>"""
    else:
        ret_rows_td = f"""<tr><td colspan="2" style="padding: 10px 12px; font-size: 11px; color: #9CA3AF; text-align: center;">暂无退货数据</td></tr>"""

    # ── 库存告急（满宽警告条）────────────────
    alert_section = ""
    if alert_rows:
        alert_tds = ""
        for item in alert_rows[:6]:
            alert_tds += f"""<tr>
              <td style="padding: 8px 12px; font-size: 12px; color: #92400E; border-bottom: 1px solid #FDE68A;">
                <span style="background:{item.get("badge_color","#F59E0B")};color:white;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;margin-right:6px;">{item.get("badge","告急")}</span>
                {item.get("sku","")} — 剩余 {item.get("qty","0")} 件
              </td>
            </tr>"""
        alert_section = f"""
        <tr>
          <td style="padding: 0 16px 12px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 8px; overflow: hidden;">
              <tr><td style="padding: 10px 14px 6px; font-size: 12px; font-weight: 700; color: #92400E; border-bottom: 1px solid #FDE68A;">⚠️ 库存告急 / 缺货提醒</td></tr>
              <tr><td style="padding: 0;">
                <table width="100%" cellpadding="0" cellspacing="0" border="0">{alert_tds}</table>
              </td></tr>
            </table>
          </td>
        </tr>"""

    # ── TOP SKU 表格（严格对齐，无 HOT 标签错位）─────
    sku_thead = """<thead>
      <tr style="background: #F9FAFB;">
        <th style="padding: 8px 12px; font-size: 11px; color: #6B7280; text-align: left; font-weight: 600;">SKU</th>
        <th style="padding: 8px 12px; font-size: 11px; color: #6B7280; text-align: center; font-weight: 600; white-space: nowrap;">7天销量</th>
        <th style="padding: 8px 12px; font-size: 11px; color: #6B7280; text-align: right; font-weight: 600;">7天销售额</th>
      </tr>
    </thead>"""

    sku_body = ""
    for idx, sku in enumerate(top_skus[:5]):
        bg      = "#EFF6FF" if idx == 0 else ""
        sku_name = _safe_html(sku.get("sku", "—"))
        qty_s   = sku.get("qty", 0)
        amt_s   = _fmt_currency(sku.get("amount", 0.0))
        # HOT 标在 SKU 名称后方，用同一 <td> 保证对齐
        hot_badge = (' <span style="background:#FEF3C7;color:#D97706;font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:6px;white-space:nowrap;">HOT</span>') if idx == 0 else ""
        # 统一 line-height=1 确保有/无 HOT 标签时行高一致，配合 vertical-align:middle 居中
        sku_body += f"""<tr>
          <td style="padding: 10px 12px; font-size: 13px; line-height: 1; color: #374151; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">
            <strong style="font-size: 13px; font-weight: 700;">{sku_name}</strong>{hot_badge}
          </td>
          <td style="padding: 10px 12px; font-size: 13px; line-height: 1; text-align: center; font-weight: 700; color: #1D4ED8; background: {bg}; border-bottom: 1px solid #F3F4F6; white-space: nowrap; vertical-align: middle;">{qty_s} 件</td>
          <td style="padding: 10px 12px; font-size: 13px; line-height: 1; text-align: right; font-weight: 600; color: #059669; background: {bg}; border-bottom: 1px solid #F3F4F6; vertical-align: middle;">{amt_s}</td>
        </tr>"""

    # ── 完整 HTML ────────────────────────────────────
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>每日运营报告 · {project_name}</title>
</head>
<body style="margin: 0; padding: 0; background: #F3F4F6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
<!-- 外层 table，确保移动端宽度撑满 -->
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F3F4F6; padding: 12px 0;">
  <tr><td>
    <!-- 邮件主体 -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0"
           style="max-width: 680px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">

      <!-- Header -->
      <tr>
        <td style="background: linear-gradient(135deg, #1F2937, #374151); padding: 20px 20px 18px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align: middle;">
                <div style="font-size: 18px; font-weight: 700; color: white;">📊 每日运营报告</div>
                <div style="font-size: 12px; color: #9CA3AF; margin-top: 4px;">{project_name} · {country} · {report_date}</div>
              </td>
              <td width="80" align="right" style="vertical-align: middle;">
                <span style="display: inline-block; background: #2563EB; color: white; font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 20px; white-space: nowrap;">每日报告</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- AI 摘要 -->
      <tr>
        <td style="padding: 14px 16px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;">
          <div style="font-size: 10px; font-weight: 700; color: #1D4ED8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px;">🔍 AI 摘要</div>
          <div style="font-size: 13px; color: #1E3A5F; line-height: 1.7;">{ai_summary}</div>
        </td>
      </tr>

      <!-- 指标卡：2×2 布局（行1） -->
      <tr>
        <td style="padding: 14px 16px 6px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card1}{card2}</tr>
          </table>
        </td>
      </tr>

      <!-- 指标卡：2×2 布局（行2） -->
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
          <div style="font-size: 12px; font-weight: 700; color: #374151; margin-bottom: 8px;">📈 近7天销量趋势</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;">
            <tr>{trend_tds}</tr>
          </table>
        </td>
      </tr>

      <!-- 库存 + 广告（并列一行） -->
      <tr>
        <td style="padding: 12px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0">

            <!-- 行：库存 | 广告 -->
            <tr>

              <!-- 库存（左半） -->
              <td width="50%" valign="top" style="padding-right: 6px;">
                <div style="font-size: 12px; font-weight: 700; color: #374151; margin-bottom: 6px;">📦 库存状态</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{inv_rows_td}</td></tr>
                </table>
              </td>

              <!-- 广告（右半） -->
              <td width="50%" valign="top" style="padding-left: 6px;">
                <div style="font-size: 12px; font-weight: 700; color: #374151; margin-bottom: 6px;">💰 广告数据</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td colspan="2">{ads_rows_td}</td></tr>
                </table>
              </td>

            </tr>

            <!-- 行：退货（全宽） -->
            <tr>
              <td colspan="2" valign="top" style="padding-top: 10px;">
                <div style="font-size: 12px; font-weight: 700; color: #374151; margin-bottom: 6px;">↩️ 退货分析</div>
                <table width="100%" cellpadding="0" cellspacing="0" border="0"
                       style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
                  <tr><td style="padding: 8px 12px; font-size: 12px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">退货量</td>
                      <td width="30%" style="padding: 8px 12px; font-size: 12px; font-weight: 700; text-align: right; color: #111827;">{ret_qty} 件</td></tr>
                  <tr><td style="padding: 8px 12px; font-size: 12px; color: #6B7280; border-bottom: 1px solid #F3F4F6;">退货率</td>
                      <td style="padding: 8px 12px; font-size: 12px; font-weight: 700; text-align: right; color: {ret_clr};">{ret_rate:.1f}%</td></tr>
                  <tr><td colspan="2" style="padding: 0;">
                    <table width="100%" cellpadding="0" cellspacing="0" border="0">{ret_rows_td}</table>
                  </td></tr>
                </table>
              </td>
            </tr>

          </table>
        </td>
      </tr>

      <!-- 库存告急（全宽） -->
      {alert_section}

      <!-- TOP SKU -->
      <tr>
        <td style="padding: 0 16px 12px;">
          <div style="font-size: 12px; font-weight: 700; color: #374151; margin-bottom: 8px;">🏆 近7天热销 SKU TOP 5</div>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
            {sku_thead}
            <tbody>{sku_body or f'<tr><td colspan="3" style="padding: 16px; text-align: center; color: #9CA3AF; font-size: 12px;">暂无销售数据</td></tr>'}</tbody>
          </table>
        </td>
      </tr>

      <!-- 数据说明 -->
      <tr>
        <td style="padding: 0 16px 10px;">
          <div style="padding: 10px 14px; background: #FFFBEB; border-left: 3px solid #F59E0B; border-radius: 6px;">
            <div style="font-size: 11px; color: #92400E; line-height: 1.6;">💡 数据来源于 Amazon Seller Central 自动同步，每日 15:00 准时推送。如有异常请登录仪表板核查。</div>
          </div>
        </td>
      </tr>

      <!-- CTA -->
      <tr>
        <td style="padding: 10px 16px 20px; text-align: center; border-top: 1px solid #F3F4F6;">
          <a href="{dash_url}"
             style="display: inline-block; background: #2563EB; color: white; text-decoration: none; padding: 11px 28px; border-radius: 8px; font-size: 14px; font-weight: 700;">
            查看完整仪表板 →
          </a>
          <div style="margin-top: 10px; font-size: 11px; color: #9CA3AF;">BelieveBoy Dashboard · {report_date}</div>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>"""


# ── Missing functions (required by scheduler.py and scheduled_reports.py) ──


def send_scheduled_report_email(email: str, frequency: str, report_data: dict[str, Any]) -> tuple[bool, str | None]:
    """
    Send scheduled report email via Resend.
    Returns (success, resend_id_or_error_message).
    """
    from app.core.config import get_settings
    import resend

    settings = get_settings()
    if not settings.RESEND_API_KEY:
        return False, "RESEND_API_KEY not configured"

    try:
        resend.api_key = settings.RESEND_API_KEY

        # Build HTML based on frequency
        if frequency == "daily":
            html = _render_daily_report_html(report_data)
        else:
            html = _render_daily_report_html(report_data)  # reuse for now

        project_name = report_data.get("project_name", "项目")
        report_date = report_data.get("report_date", "")

        subject = f"📊 {project_name} · {'每日' if frequency == 'daily' else '每周' if frequency == 'weekly' else '每月'}运营报告 · {report_date}"

        params: dict[str, Any] = {
            "from": settings.RESEND_FROM_EMAIL,
            "to": [email],
            "subject": subject,
            "html": html,
        }
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
    if not settings.RESEND_API_KEY:
        return False, "RESEND_API_KEY not configured"

    try:
        resend.api_key = settings.RESEND_API_KEY

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
            "from": settings.RESEND_FROM_EMAIL,
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
