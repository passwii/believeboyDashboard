"""Background scheduler for alert anomaly detection and scheduled reports."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_scheduler: "BackgroundScheduler" | None = None


def init_scheduler() -> None:
    """Initialize and start the background scheduler."""
    global _scheduler
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger
        from app.services.alert.detector import detect_anomalies
        from app.services.alert.dispatcher import dispatch_batch
        from app.db.session import SessionLocal

        def run_detection() -> None:
            logger.info("Running scheduled anomaly detection...")
            db = SessionLocal()
            try:
                events = detect_anomalies(db)
                db.commit()
                if events:
                    dispatch_batch(db, events)
                    logger.info(f"Anomaly detection: {len(events)} events created and dispatched")
            except Exception as e:
                logger.error(f"Anomaly detection failed: {e}")
                db.rollback()
            finally:
                db.close()

        _scheduler = BackgroundScheduler()
        _scheduler.add_job(
            run_detection,
            CronTrigger(minute=0),
            id="anomaly_detection_hourly",
            replace_existing=True,
            name="每小时异常检测",
        )

        # Register scheduled report jobs
        _scheduler.add_job(
            _run_scheduled_report,
            CronTrigger(hour=15, minute=0, timezone="Asia/Shanghai"),
            id="daily_report",
            replace_existing=True,
            name="每日运营报告",
            kwargs={"frequency": "daily"},
        )

        _scheduler.add_job(
            _run_scheduled_report,
            CronTrigger(day_of_week="tue", hour=10, minute=0, timezone="Asia/Shanghai"),
            id="weekly_report",
            replace_existing=True,
            name="每周运营报告",
            kwargs={"frequency": "weekly"},
        )

        _scheduler.add_job(
            _run_scheduled_report,
            CronTrigger(day=4, hour=10, minute=0, timezone="Asia/Shanghai"),
            id="monthly_report",
            replace_existing=True,
            name="每月运营报告",
            kwargs={"frequency": "monthly"},
        )

        _scheduler.start()
        logger.info("Scheduler started: hourly anomaly detection + daily(15:00) + weekly(Tue 10:00) + monthly(day 4 10:00)")
    except ImportError:
        logger.warning("APScheduler not installed, scheduled alerts disabled")
    except Exception as e:
        logger.error(f"Failed to start scheduler: {e}")


def _run_scheduled_report(frequency: str) -> None:
    """Run scheduled report for given frequency."""
    from app.db.session import SessionLocal
    from app.services.scheduled_report import (
        get_active_subscriptions,
        create_delivery_log,
        mark_delivery_success,
        mark_delivery_failed,
    )
    from app.services.scheduled_report.generators import (
        collect_daily_report_data,
        collect_weekly_report_data,
        collect_monthly_report_data,
    )
    from app.services.scheduled_report.ai_enhancer import generate_ai_summary
    from app.services.scheduled_report.email_sender import send_scheduled_report_email

    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, frequency)
        if not subscriptions:
            logger.info(f"No active subscriptions for frequency={frequency}")
            return

        logger.info(f"Running scheduled report for frequency={frequency}, {len(subscriptions)} subscriptions")

        for sub in subscriptions:
            try:
                if frequency == "daily":
                    report_data = collect_daily_report_data(db, sub)
                elif frequency == "weekly":
                    report_data = collect_weekly_report_data(db, sub)
                else:
                    report_data = collect_monthly_report_data(db, sub)

                report_data["ai_summary"] = generate_ai_summary(frequency, report_data)

                log = create_delivery_log(
                    db,
                    subscription_id=sub.id,
                    frequency=frequency,
                    report_date=report_data.get("report_date", ""),
                    report_month=report_data.get("report_month"),
                    email=sub.email,
                )

                success, error = send_scheduled_report_email(sub.email, frequency, report_data)

                if success:
                    mark_delivery_success(db, log.id)
                    logger.info(f"Report sent to {sub.email} for frequency={frequency}")
                else:
                    mark_delivery_failed(db, log.id, error or "Unknown error")
                    logger.warning(f"Report failed for {sub.email}: {error}")

            except Exception as e:
                logger.error(f"Failed to send report to {sub.email}: {e}")

        logger.info(f"Scheduled report completed for frequency={frequency}")
    finally:
        db.close()


def shutdown_scheduler() -> None:
    """Shutdown the scheduler on app shutdown."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")
