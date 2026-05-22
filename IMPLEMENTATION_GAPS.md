# Implementation Gaps - What's Missing for Automated Dispatch

## Gap #1: No Dispatcher Service

**Current State:** Subscriptions + reports can be built/sent manually via API.
**Missing:** Service that automatically iterates over subscriptions and sends reports.

**Need to Create:** `backend/app/services/scheduled_report/dispatcher.py`

```python
# Pseudocode
def dispatch_daily_reports():
    db = SessionLocal()
    try:
        subs = get_active_subscriptions(db, "daily")  # ← Already exists
        
        stats = {
            "total": len(subs),
            "sent": 0,
            "failed": 0,
            "errors": []
        }
        
        for sub in subs:
            try:
                log = create_delivery_log(db, sub.id, "daily", today, None, sub.email)
                report_data = build_report_email_data(db, sub.project_id_list, sub.country, "daily")
                success, error = send_scheduled_report_email(sub.email, "daily", report_data)
                
                if success:
                    mark_delivery_success(db, log.id, error)  # error is resend_id
                    stats["sent"] += 1
                else:
                    mark_delivery_failed(db, log.id, error)
                    stats["failed"] += 1
                    stats["errors"].append({
                        "subscription_id": sub.id,
                        "email": sub.email,
                        "error": error
                    })
            except Exception as e:
                stats["failed"] += 1
                stats["errors"].append({
                    "subscription_id": sub.id,
                    "email": sub.email,
                    "error": str(e)
                })
        
        log_summary(stats)
        
    finally:
        db.close()
```

---

## Gap #2: No Cron Job Registration

**Current State:** `init_scheduler()` exists but only registers insight schedules.
**Missing:** Cron job registration for daily/weekly/monthly reports.

**Need to Update:** `backend/app/core/scheduler.py`

```python
def init_scheduler() -> None:
    """Initialize scheduler and register both insight and report jobs."""
    global _scheduler
    if _scheduler is not None:
        return

    try:
        from apscheduler.schedulers.background import BackgroundScheduler
        from apscheduler.triggers.cron import CronTrigger

        _scheduler = BackgroundScheduler()
        _scheduler.start()
        logger.info("Scheduler started")

        # Load insight schedules (existing)
        try:
            from app.services.insight_schedule_service import reload_insight_schedules
            reload_insight_schedules()
            logger.info("Insight schedules loaded")
        except Exception as e:
            logger.error(f"Failed to load insight schedules: {e}")

        # MISSING: Load scheduled report jobs
        try:
            from app.services.scheduled_report.dispatcher import (
                dispatch_daily_reports,
                dispatch_weekly_reports,
                dispatch_monthly_reports,
            )
            
            _scheduler.add_job(
                dispatch_daily_reports,
                CronTrigger(hour=15, minute=0),  # 15:00 UTC daily
                id="dispatch-daily-reports",
                name="Dispatch Daily Reports",
                max_instances=1,  # Prevent parallel runs
            )
            
            _scheduler.add_job(
                dispatch_weekly_reports,
                CronTrigger(day_of_week=0, hour=10, minute=0),  # Monday 10:00 UTC
                id="dispatch-weekly-reports",
                name="Dispatch Weekly Reports",
                max_instances=1,
            )
            
            _scheduler.add_job(
                dispatch_monthly_reports,
                CronTrigger(day=1, hour=9, minute=0),  # 1st of month 09:00 UTC
                id="dispatch-monthly-reports",
                name="Dispatch Monthly Reports",
                max_instances=1,
            )
            
            logger.info("Scheduled report jobs registered")
        except Exception as e:
            logger.error(f"Failed to load scheduled report jobs: {e}")

    except ImportError:
        logger.warning("APScheduler not installed, scheduler disabled")
    except Exception as e:
        logger.error(f"Failed to start scheduler: {e}")
```

---

## Gap #3: No Rate Limiting / Concurrency Control

**Current State:** If dispatcher runs, it sends all emails sequentially without rate limiting.
**Issue:** 
- Resend API rate limit: ~1000 req/min (varies by plan)
- 500 subscriptions = 500 sequential emails × 500ms = 4+ minutes
- No backpressure, all 500 queued at once

**Solution:** Add batch processing with delay

```python
import asyncio
import time
from typing import Callable

def dispatch_with_rate_limiting(
    subscriptions: list,
    send_func: Callable,
    batch_size: int = 50,
    delay_between_batches: float = 5.0,  # seconds
):
    """
    Process subscriptions in batches with delay to respect rate limits.
    
    Example: 500 subscriptions, batch_size=50, delay=5s
    - Batch 1: 50 emails (0-5s)
    - Batch 2: 50 emails (5-10s)
    - ...
    - Batch 10: 50 emails (45-50s)
    Total: ~50s vs 4+ minutes sequential
    """
    results = {
        "sent": 0,
        "failed": 0,
        "errors": []
    }
    
    for i in range(0, len(subscriptions), batch_size):
        batch = subscriptions[i:i+batch_size]
        
        for sub in batch:
            try:
                success, error = send_func(sub)
                if success:
                    results["sent"] += 1
                else:
                    results["failed"] += 1
                    results["errors"].append({"sub_id": sub.id, "error": error})
            except Exception as e:
                results["failed"] += 1
                results["errors"].append({"sub_id": sub.id, "error": str(e)})
        
        logger.info(f"Batch {i//batch_size + 1}: processed {len(batch)} emails")
        
        # Sleep before next batch (except after last batch)
        if i + batch_size < len(subscriptions):
            time.sleep(delay_between_batches)
    
    return results
```

---

## Gap #4: No Retry Logic for Failed Deliveries

**Current State:** Failed emails logged but never retried.
**Missing:** Exponential backoff retry mechanism.

**Solution:** Add retry table + background task

```python
# New table needed:
class ScheduledReportRetryQueue(Base):
    __tablename__ = "scheduled_report_retry_queue"
    
    id: int (PK)
    delivery_log_id: int (FK to delivery_logs)
    subscription_id: int (FK to subscriptions)
    email: str
    frequency: str
    report_data_json: dict  # Cache report data to avoid rebuilding
    attempt_count: int (default=1)
    next_retry_at: datetime
    status: str ("queued", "retrying", "abandoned")
    created_at: datetime
    updated_at: datetime

def retry_failed_deliveries():
    """Run periodically to retry failed emails."""
    db = SessionLocal()
    try:
        # Find emails ready to retry
        now = datetime.now(UTC)
        retries = db.query(ScheduledReportRetryQueue).filter(
            ScheduledReportRetryQueue.next_retry_at <= now,
            ScheduledReportRetryQueue.status == "queued",
            ScheduledReportRetryQueue.attempt_count < 5,  # Max 5 attempts
        ).all()
        
        for retry in retries:
            try:
                success, error = send_scheduled_report_email(
                    retry.email,
                    retry.frequency,
                    json.loads(retry.report_data_json)
                )
                
                if success:
                    # Mark log as sent
                    mark_delivery_success(db, retry.delivery_log_id)
                    # Remove from retry queue
                    db.delete(retry)
                else:
                    # Schedule next retry with exponential backoff
                    retry.attempt_count += 1
                    retry.next_retry_at = now + timedelta(
                        minutes=2 ** retry.attempt_count  # 2, 4, 8, 16, 32 minutes
                    )
                    retry.status = "queued"
                
                db.commit()
            except Exception as e:
                logger.error(f"Retry failed for {retry.id}: {e}")
                db.rollback()
    finally:
        db.close()
```

---

## Gap #5: No AI Summary Caching

**Current State:** Every report generates unique AI summary (Claude API call each time).
**Issue:** 
- If 100 daily reports for same project → 100 Claude API calls
- Claude API: $5 per 1M tokens → costs add up
- 2-5s per call × 100 = 200-500s blocked on AI

**Solution:** Cache AI summaries by (project_ids, report_date, frequency)

```python
# New table:
class AIGeneratedSummaryCache(Base):
    __tablename__ = "ai_generated_summary_cache"
    
    id: int (PK)
    frequency: str
    report_date: str
    project_ids: str  # CSV or "*"
    summary: str
    created_at: datetime
    expires_at: datetime  # Expire after 7 days

def get_or_generate_summary(db, frequency, report_date, project_ids, overview):
    """Get cached summary or generate new one."""
    cache_key = f"{frequency}:{report_date}:{project_ids}"
    
    # Check cache
    cached = db.query(AIGeneratedSummaryCache).filter(
        AIGeneratedSummaryCache.frequency == frequency,
        AIGeneratedSummaryCache.report_date == report_date,
        AIGeneratedSummaryCache.project_ids == project_ids,
        AIGeneratedSummaryCache.expires_at > datetime.now(UTC),
    ).first()
    
    if cached:
        logger.info(f"Using cached summary: {cache_key}")
        return cached.summary
    
    # Generate new
    summary = generate_ai_summary(frequency, overview)
    
    # Cache it
    AIGeneratedSummaryCache(
        frequency=frequency,
        report_date=report_date,
        project_ids=project_ids,
        summary=summary,
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db.add(...)
    db.commit()
    
    return summary
```

---

## Gap #6: No Monitoring / Alerting

**Current State:** Dispatch runs but no visibility into success rates or failures.
**Missing:** Metrics, logging, alerting.

**Solution:** Add dispatch metrics

```python
import logging
from dataclasses import dataclass
from datetime import datetime

@dataclass
class DispatchMetrics:
    frequency: str
    started_at: datetime
    ended_at: datetime
    total_subscriptions: int
    sent: int
    failed: int
    errors: list[dict]
    duration_seconds: float
    success_rate: float

def log_dispatch_metrics(metrics: DispatchMetrics):
    """Log dispatch metrics for monitoring."""
    logger.info(
        f"Dispatch report: frequency={metrics.frequency}, "
        f"total={metrics.total_subscriptions}, "
        f"sent={metrics.sent}, "
        f"failed={metrics.failed}, "
        f"success_rate={metrics.success_rate:.1f}%, "
        f"duration={metrics.duration_seconds:.1f}s"
    )
    
    # TODO: Send to monitoring service (Sentry, DataDog, etc.)
    # sentry_sdk.capture_message(f"Daily report dispatch complete", "info")
    
    if metrics.success_rate < 0.95:
        logger.warning(f"Low success rate: {metrics.success_rate:.1f}%")
        # TODO: Send alert to ops team
        # send_alert_email("ops@believeboy.com", "Low scheduled report success rate")
    
    if metrics.failed > 10:
        logger.error(f"{metrics.failed} reports failed, check delivery logs")
```

---

## Gap #7: No Timezone Handling for Scheduled Times

**Current State:** Reports dispatch at hardcoded UTC times (15:00, 10:00, 09:00 UTC).
**Issue:** Users in different timezones may expect reports at local times.
**Example:** User in US PT (UTC-7) expects daily report at 9am PT = 4pm UTC

**Solution:** Store timezone preference + adjust cron schedules per user

```python
# Extend ScheduledReportSubscription:
timezone: str (default="UTC")  # e.g., "US/Pacific", "Europe/London"

# Adjust cron to account for timezones
def get_optimal_dispatch_times():
    """Determine cron times based on user timezones."""
    db = SessionLocal()
    
    # Count subscriptions by timezone
    timezones = db.query(
        ScheduledReportSubscription.timezone,
        func.count().label("count")
    ).group_by(ScheduledReportSubscription.timezone).all()
    
    # Find most common timezone
    most_common = max(timezones, key=lambda x: x.count)
    tz = most_common.timezone or "UTC"
    
    # Convert 9am local time to UTC
    from pytz import timezone as pytz_tz
    local_time = pytz_tz(tz).localize(datetime(2026, 5, 22, 9, 0))
    utc_time = local_time.astimezone(pytz_tz("UTC"))
    
    logger.info(f"Optimal dispatch time: {utc_time.hour}:{utc_time.minute:02d} UTC "
                f"(9am in {tz})")
    
    return utc_time.hour, utc_time.minute
```

---

## Summary: What Needs to Be Built

| Gap | Priority | Effort | Risk |
|-----|----------|--------|------|
| #1: Dispatcher service | 🔴 Critical | 2-3h | Low |
| #2: Cron job registration | 🔴 Critical | 1h | Low |
| #3: Rate limiting | 🟡 High | 1-2h | Medium |
| #4: Retry logic | 🟡 High | 2-3h | Medium |
| #5: AI summary caching | 🟡 High | 1-2h | Low |
| #6: Monitoring | 🟡 High | 1-2h | Low |
| #7: Timezone support | 🟠 Medium | 1-2h | Medium |

**Total estimated effort:** 10-16 hours (including tests & documentation)

---

## Recommended Implementation Order

1. **Phase 1 (MVP - 4-5 hours):**
   - Create dispatcher service (#1)
   - Register cron jobs (#2)
   - Basic error handling
   - Get to "automated daily reports working"

2. **Phase 2 (Reliability - 4-6 hours):**
   - Add rate limiting (#3)
   - Add retry logic (#4)
   - Add monitoring (#6)
   - Test at scale (100+ subscriptions)

3. **Phase 3 (Optimization - 2-3 hours):**
   - Add AI summary caching (#5)
   - Add timezone support (#7)
   - Performance monitoring

