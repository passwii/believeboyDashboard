"""Scheduled report services package."""

from __future__ import annotations

from app.services.scheduled_report.subscription_service import (
    get_subscriptions_by_user,
    get_active_subscriptions,
    create_subscription,
    update_subscription,
    delete_subscription,
    get_delivery_logs,
    create_delivery_log,
    mark_delivery_success,
    mark_delivery_failed,
)
from app.services.scheduled_report.dispatcher import dispatch_reports
from app.services.scheduled_report.ledger_service import (
    refresh_ledger,
    resend_ledger_entry,
    regenerate_ledger_ai_summary_async,
)

# Weekly report exports
from app.services.scheduled_report.report_builder_daily import build_report_email_data
from app.services.scheduled_report.report_builder_weekly import build_weekly_report_data
from app.services.scheduled_report.ai_enhancer_weekly import (
    generate_weekly_ai_summary,
    generate_weekly_attribution_analysis,
    generate_weekly_alert_insights,
    detect_weekly_anomalies,
)

# Email sender exports
from app.services.scheduled_report.email_sender_daily import send_scheduled_report_email
from app.services.scheduled_report.email_sender_weekly import send_weekly_report_email

__all__ = [
    # Subscription management
    'get_subscriptions_by_user',
    'get_active_subscriptions',
    'create_subscription',
    'update_subscription',
    'delete_subscription',
    'get_delivery_logs',
    'create_delivery_log',
    'mark_delivery_success',
    'mark_delivery_failed',
    'dispatch_reports',
    'refresh_ledger',
    'resend_ledger_entry',
    'regenerate_ledger_ai_summary_async',
    
    # Weekly report
    'build_weekly_report_data',
    'generate_weekly_ai_summary',
    'generate_weekly_attribution_analysis',
    'generate_weekly_alert_insights',
    'detect_weekly_anomalies',
    'send_weekly_report_email',
    'send_scheduled_report_email',
    'build_report_email_data',
]
