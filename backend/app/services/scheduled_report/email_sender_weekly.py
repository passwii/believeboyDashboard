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


def _render_week_kpi_card(label: str, current: str, prev: str, change: float, unit: str = "") -> str:
    """渲染周报 KPI 卡片"""
    color, change_str, _ = _fmt_week_change(change)
    return f"""<td width="50%" style="padding: 18px 10px 14px; text-align: center; border: 1px solid #E5E7EB; background: white; vertical-align: top;">
      <div style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">{label}</div>
      <div style="font-size: 42px; font-weight: 900; color: #111827;">{current}{unit}</div>
      <div style="font-size: 14px; color: {color}; margin-top: 6px;">{change_str} vs 上周</div>
    </td>"""


def _render_week_comparison_table(rows: list[dict]) -> str:
    """渲染周报对比表格"""
    html = """<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
      <thead><tr style="background: #F9FAFB;">
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: left; font-weight: 600; border-bottom: 1px solid #E5E7EB;">项目</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">本周</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">上周</th>
        <th style="padding: 10px 12px; font-size: 13px; color: #6B7280; text-align: right; font-weight: 600; border-bottom: 1px solid #E5E7EB;">变化</th>
      </tr></thead><tbody>"""

    for row in rows:
        color, change_str, _ = _fmt_week_change(row.get("change", 0))
        html += f"""<tr>
          <td style="padding: 12px; font-size: 15px; color: #374151; border-bottom: 1px solid #F3F4F6;">{row.get("label", "")}</td>
          <td style="padding: 12px; font-size: 15px; text-align: right; font-weight: 600; color: #111827; border-bottom: 1px solid #F3F4F6;">{row.get("current", "")}</td>
          <td style="padding: 12px; font-size: 15px; text-align: right; color: #6B7280; border-bottom: 1px solid #F3F4F6;">{row.get("prev", "")}</td>
          <td style="padding: 12px; font-size: 14px; font-weight: 700; text-align: right; color: {color}; border-bottom: 1px solid #F3F4F6;">{change_str}</td>
        </tr>"""
    
    html += "</tbody></table>"
    return html


def _render_attribution_bar(contribution: int, pct: float, is_positive: bool) -> str:
    """渲染归因条形图"""
    color = "#16A34A" if is_positive else "#DC2626"
    icon = "+" if is_positive else ""
    return f"""<tr>
      <td style="padding: 8px 10px; font-size: 14px; color: #374151;">{contribution}</td>
      <td style="padding: 8px 10px; width: 120px;">
        <div style="background: #E5E7EB; border-radius: 4px; height: 8px; overflow: hidden;">
          <div style="background: {color}; width: {abs(pct):.0f}%; height: 100%;"></div>
        </div>
      </td>
      <td style="padding: 8px 10px; font-size: 13px; color: {color}; font-weight: 600;">{icon}{pct:.1f}%</td>
    </tr>"""


def _render_weekly_report_html(report_data: dict[str, Any]) -> str:
    """构建每周报告 HTML 邮件（周报使用自然周数据）。"""
    from datetime import date
    
    project_name = report_data.get("project_name", "项目")
    country = report_data.get("country", "US")
    week_number = report_data.get("week_number", "")
    date_range = report_data.get("date_range", "")
    
    ai_summary = _markdown_to_email_html(report_data.get("ai_summary", "暂无报表总结"))
    
    current_week = report_data.get("current_week", {})
    prev_week = report_data.get("prev_week", {})
    changes = report_data.get("changes", {})
    
    dash_url = report_data.get("dash_url", "https://dash.believeboy.com/dashboard")
    
    # KPI 卡片数据
    wk_qty = current_week.get("qty", 0)
    wk_amt = current_week.get("amount", 0.0)
    pr_qty = prev_week.get("qty", 0)
    pr_amt = prev_week.get("amount", 0.0)
    qty_chg = changes.get("qty_change", 0)
    amt_chg = changes.get("amount_change", 0)
    
    # KPI 卡片
    card_qty = _render_week_kpi_card("本周销量", f"{wk_qty:,}", f"{pr_qty:,}", qty_chg, " 件")
    card_amt = _render_week_kpi_card("本周销售额", _fmt_week_currency(wk_amt), _fmt_week_currency(pr_amt), amt_chg)
    
    # 告警部分
    alerts = report_data.get("alerts", [])
    alert_rows = ""
    for alert in alerts[:5]:
        severity_color = "#DC2626" if alert.get("type") == "critical" else "#F59E0B"
        alert_rows += f"""<tr>
          <td style="padding: 10px 14px; font-size: 14px; color: #374151; border-bottom: 1px solid #F3F4F6;">
            <span style="background:{severity_color};color:white;font-size:12px;font-weight:700;padding:2px 8px;border-radius:3px;margin-right:6px;">{alert.get("type", "").upper()}</span>
            {alert.get("message", "")}
          </td>
        </tr>"""

    alert_section = ""
    if alert_rows:
        alert_section = f"""<tr>
          <td style="padding: 16px;">
            <div style="font-size: 15px; font-weight: 700; color: #111827; margin-bottom: 8px;">⚠️ 需要关注</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; overflow: hidden;">
              {alert_rows}
            </table>
          </td>
        </tr>"""
    
    # 完整 HTML
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
           style="max-width: 680px; margin: 0 auto; background: white; border-radius: 50px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">

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

      <!-- 报表总结 -->
      <tr>
        <td style="padding: 20px 16px 10px; background: #EFF6FF; border-bottom: 1px solid #BFDBFE;">
          <div style="border-left: 4px solid #1D4ED8; padding-left: 10px; font-size: 17px; font-weight: 700; color: #111827; margin-bottom: 12px;">🔍 报表总结</div>
          <div style="font-size: 15px; color: #1E3A5F; line-height: 1.7; padding-left: 14px;">{ai_summary}</div>
        </td>
      </tr>

      <!-- KPI 卡片 -->
      <tr>
        <td style="padding: 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius: 8px; overflow: hidden; border: 1px solid #E5E7EB;">
            <tr>{card_qty}{card_amt}</tr>
          </table>
        </td>
      </tr>

      <!-- 告警 -->
      {alert_section}

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

        html = _render_weekly_report_html(report_data)
        project_name = report_data.get("project_name", "项目")
        week_number = report_data.get("week_number", "")
        
        subject = f"📊 {project_name} · Week {week_number} 周报"

        params: dict[str, Any] = {
            "from": settings.alert_from_email,
            "to": [email],
            "subject": subject,
            "html": html,
        }

        # 生成截图附件并上传到 R2
        try:
            from app.services.scheduled_report.screenshot import html_to_png
            png_bytes = html_to_png(html)
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
