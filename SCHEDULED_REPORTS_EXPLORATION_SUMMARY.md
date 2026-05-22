# Scheduled Reports System - Complete Exploration Summary

**Date:** May 22, 2026  
**Project:** BelieveBoy Dashboard  
**Scope:** Comprehensive search for scheduled report email dispatch system

---

## What We Found

### ✅ Fully Implemented (Ready to Use)

1. **Subscription Management (CRUD)**
   - `backend/app/services/scheduled_report/subscription_service.py`
   - Users can create/read/update/delete report subscriptions
   - API endpoints in `backend/app/api/v1/endpoints/scheduled_reports.py`
   - Database models: `ScheduledReportSubscription`, `ScheduledReportDeliveryLog`

2. **Report Data Aggregation**
   - `backend/app/services/scheduled_report/report_builder.py`
   - Queries sales, inventory, ads, returns from database
   - Timezone-aware report dates (handles cross-timezone reporting)
   - Top SKUs, OOS alerts, return reasons
   - ~1500 lines of data collection logic

3. **Email Rendering & Sending**
   - `backend/app/services/scheduled_report/email_sender.py`
   - Beautiful responsive HTML email templates (~27KB)
   - Markdown-to-HTML conversion with email-client styling
   - Optional PNG screenshot attachments
   - Sends via Resend API (configured via `RESEND_API_KEY`)

4. **AI-Powered Summaries**
   - `backend/app/services/scheduled_report/ai_enhancer.py`
   - Calls Claude API (or OpenAI) to generate 150-200 char summaries
   - Fallback to basic text if AI unavailable
   - System prompt configured for e-commerce ops experts

5. **Delivery Logging & Tracking**
   - `create_delivery_log()` - track each send attempt
   - `mark_delivery_success()` - log successful sends with Resend ID
   - `mark_delivery_failed()` - log failures with error message
   - `get_delivery_logs()` - query delivery history

6. **APScheduler Framework**
   - `backend/app/core/scheduler.py` - BackgroundScheduler initialized
   - `backend/app/main.py` - scheduler starts on app startup
   - Currently only used for insight schedules (not reports)

### 🚫 Missing (Not Implemented)

1. **Automated Dispatch Service**
   - No code that automatically sends reports at scheduled times
   - No function that loops through subscriptions
   - Manual trigger only: `POST /api/v1/scheduled-reports/test-email`

2. **Cron Job Registration**
   - No cron jobs registered for daily/weekly/monthly dispatch
   - `init_scheduler()` doesn't register report jobs
   - Schedule times not configured (15:00 daily? 10:00 Monday? 9:00 1st?)

3. **Concurrency Control / Rate Limiting**
   - No batch processing of emails
   - No rate limiting (Resend API has limits)
   - No throttling between sends
   - If 500 subscriptions, all 500 would queue at once

4. **Retry Logic**
   - Failed deliveries logged but never retried
   - No exponential backoff mechanism
   - No retry queue table

5. **AI Summary Caching**
   - Each report rebuilds AI summary (100 reports = 100 Claude calls)
   - No caching by (project_ids, report_date, frequency)
   - Wastes API calls and costs

6. **Timezone-Aware Scheduling**
   - Reports dispatch at UTC times (15:00, 10:00, 09:00 UTC)
   - Users in different timezones can't control local dispatch time
   - No per-user timezone storage

7. **Monitoring & Alerting**
   - No metrics collection
   - No success rate tracking
   - No failure alerting
   - No visibility into batch completion

---

## Architecture Overview

```
┌──────────────────────────────────────────────┐
│     Scheduled Reports System (Partial)       │
├──────────────────────────────────────────────┤
│                                              │
│  API Layer                                   │
│  ├─ GET  /subscriptions      ✅             │
│  ├─ POST /subscriptions      ✅             │
│  ├─ PUT  /subscriptions/{id} ✅             │
│  ├─ DELETE /subscriptions/{id} ✅           │
│  ├─ GET  /delivery-logs      ✅             │
│  └─ POST /test-email         ✅ [MANUAL]    │
│                                              │
│  Services Layer                              │
│  ├─ subscription_service.py  ✅ [CRUD]      │
│  ├─ report_builder.py        ✅ [DATA]      │
│  ├─ email_sender.py          ✅ [SENDING]   │
│  ├─ ai_enhancer.py           ✅ [AI]        │
│  └─ dispatcher.py            🚫 [MISSING]   │
│                                              │
│  Scheduler                                   │
│  ├─ init_scheduler()         ✅ [STARTED]   │
│  ├─ add_job() for daily      🚫 [MISSING]   │
│  ├─ add_job() for weekly     🚫 [MISSING]   │
│  └─ add_job() for monthly    🚫 [MISSING]   │
│                                              │
│  Database                                    │
│  ├─ ScheduledReportSubscription ✅          │
│  ├─ ScheduledReportDeliveryLog  ✅          │
│  └─ ScheduledReportRetryQueue   🚫 [TODO]   │
│                                              │
└──────────────────────────────────────────────┘
```

---

## Key Functions Reference

### Core Functions (Working)
```
✅ get_active_subscriptions(db, frequency) → subscriptions
✅ build_report_email_data(db, project_ids, country, frequency) → dict
✅ send_scheduled_report_email(email, frequency, report_data) → (success, resend_id)
✅ create_delivery_log(db, subscription_id, ...) → log
✅ mark_delivery_success(db, log_id, resend_id)
✅ mark_delivery_failed(db, log_id, error_message)
✅ generate_ai_summary(frequency, report_data) → str

🚫 dispatch_daily_reports() → MISSING
🚫 dispatch_weekly_reports() → MISSING
🚫 dispatch_monthly_reports() → MISSING
```

### Query Helpers (Working)
```
✅ _query_top_skus() - top 5 SKUs by sales
✅ _query_inventory_alerts() - OOS and low-stock items
✅ _query_top_return_reasons() - top 3 return reasons
✅ _get_report_anchor_date() - timezone-aware date
```

---

## How It Currently Works (Manual Flow)

```
1. Admin calls: POST /api/v1/scheduled-reports/test-email
2. API endpoint calls: build_report_email_data()
3. Data aggregated from database
4. AI summary generated (Claude API)
5. HTML email rendered
6. Email sent via Resend
7. Delivery log created/updated
8. Response: {success: true, resend_id: "..."}

🚫 No automatic scheduling - requires manual API call
```

---

## What Needs to Be Built (Priority Order)

### Phase 1: MVP (Make it Automated)
**Effort:** 4-5 hours  
**What:** Get daily reports dispatching automatically

1. **Create dispatcher service** (`dispatcher.py`)
   - `dispatch_daily_reports()` - loop through subscriptions, send emails
   - `dispatch_weekly_reports()` - same for weekly
   - `dispatch_monthly_reports()` - same for monthly
   - Error handling & stats tracking

2. **Register cron jobs** in `init_scheduler()`
   - Daily @ 15:00 UTC → dispatch_daily_reports()
   - Weekly @ 10:00 UTC Monday → dispatch_weekly_reports()
   - Monthly @ 09:00 UTC 1st → dispatch_monthly_reports()

### Phase 2: Reliability (Make it Robust)
**Effort:** 4-6 hours  
**What:** Handle failures, rate limiting, retries

1. **Add rate limiting** - batch processing with delays
2. **Add retry logic** - exponential backoff for failures
3. **Add monitoring** - metrics, logging, alerting
4. **Load testing** - test with 100+ subscriptions

### Phase 3: Optimization
**Effort:** 2-3 hours  
**What:** Improve performance and user experience

1. **Cache AI summaries** - reuse for identical project/date
2. **Timezone support** - let users choose local dispatch times
3. **Scheduling flexibility** - admin UI to change dispatch times

---

## File Locations (Complete Map)

### API Endpoints
- `backend/app/api/v1/endpoints/scheduled_reports.py` - 6 routes

### Services (Fully Functional)
- `backend/app/services/scheduled_report/subscription_service.py` - CRUD
- `backend/app/services/scheduled_report/report_builder.py` - data aggregation
- `backend/app/services/scheduled_report/email_sender.py` - email sending
- `backend/app/services/scheduled_report/ai_enhancer.py` - AI summaries
- `backend/app/services/scheduled_report/screenshot.py` - PNG generation
- `backend/app/services/scheduled_report/generators/` - report-specific logic (unused)

### Models
- `backend/app/models/scheduled_report.py` - subscription, delivery log

### Scheduler
- `backend/app/core/scheduler.py` - APScheduler init/shutdown
- `backend/app/main.py` - calls init_scheduler()

### Configuration
- `backend/.env` - RESEND_API_KEY, AI_CHAT_PROVIDER_API_KEY

---

## Database Schema

### ScheduledReportSubscription
```
id (PK), user_id (nullable), email, project_ids, country, 
frequency, enabled, created_at, updated_at
```

### ScheduledReportDeliveryLog
```
id (PK), subscription_id (FK), frequency, report_date, report_month, 
email, status (PENDING/SENT/FAILED), error_message, sent_at, created_at
```

---

## Configuration Requirements

```env
# Email sending
RESEND_API_KEY=re_xxxxx
ALERT_FROM_EMAIL=reports@believeboy.com

# AI (optional, falls back to basic text)
AI_CHAT_PROVIDER_API_KEY=sk-xxxxx
AI_CHAT_PROVIDER=openai|anthropic
AI_CHAT_MODEL=gpt-4|claude-3-sonnet

# Database
DATABASE_URL=postgresql://...

# Frontend (for email CTA links)
FRONTEND_URL=https://dash.believeboy.com
```

---

## Performance Notes

### Database Queries
- `get_active_subscriptions()`: Fast (indexed on frequency, enabled)
- `build_report_email_data()`: ~5-7 queries, could be optimized with joins
- Recommendation: Add caching for common queries

### Email Sending
- Resend API: ~500ms per email (network + processing)
- For 100 subscriptions: 50+ seconds sequential
- Recommendation: Batch with 50ms delays between batches

### AI Summary Generation
- Claude API: 2-5 seconds per call
- For 100 subscriptions: 200-500 seconds if sequential
- Recommendation: Cache by (project_ids, report_date, frequency)

### HTML Rendering
- `_render_daily_report_html()`: <10ms (fast, no I/O)
- Screenshot generation: 10-30s (slow if using Puppeteer)

---

## Alert Dispatcher Reference

The codebase has a similar pattern implemented for **Alert Dispatcher** that can serve as inspiration:

- `backend/app/services/alert/dispatcher.py`
- `dispatch_alert()` - single dispatch
- `dispatch_batch()` - batch dispatch with grouping
- Shows patterns for: filtering recipients, checking preferences, sending, logging

---

## Testing Checklist

### Manual Testing
```bash
# Test email sending
curl -X POST http://localhost:8000/api/v1/scheduled-reports/test-email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "frequency": "daily",
    "project_ids": "*",
    "country": "US"
  }'

# Check subscription creation
curl -X GET http://localhost:8000/api/v1/scheduled-reports/subscriptions

# Check delivery logs
curl -X GET http://localhost:8000/api/v1/scheduled-reports/delivery-logs
```

### Database Validation
```sql
-- Check subscriptions
SELECT COUNT(*) FROM scheduled_report_subscriptions WHERE enabled=true;

-- Check recent deliveries
SELECT * FROM scheduled_report_delivery_logs ORDER BY created_at DESC LIMIT 10;

-- Delivery success rate
SELECT 
  status, 
  COUNT(*) as count
FROM scheduled_report_delivery_logs
WHERE DATE(created_at) = CURRENT_DATE
GROUP BY status;
```

---

## Known Issues & Limitations

1. **No automated dispatch** - all sending manual
2. **No rate limiting** - could overload Resend API
3. **No retry mechanism** - failed emails lost
4. **No AI caching** - wasteful API calls
5. **No timezone flexibility** - UTC times only
6. **No metrics** - no visibility into dispatch health
7. **Generators unused** - `generators/*.py` files never called
8. **Screenshot optional** - fails silently

---

## Estimated Implementation Time

| Component | Hours | Difficulty |
|-----------|-------|------------|
| Dispatcher service | 2-3 | Low |
| Cron job registration | 1 | Low |
| Rate limiting | 1-2 | Medium |
| Retry logic | 2-3 | Medium |
| AI caching | 1-2 | Low |
| Monitoring | 1-2 | Low |
| Timezone support | 1-2 | Medium |
| Tests & docs | 2-3 | Low |
| **Total** | **11-18** | - |

---

## Documentation Delivered

You now have three detailed docs:

1. **SCHEDULED_REPORTS_ARCHITECTURE.md** - System overview, data flows, components
2. **SCHEDULED_REPORTS_CODE_MAP.md** - File structure, call graphs, functions, API contracts
3. **IMPLEMENTATION_GAPS.md** - Detailed gaps with code examples and solutions

---

## Next Steps

1. **If you want to implement automated dispatch:** Start with Phase 1 (dispatcher service + cron jobs)
2. **If you want to understand the system better:** Read SCHEDULED_REPORTS_ARCHITECTURE.md
3. **If you need to modify specific functions:** Refer to SCHEDULED_REPORTS_CODE_MAP.md

All the building blocks are in place. You just need to wire up the automation layer.
