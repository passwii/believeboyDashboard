# Scheduled Reports Code Map & Quick Reference

## File Organization Tree

```
backend/
├── app/
│   ├── api/v1/endpoints/
│   │   └── scheduled_reports.py
│   │       ├── @router.get("/scheduled-reports/subscriptions")
│   │       ├── @router.post("/scheduled-reports/subscriptions")
│   │       ├── @router.put("/scheduled-reports/subscriptions/{id}")
│   │       ├── @router.delete("/scheduled-reports/subscriptions/{id}")
│   │       ├── @router.get("/scheduled-reports/delivery-logs")
│   │       └── @router.post("/scheduled-reports/test-email") ← MANUAL TRIGGER
│   │
│   ├── models/
│   │   └── scheduled_report.py
│   │       ├── ScheduledReportSubscription
│   │       │   └── project_id_list property
│   │       └── ScheduledReportDeliveryLog
│   │           └── DeliveryStatus enum (PENDING, SENT, FAILED)
│   │
│   ├── services/
│   │   └── scheduled_report/
│   │       ├── __init__.py (exports all public functions)
│   │       ├── subscription_service.py
│   │       │   ├── get_active_subscriptions() ← KEY: fetch by frequency
│   │       │   ├── get_subscriptions_by_user()
│   │       │   ├── create_subscription()
│   │       │   ├── update_subscription()
│   │       │   ├── delete_subscription()
│   │       │   ├── get_delivery_logs()
│   │       │   ├── create_delivery_log() ← KEY: track sends
│   │       │   ├── mark_delivery_success()
│   │       │   └── mark_delivery_failed()
│   │       │
│   │       ├── report_builder.py
│   │       │   ├── build_report_email_data() ← KEY: aggregates data
│   │       │   │   ├─ _get_report_anchor_date() [timezone-aware]
│   │       │   │   ├─ build_dashboard_overview() [external query]
│   │       │   │   ├─ _query_top_skus()
│   │       │   │   ├─ _query_inventory_alerts()
│   │       │   │   ├─ _query_top_return_reasons()
│   │       │   │   └─ _generate_summary() [calls ai_enhancer]
│   │       │   └─ [Returns dict with 11 keys]
│   │       │
│   │       ├── email_sender.py
│   │       │   ├── send_scheduled_report_email() ← KEY: sends email
│   │       │   │   ├─ _render_daily_report_html() [27KB+ template!]
│   │       │   │   ├─ html_to_png() [optional attachment]
│   │       │   │   └─ resend.Emails.send() [via Resend API]
│   │       │   ├── send_test_report_email()
│   │       │   ├── _markdown_to_email_html()
│   │       │   ├── _basic_markdown_to_html()
│   │       │   ├── _inline_markdown()
│   │       │   ├── _fmt_currency()
│   │       │   ├── _color_positive()
│   │       │   ├── _color_delta()
│   │       │   ├── _arrow_delta()
│   │       │   └── _safe_html()
│   │       │
│   │       ├── ai_enhancer.py
│   │       │   ├── generate_ai_summary() ← KEY: AI-powered summary
│   │       │   │   ├─ resolve_available_models() [LLM service]
│   │       │   │   ├─ build_llm_config()
│   │       │   │   └─ generate_assistant_content() [Claude API]
│   │       │   └─ _generate_fallback_summary() [fallback]
│   │       │
│   │       ├── screenshot.py
│   │       │   └── html_to_png() [generates PNG attachment]
│   │       │
│   │       └── generators/
│   │           ├── __init__.py
│   │           ├── daily.py
│   │           │   └── collect_daily_report_data()
│   │           ├── weekly.py
│   │           │   └── collect_weekly_report_data()
│   │           └── monthly.py
│   │               └── collect_monthly_report_data()
│   │
│   ├── core/
│   │   └── scheduler.py
│   │       ├── init_scheduler() ← STARTUP HOOK
│   │       ├── shutdown_scheduler() ← SHUTDOWN HOOK
│   │       ├── get_scheduler() [used by insight_schedule_service]
│   │       └── _scheduler: BackgroundScheduler (APScheduler)
│   │
│   └── main.py
│       ├── @app.on_event('startup')
│       │   └─ init_scheduler() ← CALLED HERE
│       └── @app.on_event('shutdown')
│           └─ shutdown_scheduler() ← CALLED HERE
│
└── worker/
    ├── tasks.py [run_job framework - NOT USED FOR REPORTS YET]
    ├── runner.py [disabled, jobs run in-process]
    └── oneoff_runner.py [manual job runner via CLI]
```

---

## Call Graphs

### Manual Trigger (Current: Test Email)
```
POST /api/v1/scheduled-reports/test-email
  ├─ subscription_service.get_active_subscriptions() [NOT USED]
  ├─ report_builder.build_report_email_data()
  │  ├─ _get_report_anchor_date()
  │  ├─ dashboard_overview_service.build_dashboard_overview()
  │  ├─ _query_top_skus()
  │  ├─ _query_inventory_alerts()
  │  ├─ _query_top_return_reasons()
  │  └─ ai_enhancer.generate_ai_summary()
  │     ├─ llm.resolve_available_models()
  │     ├─ llm.build_llm_config()
  │     └─ llm.generate_assistant_content() [Claude API call]
  │
  ├─ email_sender.send_scheduled_report_email()
  │  ├─ _render_daily_report_html() [builds 680px-wide email template]
  │  ├─ screenshot.html_to_png() [optional, fails gracefully]
  │  └─ resend.Emails.send()
  │
  ├─ subscription_service.create_delivery_log()
  ├─ subscription_service.mark_delivery_success() OR mark_delivery_failed()
  │
  └─ Response: {success, message, resend_id}
```

### Missing: Automated Dispatch (To Be Implemented)
```
[CRON TRIGGER: Daily 15:00 UTC]
  ├─ scheduler.add_job() ← needs to be registered in init_scheduler()
  │
  ├─ dispatch_scheduled_reports(frequency="daily")
  │  ├─ subscription_service.get_active_subscriptions(db, "daily")
  │  │  └─ Return 50-500 ScheduledReportSubscription rows
  │  │
  │  ├─ FOR EACH subscription (in batches):
  │  │  ├─ subscription_service.create_delivery_log()
  │  │  ├─ report_builder.build_report_email_data()
  │  │  ├─ email_sender.send_scheduled_report_email()
  │  │  ├─ subscription_service.mark_delivery_success/failed()
  │  │  └─ [log results]
  │  │
  │  └─ [retry failed deliveries with exponential backoff]
  │
  └─ Log summary: "Dispatched 150 daily reports, 3 failed"
```

---

## Data Models

### ScheduledReportSubscription
```python
Table: scheduled_report_subscriptions

Columns:
  id (PK)
  user_id (FK) - optional, for multi-tenant
  email (256 chars) - recipient email
  project_ids (500 chars) - CSV or "*" for all
  country (10 chars) - e.g., "US", "GB"
  frequency (20 chars) - "daily", "weekly", "monthly"
  enabled (bool) - default True
  created_at (timestamp)
  updated_at (timestamp)

Relations:
  delivery_logs: one-to-many ScheduledReportDeliveryLog

Properties:
  project_id_list: list[int] - parsed from project_ids string
```

### ScheduledReportDeliveryLog
```python
Table: scheduled_report_delivery_logs

Columns:
  id (PK)
  subscription_id (FK)
  frequency (20 chars)
  report_date (20 chars) - ISO format, e.g., "2026-05-22"
  report_month (10 chars, nullable) - e.g., "2026-05"
  email (256 chars)
  status (20 chars) - DeliveryStatus enum: "pending", "sent", "failed"
  error_message (text, nullable)
  sent_at (timestamp, nullable)
  created_at (timestamp)

Relations:
  subscription: many-to-one ScheduledReportSubscription
```

---

## Key Functions Quick Reference

### Subscription Management
```python
# Fetch
get_active_subscriptions(db, frequency: str) → list[ScheduledReportSubscription]
get_subscriptions_by_user(db, user_id, frequency=None, enabled_only=False)
get_delivery_logs(db, user_id=None, subscription_id=None, status=None, limit=50, offset=0)

# Create/Update
create_subscription(db, user_id, data: SubscriptionCreate)
update_subscription(db, subscription_id, data: SubscriptionUpdate)
delete_subscription(db, subscription_id) → bool

# Delivery tracking
create_delivery_log(db, subscription_id, frequency, report_date, report_month, email)
mark_delivery_success(db, log_id, resend_id=None)
mark_delivery_failed(db, log_id, error_message: str)
```

### Report Generation
```python
# Main entry point
build_report_email_data(db, project_ids: list[int] | None, country: str, frequency: str)
  → dict[str, Any]  # With keys: sales, week_sales, trend_days, top_skus, inventory, 
                    # alert_rows, ads, returns, ai_summary, project_name, country, 
                    # report_date, date_range

# Queries
_query_top_skus(db, project_ids, country, start_date, end_date, limit=5)
_query_inventory_alerts(db, project_ids, country) → (oos_list, low_stock_list)
_query_top_return_reasons(db, project_ids, country, start_date, end_date)
_get_report_anchor_date(country: str) → date  # Timezone-aware
```

### Email Sending
```python
# Main entry point
send_scheduled_report_email(email: str, frequency: str, report_data: dict) 
  → (success: bool, resend_id_or_error: str | None)

# Test email
send_test_report_email(email: str, frequency: str)
  → (success: bool, resend_id_or_error: str | None)

# HTML rendering
_render_daily_report_html(report_data: dict[str, Any]) → str  # 27KB+ HTML email
```

### AI Summary
```python
generate_ai_summary(frequency: str, report_data: dict[str, Any]) → str
  # Calls Claude API, returns 150-200 char summary
  # Falls back to basic text if AI unavailable

_generate_fallback_summary(frequency: str, report_data: dict[str, Any]) → str
```

---

## Environment Variables Required

```bash
# Email sending
RESEND_API_KEY=re_xxxxx

# From address
ALERT_FROM_EMAIL=reports@believeboy.com

# AI LLM
AI_CHAT_PROVIDER_API_KEY=sk-proj-xxxxx
AI_CHAT_PROVIDER=openai|anthropic|etc
AI_CHAT_MODEL=gpt-4|claude-3-5-sonnet|etc

# Database
DATABASE_URL=postgresql://user:pass@localhost/believeboy

# App
FRONTEND_URL=https://dash.believeboy.com
```

---

## API Contract

### POST /api/v1/scheduled-reports/test-email
**Request:**
```json
{
  "email": "user@example.com",
  "frequency": "daily|weekly|monthly",
  "project_ids": "*|1,2,3",
  "country": "US"
}
```

**Response:**
```json
{
  "success": true,
  "message": "测试报告已发送到 user@example.com（含真实数据）",
  "resend_id": "20240520-xxx"
}
```

### GET /api/v1/scheduled-reports/subscriptions
**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "user_id": null,
      "email": "user@example.com",
      "project_ids": "*",
      "country": "US",
      "frequency": "daily",
      "enabled": true,
      "created_at": "2026-05-22T12:00:00Z",
      "updated_at": "2026-05-22T12:00:00Z"
    }
  ],
  "total": 1
}
```

### GET /api/v1/scheduled-reports/delivery-logs
**Response:**
```json
{
  "items": [
    {
      "id": 1,
      "subscription_id": 1,
      "frequency": "daily",
      "report_date": "2026-05-22",
      "report_month": null,
      "email": "user@example.com",
      "status": "sent|pending|failed",
      "error_message": null,
      "sent_at": "2026-05-22T15:00:30Z",
      "created_at": "2026-05-22T15:00:00Z"
    }
  ],
  "total": 1
}
```

---

## Scheduler Integration Points

### Current (Insight Schedules Only)
```python
# app/core/scheduler.py
def init_scheduler():
    _scheduler = BackgroundScheduler()
    _scheduler.start()
    
    # Load insight schedules
    from app.services.insight_schedule_service import reload_insight_schedules
    reload_insight_schedules()  # Registers cron jobs for insights
    
    # TODO: Register scheduled report jobs here

def shutdown_scheduler():
    _scheduler.shutdown(wait=False)
```

### What's Needed
```python
# app/core/scheduler.py
def init_scheduler():
    _scheduler = BackgroundScheduler()
    _scheduler.start()
    
    # Load insight schedules
    reload_insight_schedules()
    
    # Load scheduled report jobs ← ADD THIS
    from app.services.scheduled_report.dispatcher import register_scheduled_report_jobs
    register_scheduled_report_jobs(_scheduler)
```

### New Service to Create
```python
# app/services/scheduled_report/dispatcher.py
def register_scheduled_report_jobs(scheduler):
    """Register daily, weekly, monthly report dispatch jobs."""
    from apscheduler.triggers.cron import CronTrigger
    
    scheduler.add_job(
        dispatch_daily_reports,
        CronTrigger(hour=15, minute=0),  # 15:00 UTC daily
        id='dispatch-daily-reports',
        name='Dispatch Daily Reports'
    )
    
    scheduler.add_job(
        dispatch_weekly_reports,
        CronTrigger(day_of_week=0, hour=10, minute=0),  # Monday 10:00 UTC
        id='dispatch-weekly-reports',
        name='Dispatch Weekly Reports'
    )
    
    scheduler.add_job(
        dispatch_monthly_reports,
        CronTrigger(day=1, hour=9, minute=0),  # 1st of month 09:00 UTC
        id='dispatch-monthly-reports',
        name='Dispatch Monthly Reports'
    )

def dispatch_daily_reports():
    """Fetch daily subscriptions, build/send reports."""
    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, "daily")
        # ... batch process, logging, etc.
    finally:
        db.close()
```

---

## Testing Quick Reference

### Manual Test (via cURL)
```bash
curl -X POST http://localhost:8000/api/v1/scheduled-reports/test-email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "email": "test@example.com",
    "frequency": "daily",
    "project_ids": "*",
    "country": "US"
  }'
```

### Database Queries
```sql
-- Check subscriptions
SELECT * FROM scheduled_report_subscriptions WHERE enabled = true;

-- Check delivery history
SELECT * FROM scheduled_report_delivery_logs ORDER BY created_at DESC LIMIT 10;

-- Successful deliveries today
SELECT COUNT(*) FROM scheduled_report_delivery_logs 
WHERE status = 'sent' AND DATE(created_at) = CURRENT_DATE;

-- Failed deliveries
SELECT * FROM scheduled_report_delivery_logs 
WHERE status = 'failed' ORDER BY created_at DESC;
```

---

## Performance Considerations

### Database Queries
- `get_active_subscriptions()`: O(n) where n = total active subscriptions
- `build_report_email_data()`: ~5-7 DB queries (suboptimal, could use single join)
- Recommendation: Add caching layer for common queries (project metadata, SKU data)

### Email Sending
- Resend API: ~500ms per email (network latency + processing)
- For 100 subscriptions: 50+ seconds sequential
- Recommendation: Batch with threading or async queue

### AI Summary Generation
- Claude API: ~2-5s per call (depends on model, prompt length)
- Blocks report generation for each subscription
- Recommendation: Cache summaries for identical project_ids/date combos

### HTML Rendering
- `_render_daily_report_html()`: Fast (<10ms), no I/O
- Screenshot generation (`html_to_png()`): Slow (10-30s per image if using Puppeteer)
- Recommendation: Make screenshot optional, run async if needed

---

## Known Issues & TODOs

1. **No automated dispatch** - all sending is manual via API
2. **No retry mechanism** - failed sends not automatically retried
3. **No rate limiting** - could hammer Resend API if many subscriptions
4. **No caching** - AI summary recalculated for every subscription
5. **No filtering** - timezone not considered for report dates
6. **No monitoring** - no metrics on dispatch success/failure
7. **Generators unused** - `generators/*.py` files not used (would be for weekly/monthly specifics)
8. **Screenshot optional** - fails silently, might be confusing

