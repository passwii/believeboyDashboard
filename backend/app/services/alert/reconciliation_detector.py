"""Reconciliation alert trigger service.

This module handles automatic alert triggering when reconciliation results show mismatches.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models.alert_rule import AlertRule, AlertMetric
from app.models.alert_event import AlertEvent, AlertEventStatus

logger = logging.getLogger(__name__)


def get_frontend_url() -> str:
    """Get frontend URL from settings."""
    try:
        from app.core.config import get_settings
        return get_settings().frontend_url or "http://localhost:3200"
    except Exception:
        return "http://localhost:3200"


def trigger_reconciliation_alert(
    db: Session,
    report_id: int,
    project_id: int,
    project_name: str,
    country: str,
    report_month: str,
    match_rate: float,
    mismatched_items: int,
    missing_items: int,
    total_diff: float,
    detail_items: List[Dict[str, Any]],
    created_by: str = "system",
) -> Optional[AlertEvent]:
    """
    Trigger a reconciliation alert when mismatch is detected.

    Args:
        db: Database session
        report_id: Monthly report ID
        project_id: Project ID
        project_name: Project name for message
        country: Country code (US, DE, etc.)
        report_month: Report month (YYYY-MM)
        match_rate: Reconciliation match rate (0-100)
        mismatched_items: Number of mismatched fields
        missing_items: Number of missing fields
        total_diff: Total amount difference
        detail_items: List of mismatch details for email
        created_by: Creator operator

    Returns:
        AlertEvent if triggered, None if skipped (dedup)
    """
    # Dedup: check if we already have an active alert for this report this month
    existing = db.execute(
        select(AlertEvent).where(
            AlertEvent.project_id == project_id,
            AlertEvent.metric == AlertMetric.RECONCILIATION_MISMATCH,
            AlertEvent.report_month == report_month,
            AlertEvent.status == AlertEventStatus.ACTIVE,
        )
    ).scalars().first()

    if existing:
        logger.info(f"Skipping duplicate reconciliation alert for report {report_id}, month {report_month}")
        return None

    # Find or create a default rule for reconciliation alerts
    rule = db.execute(
        select(AlertRule).where(
            AlertRule.project_id == project_id,
            AlertRule.metric == AlertMetric.RECONCILIATION_MISMATCH,
            AlertRule.is_active.is_(True),
        )
    ).scalars().first()

    if not rule:
        # Create a default rule for this project if none exists
        rule = AlertRule(
            name=f"报表核对异常 - {project_name}",
            project_id=project_id,
            country=country,
            metric=AlertMetric.RECONCILIATION_MISMATCH,
            trigger_type="threshold",
            condition="below",
            threshold=100.0,  # Alert when match_rate < 100%
            window_days=1,
            severity=_determine_severity(match_rate),
            notification_channels="email",
            is_active=True,
            created_by=created_by,
        )
        db.add(rule)
        db.flush()
        logger.info(f"Created default reconciliation alert rule for project {project_id}")

    # Determine severity based on match rate
    severity = _determine_severity(match_rate)

    # Build message
    message = (
        f"报表核对异常：{project_name} {country} {report_month} "
        f"匹配率 {match_rate:.1f}%，差异 {mismatched_items} 项"
    )

    # Create alert event
    event = AlertEvent(
        rule_id=rule.id,
        project_id=project_id,
        metric=AlertMetric.RECONCILIATION_MISMATCH,
        current_value=float(match_rate),  # Store match rate as current_value
        baseline_value=100.0,  # Expected match rate
        deviation_pct=-(100 - match_rate),  # Negative deviation from 100%
        severity=severity,
        message=message,
        status=AlertEventStatus.ACTIVE,
        # Reconciliation-specific fields
        match_rate=match_rate,
        mismatched_items=mismatched_items,
        total_diff=total_diff,
        report_month=report_month,
        report_id=report_id,
    )
    db.add(event)
    db.commit()
    db.refresh(event)

    logger.info(f"Created reconciliation alert event {event.id} for report {report_id}")

    # Send email notifications to project admins
    _send_reconciliation_email(
        db=db,
        event=event,
        project_name=project_name,
        country=country,
        report_month=report_month,
        match_rate=match_rate,
        mismatched_items=mismatched_items,
        missing_items=missing_items,
        total_diff=total_diff,
        detail_items=detail_items,
    )

    return event


def _determine_severity(match_rate: float) -> str:
    """Determine alert severity based on match rate."""
    if match_rate < 70:
        return "critical"
    elif match_rate < 100:
        return "warning"
    return "info"


def _get_project_admins(db: Session, project_id: int) -> list[dict[str, Any]]:
    """Get admin users for a project via raw SQL."""
    admins = db.execute(
        text(
            "SELECT id, name, full_name, email FROM user_accounts WHERE is_admin = true AND is_active = true"
        )
    ).fetchall()
    return [{"id": int(row[0]), "name": row[1], "email": row[3]} for row in admins if row[3]]


def _send_reconciliation_email(
    db: Session,
    event: AlertEvent,
    project_name: str,
    country: str,
    report_month: str,
    match_rate: float,
    mismatched_items: int,
    missing_items: int,
    total_diff: float,
    detail_items: List[Dict[str, Any]],
) -> None:
    """Send reconciliation alert email to project admins."""
    # Get project admins
    admins = _get_project_admins(db, event.project_id)

    if not admins:
        logger.warning(f"No admin users found for project {event.project_id}")
        return

    # Prepare email recipients
    recipients = [admin["email"] for admin in admins if admin.get("email")]

    if not recipients:
        logger.warning(f"No email addresses found for project {event.project_id} admins")
        return

    # Generate email content
    html = _render_reconciliation_email(
        project_name=project_name,
        country=country,
        report_month=report_month,
        match_rate=match_rate,
        mismatched_items=mismatched_items,
        missing_items=missing_items,
        total_diff=total_diff,
        detail_items=detail_items[:5],  # Top 5 mismatches for email
        severity=event.severity,
    )

    subject = f"[BelieveBoy] 报表核对异常告警 - {project_name} - {report_month}"

    for email in recipients:
        try:
            import resend
            from app.core.config import get_settings
            settings = get_settings()

            if not settings.resend_api_key:
                logger.warning("RESEND_API_KEY not configured, skipping email")
                return

            resend.api_key = settings.resend_api_key

            resp = resend.Emails.send({
                "from": f"{settings.alert_from_name} <{settings.alert_from_email}>",
                "to": [email],
                "subject": subject,
                "html": html,
            })
            logger.info(f"Reconciliation alert email sent to {email}, resend_id={resp.get('id')}")
        except Exception as e:
            logger.error(f"Failed to send reconciliation alert email to {email}: {e}")


def _render_reconciliation_email(
    project_name: str,
    country: str,
    report_month: str,
    match_rate: float,
    mismatched_items: int,
    missing_items: int,
    total_diff: float,
    detail_items: List[Dict[str, Any]],
    severity: str,
) -> str:
    """Render reconciliation alert email HTML."""
    severity_colors = {
        "critical": "#DC2626",
        "warning": "#F59E0B",
        "info": "#2563EB",
    }
    severity_labels = {
        "critical": "严重",
        "warning": "警告",
        "info": "提示",
    }

    color = severity_colors.get(severity, "#6B7280")
    label = severity_labels.get(severity, "未知")

    # Build mismatch table rows
    rows_html = ""
    for item in detail_items:
        if not item.get("match", True):  # Only show mismatched items
            db_val = item.get("db_value")
            pdf_val = item.get("pdf_value")
            diff = item.get("difference")
            rows_html += f"""
            <tr style="border-bottom: 1px solid #E5E7EB;">
              <td style="padding: 8px 12px; font-weight: 500; color: #374151;">{item.get('field_name', '')}</td>
              <td style="padding: 8px 12px; text-align: right; color: #6B7280; font-family: monospace;">{db_val:.2f if db_val else 'N/A'}</td>
              <td style="padding: 8px 12px; text-align: right; color: #6B7280; font-family: monospace;">{pdf_val:.2f if pdf_val else 'N/A'}</td>
              <td style="padding: 8px 12px; text-align: right; color: #DC2626; font-weight: 600; font-family: monospace;">{diff:+.2f if diff else 'N/A'}</td>
            </tr>"""

    # Match rate progress bar
    match_rate_int = int(match_rate)
    bar_color = "#DC2626" if match_rate < 70 else "#F59E0B" if match_rate < 100 else "#10B981"
    frontend_url = get_frontend_url()

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 24px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: #1F2937; padding: 20px 24px;">
      <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 600;">
        📋 报表核对异常告警
      </h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">
        {project_name} · {country} · {report_month}
      </p>
    </div>

    <div style="padding: 24px;">
      <!-- Severity Badge -->
      <div style="margin-bottom: 16px;">
        <span style="display:inline-block;background:{color};color:white;border-radius:4px;padding:4px 12px;font-size:14px;font-weight:600;">
          {label}
        </span>
      </div>

      <!-- Match Rate -->
      <div style="background: #F9FAFB; border-radius: 8px; padding: 16px; margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="color: #6B7280; font-size: 13px;">匹配率</span>
          <span style="font-size: 24px; font-weight: 700; color: {bar_color};">{match_rate:.1f}%</span>
        </div>
        <div style="height: 8px; background: #E5E7EB; border-radius: 4px; overflow: hidden;">
          <div style="height: 100%; width: {match_rate_int}%; background: {bar_color}; border-radius: 4px;"></div>
        </div>
      </div>

      <!-- Summary Stats -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px;">
        <div style="background: #FEF2F2; border-radius: 8px; padding: 12px; text-align: center;">
          <div style="font-size: 20px; font-weight: 700; color: #DC2626;">{mismatched_items}</div>
          <div style="font-size: 11px; color: #991B1B;">差异项</div>
        </div>
        <div style="background: #FEF3C7; border-radius: 8px; padding: 12px; text-align: center;">
          <div style="font-size: 20px; font-weight: 700; color: #D97706;">{missing_items}</div>
          <div style="font-size: 11px; color: #92400E;">缺失项</div>
        </div>
        <div style="background: #FEE2E2; border-radius: 8px; padding: 12px; text-align: center;">
          <div style="font-size: 20px; font-weight: 700; color: #DC2626;">${abs(total_diff):.2f}</div>
          <div style="font-size: 11px; color: #991B1B;">总差异</div>
        </div>
      </div>

      <!-- Mismatch Details -->
      {rows_html if rows_html else '<p style="color: #6B7280; font-size: 13px;">详情请查看核对页面</p>'}
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <thead>
          <tr style="background: #F9FAFB;">
            <th style="padding: 8px 12px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase;">字段</th>
            <th style="padding: 8px 12px; text-align: right; font-size: 11px; color: #6B7280; text-transform: uppercase;">数据库</th>
            <th style="padding: 8px 12px; text-align: right; font-size: 11px; color: #6B7280; text-transform: uppercase;">PDF</th>
            <th style="padding: 8px 12px; text-align: right; font-size: 11px; color: #6B7280; text-transform: uppercase;">差值</th>
          </tr>
        </thead>
        <tbody>{rows_html}</tbody>
      </table>

      <!-- CTA Button -->
      <div style="margin-top: 24px; text-align: center;">
        <a href="{frontend_url}/dashboard/data-management/report-reconciliation?report={report_month}"
           style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:12px 24px;border-radius:6px;font-size:14px;font-weight:500;">
          查看核对详情 →
        </a>
      </div>
    </div>

    <div style="padding: 16px 24px; background: #F9FAFB; border-top: 1px solid #E5E7EB;">
      <p style="margin: 0; color: #9CA3AF; font-size: 12px;">
        此邮件由 BelieveBoy 系统自动发送。如有疑问请联系管理员。
      </p>
    </div>
  </div>
</body>
</html>"""
    return html