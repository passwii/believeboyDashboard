"""Background scheduler for alert anomaly detection and scheduled reports."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_scheduler: "BackgroundScheduler" | None = None


def get_scheduler():
    """Get the global scheduler instance (for insight_schedule_service)."""
    return _scheduler


def _run_report_dispatch(frequency: str) -> None:
    """Wrapper for APScheduler — runs in a background thread."""
    try:
        from app.services.scheduled_report.dispatcher import dispatch_reports
        result = dispatch_reports(frequency)
        logger.info("Scheduled %s report dispatch: sent=%d failed=%d",
                     frequency, result["sent"], result["failed"])
    except Exception as e:
        logger.error("Scheduled %s report dispatch crashed: %s", frequency, e)


def init_scheduler() -> None:
    """Initialize and start the background scheduler.

    Registers:
    - Insight schedules
    - Daily report dispatch (15:00 CST = 07:00 UTC)
    - Weekly report dispatch (Monday 15:00 CST)
    - Monthly report dispatch (1st of month 15:00 CST)
    """
    global _scheduler
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler

        _scheduler = BackgroundScheduler()
        _scheduler.start()
        logger.info("Scheduler started")

        # Load insight schedules into scheduler
        try:
            from app.services.insight_schedule_service import (
                reload_insight_schedules,
            )
            reload_insight_schedules()
            logger.info("Insight schedules loaded into scheduler")
        except Exception as e:
            logger.error(f"Failed to load insight schedules: {e}")

        # Daily report: 15:00 CST (UTC+8) = 07:00 UTC
        _scheduler.add_job(
            _run_report_dispatch,
            "cron",
            args=["daily"],
            hour=7,
            minute=0,
            id="scheduled_report_daily",
            replace_existing=True,
        )
        # Weekly report: Monday 15:00 CST
        _scheduler.add_job(
            _run_report_dispatch,
            "cron",
            args=["weekly"],
            day_of_week="mon",
            hour=7,
            minute=0,
            id="scheduled_report_weekly",
            replace_existing=True,
        )
        # Monthly report: 1st of month 15:00 CST
        _scheduler.add_job(
            _run_report_dispatch,
            "cron",
            args=["monthly"],
            day=1,
            hour=7,
            minute=0,
            id="scheduled_report_monthly",
            replace_existing=True,
        )
        logger.info("Scheduled report jobs registered (daily/weekly/monthly at 15:00 CST)")

    except ImportError:
        logger.warning("APScheduler not installed, scheduler disabled")
    except Exception as e:
        logger.error(f"Failed to start scheduler: {e}")


def shutdown_scheduler() -> None:
    """Shutdown the scheduler on app shutdown."""
    global _scheduler
    if _scheduler:
        # Shutdown insight schedules first
        try:
            from app.services.insight_schedule_service import shutdown_insight_schedules
            shutdown_insight_schedules()
        except Exception as e:
            logger.error(f"Error shutting down insight schedules: {e}")

        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
