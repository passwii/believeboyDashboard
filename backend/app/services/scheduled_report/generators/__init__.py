"""Scheduled report generators package."""

from __future__ import annotations

from app.services.scheduled_report.generators.daily import collect_daily_report_data
from app.services.scheduled_report.generators.weekly import collect_weekly_report_data
from app.services.scheduled_report.generators.monthly import collect_monthly_report_data

__all__ = [
    'collect_daily_report_data',
    'collect_weekly_report_data',
    'collect_monthly_report_data',
]
