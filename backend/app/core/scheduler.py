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


def _run_minutely_scan() -> None:
    """Scan all active subscriptions and dispatch those matching current Beijing time (hour + minute)."""
    try:
        from datetime import datetime
        from zoneinfo import ZoneInfo

        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        current_hour = now.hour
        current_minute = now.minute
        current_weekday = now.weekday()  # 0=Monday, 6=Sunday
        current_day = now.day

        from app.db.session import SessionLocal
        from app.models.scheduled_report import ScheduledReportSubscription
        from sqlalchemy import select, and_

        db = SessionLocal()
        try:
            query = (
                select(ScheduledReportSubscription)
                .where(
                    and_(
                        ScheduledReportSubscription.enabled == True,
                        ScheduledReportSubscription.dispatch_hour == current_hour,
                        ScheduledReportSubscription.dispatch_minute == current_minute,
                    )
                )
            )
            subscriptions = list(db.execute(query).scalars().all())
        finally:
            db.close()

        if not subscriptions:
            return

        # Group by frequency, respecting day-of-week/month constraints
        daily_subs = []
        weekly_subs = []
        monthly_subs = []

        for sub in subscriptions:
            if sub.frequency == "daily":
                daily_subs.append(sub)
            elif sub.frequency == "weekly":
                # 匹配用户选择的发送星期
                sub_weekday = sub.dispatch_weekday if sub.dispatch_weekday is not None else 0
                if current_weekday == sub_weekday:
                    weekly_subs.append(sub)
            elif sub.frequency == "monthly":
                # 匹配用户选择的发送日
                sub_day = sub.dispatch_day if sub.dispatch_day is not None else 2
                if current_day == sub_day:
                    monthly_subs.append(sub)

        if daily_subs:
            logger.info(
                "Minutely scan: dispatching %d daily subscription(s) at %02d:%02d",
                len(daily_subs), current_hour, current_minute,
            )
            _dispatch_subscriptions("daily", daily_subs)

        if weekly_subs:
            logger.info(
                "Minutely scan: dispatching %d weekly subscription(s) at weekday=%d %02d:%02d",
                len(weekly_subs), current_weekday, current_hour, current_minute,
            )
            _dispatch_subscriptions("weekly", weekly_subs)

        if monthly_subs:
            logger.info(
                "Minutely scan: dispatching %d monthly subscription(s) at day=%d %02d:%02d",
                len(monthly_subs), current_day, current_hour, current_minute,
            )
            _dispatch_subscriptions("monthly", monthly_subs)

    except Exception as e:
        logger.error("Minutely dispatch scan crashed: %s", e)


def _dispatch_subscriptions(frequency: str, subscriptions: list) -> None:
    """Dispatch a pre-filtered list of subscriptions directly (bypass get_active_subscriptions query).

    双分支（方案 §4.7 / 切片 3）：
    - `SCHEDULED_REPORT_VIA_CELERY=true`：派每个订阅到
      `app.celery_tasks.scheduled_report.dispatch_one.apply_async(...)`，
      countdown=i*SPREAD_SECONDS 错峰；thread pool 不启动。
    - `SCHEDULED_REPORT_VIA_CELERY=false`：保留 ThreadPoolExecutor 同步派发，
      一行不动，方便 `SCHEDULED_REPORT_VIA_CELERY=false` 秒级回滚。
    """
    from app.core.config import get_settings

    settings = get_settings()

    if settings.scheduled_report_via_celery:
        from datetime import date

        from app.celery_tasks.scheduled_report import dispatch_one as dispatch_one_task

        report_date_str = date.today().isoformat()
        # Sort by sub.id so countdown determinism matches the documented ordering.
        ordered = sorted(subscriptions, key=lambda s: s.id)
        for i, sub in enumerate(ordered):
            dispatch_one_task.apply_async(
                kwargs={
                    "subscription_id": sub.id,
                    "email": sub.email,
                    "project_ids": sub.project_id_list or None,
                    "country": sub.country,
                    "frequency": frequency,
                    "ai_model": getattr(sub, "ai_model", None),
                    "triggered_by": "auto",
                    "report_date": report_date_str,
                },
                countdown=i * settings.scheduled_dispatch_spread_seconds,
            )
        logger.info(
            "Hourly %s dispatch enqueued to Celery: %d task(s) spread=%ds each",
            frequency,
            len(ordered),
            settings.scheduled_dispatch_spread_seconds,
        )
        return

    # ----- 回滚形态：与改造前完全一致 ---------------------------------------
    from app.services.scheduled_report.dispatcher import _dispatch_one

    results: list[dict] = []
    from concurrent.futures import ThreadPoolExecutor, as_completed

    tasks = [
        {
            "subscription_id": sub.id,
            "email": sub.email,
            "project_ids": sub.project_id_list or None,
            "country": sub.country,
            "frequency": frequency,
            "ai_model": getattr(sub, "ai_model", None),
        }
        for sub in subscriptions
    ]

    max_workers = min(len(tasks), 8)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_dispatch_one, **task): task for task in tasks}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                task = futures[future]
                logger.error("Unexpected error dispatching sub %d: %s", task["subscription_id"], e)

    sent = sum(1 for r in results if r.get("success"))
    failed = len(results) - sent
    logger.info("Hourly %s dispatch done: sent=%d failed=%d", frequency, sent, failed)


def init_scheduler() -> None:
    """Initialize and start the background scheduler.

    Registers:
    - Insight schedules
    - Minutely dispatch scanner (checks all subscriptions every minute, Beijing time)
    """
    global _scheduler
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler

        _scheduler = BackgroundScheduler(timezone="Asia/Shanghai")
        _scheduler.start()
        logger.info("Scheduler started (tz=Asia/Shanghai)")

        # Load insight schedules into scheduler
        try:
            from app.services.insight_schedule_service import (
                reload_insight_schedules,
            )
            reload_insight_schedules()
            logger.info("Insight schedules loaded into scheduler")
        except Exception as e:
            logger.error(f"Failed to load insight schedules: {e}")

        # Minutely scan: every minute, check subscriptions matching current hour:minute
        _scheduler.add_job(
            _run_minutely_scan,
            "cron",
            minute="*",
            id="scheduled_report_minutely_scan",
            replace_existing=True,
        )
        logger.info("Scheduled report minutely scan registered (fires every minute, Asia/Shanghai)")

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
