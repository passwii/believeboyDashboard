"""Alert email service using Resend."""

from __future__ import annotations

import logging
from datetime import datetime

import resend

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def send_alert_email(to_email: str, alerts: list) -> bool:
    """
    Send an alert email via Resend. Batches multiple alerts into one email.

    Args:
        to_email: Recipient email address.
        alerts: List of AlertEvent objects.
    """
    settings = get_settings()
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured, skipping email")
        return False

    if not alerts:
        return False

    resend.api_key = settings.resend_api_key

    # Group by severity
    critical = [a for a in alerts if a.severity == "critical"]
    warning = [a for a in alerts if a.severity == "warning"]
    info = [a for a in alerts if a.severity == "info"]

    total = len(alerts)
    if total == 1:
        subject = f"[{alerts[0].severity.upper()}] BelieveBoy 告警: {alerts[0].message}"
    else:
        parts = []
        if critical:
            parts.append(f"{len(critical)} 条严重")
        if warning:
            parts.append(f"{len(warning)} 条警告")
        if info:
            parts.append(f"{len(info)} 条提示")
        subject = f"[告警] BelieveBoy 发现 {total} 条异常 ({', '.join(parts)})"

    html = _render_email_html(alerts)

    try:
        resp = resend.Emails.send({
            "from": f"{settings.alert_from_name} <{settings.alert_from_email}>",
            "to": [to_email],
            "subject": subject,
            "html": html,
        })
        logger.info(f"Alert email sent to {to_email}, resend_id={resp.get('id')}")
        return True
    except Exception as e:
        logger.error(f"Failed to send alert email to {to_email}: {e}")
        return False


def _render_email_html(alerts: list) -> str:
    severity_colors = {
        "critical": "#DC2626",
        "warning": "#D97706",
        "info": "#2563EB",
    }
    severity_labels = {
        "critical": "严重",
        "warning": "警告",
        "info": "提示",
    }

    rows_html = ""
    for alert in alerts:
        color = severity_colors.get(alert.severity, "#6B7280")
        label = severity_labels.get(alert.severity, "未知")
        deviation = f"{alert.deviation_pct:+.1f}%" if alert.deviation_pct else ""
        triggered = alert.triggered_at.strftime("%m-%d %H:%M") if alert.triggered_at else ""
        rows_html += f"""
        <tr style="border-bottom: 1px solid #E5E7EB;">
          <td style="padding: 12px 16px;">
            <span style="display:inline-block;background:{color};color:white;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;">
              {label}
            </span>
          </td>
          <td style="padding: 12px 16px; color: #1F2937; font-size: 14px;">{alert.message}</td>
          <td style="padding: 12px 16px; color: #6B7280; font-size: 12px; white-space: nowrap;">{triggered}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: #1F2937; padding: 20px 24px;">
      <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 600;">
        🔔 BelieveBoy 告警通知
      </h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">
        {len(alerts)} 条异常待处理 · {datetime.now().strftime('%Y-%m-%d %H:%M')}
      </p>
    </div>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #F9FAFB;">
          <th style="padding: 8px 16px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">级别</th>
          <th style="padding: 8px 16px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">告警内容</th>
          <th style="padding: 8px 16px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">时间</th>
        </tr>
      </thead>
      <tbody>{rows_html}</tbody>
    </table>
    <div style="padding: 16px 24px; border-top: 1px solid #E5E7EB;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;">
        查看告警详情 →
      </a>
    </div>
  </div>
</body>
</html>"""
    return html