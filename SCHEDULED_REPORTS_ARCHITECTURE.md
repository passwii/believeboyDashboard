# Scheduled Reports Email Dispatch System - Architecture Overview

## Executive Summary

The BelieveBoy Dashboard has a **subscription-based scheduled report system** that sends email reports to users at different frequencies (daily, weekly, monthly). The system is **currently set up for manual/API triggering** via the test-email endpoint, but **lacks an automated scheduler** to dispatch reports at configured intervals. The infrastructure is ready for implementation.

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Scheduled Reports System                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Frontend/API Requests                                            │
│         ↓                                                         │
│  [Scheduled Reports API Endpoints]                               │
│  └─ POST /api/v1/scheduled-reports/test-email (manual trigger)  │
│  └─ GET  /api/v1/scheduled-reports/subscriptions                │
│  └─ POST /api/v1/scheduled-reports/subscriptions (CRUD)         │
│  └─ GET  /api/v1/scheduled-reports/delivery-logs                │
│         ↓                                                         │
│  [Report Data Builder]                                           │
│  ├─ build_report_email_data()                                    │
│  ├─ Queries dashboard KPIs, sales, inventory, ads, returns       │
│  └─ Generates AI summary via LLM                                 │
│         ↓                                                         │
│  [Email Sender]                                                  │
│  ├─ send_scheduled_report_email() via Resend API                │
│  ├─ HTML rendering (_render_daily_report_html)                   │
│  └─ Optional screenshot attachment generation                    │
│         ↓                                                         │
│  [Subscription & Delivery Tracking]                              │
│  ├─ get_active_subscriptions() - fetch enabled subs              │
│  ├─ create_delivery_log() - track each send attempt              │
│  ├─ mark_delivery_success() - log successful delivery            │
│  └─ mark_delivery_failed() - log failures with error message     │
│         ↓                                                         │
│  Database Models                                                 │
│  ├─ ScheduledReportSubscription (subscriptions table)            │
│  └─ ScheduledReportDeliveryLog (delivery_logs table)             │
│                                                                   │
│  🚫 MISSING: Automated Scheduler/Dispatcher                       │
│     (APScheduler is initialized but only for insight schedules)  │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. File Structure & Components

### 2.1 API Endpoints
**Location:** `backend/app/api/v1/endpoints/scheduled_reports.py`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/scheduled-reports/subscriptions` | GET | List user subscriptions |
| `/scheduled-reports/subscriptions` | POST | Create new subscription |
| `/scheduled-reports/subscriptions/{id}` | PUT | Update subscription |
| `/scheduled-reports/subscriptions/{id}` | DELETE | Delete subscription |
| `/scheduled-reports/delivery-logs` | GET | Fetch delivery history |
| `/scheduled-reports/test-email` | POST | **Manual trigger** - sends test email with real data |

**Key function in test-email endpoint:**
```python
def test_email(...):
    # Parse project_ids from request
    report_data = build_report_email_data(db, project_ids, country, frequency)
    success, error = send_scheduled_report_email(email, frequency, report_data)
    return TestEmailResponse(success, message, resend_id)
```

### 2.2 Report Data Builder
**Location:** `backend/app/services/scheduled_report/report_builder.py`

**Main function:** `build_report_email_data(db, project_ids, country, frequency)`

**Purpose:** Aggregates real-time data from the dashboard for email rendering

**Data collected:**
- Sales metrics (yesterday qty/amount, prev day comparison, 7-day trend)
- Top 5 SKUs by sales (7-day window)
- Inventory status (SKU count, OOS, low stock alerts)
- Ads metrics (spend, ROAS, ACOS, CTR)
- Returns analysis (qty, rate, top reasons)
- **AI Summary** (via `ai_enhancer.generate_ai_summary()`)
- Date range and project metadata

**Query helpers:**
- `_query_top_skus()` - Group sales by SKU, limit to top 5
- `_query_inventory_alerts()` - Find OOS and low-stock SKUs
- `_query_top_return_reasons()` - Top 3 return reasons with counts
- `_get_report_anchor_date()` - Determines correct date for cross-timezone reporting

**AI Summary Generation:**
- **Default:** Calls Claude API with system prompt for report analysis
- **Fallback:** Basic text summary if AI unavailable
- Configured via `AI_CHAT_PROVIDER_API_KEY` (e.g., OpenAI, Anthropic)

### 2.3 Email Sender
**Location:** `backend/app/services/scheduled_report/email_sender.py`

**Main function:** `send_scheduled_report_email(email, frequency, report_data) → (success, resend_id_or_error)`

**Features:**
- Sends via **Resend API** (requires `RESEND_API_KEY` in settings)
- HTML rendering: `_render_daily_report_html(report_data)` - responsive email template
- Markdown-to-HTML conversion with inline styles for email clients (Gmail, Outlook)
- Optional PNG screenshot attachment (via `html_to_png()`)
- Fallback rendering if markdown parser unavailable

**Email template includes:**
- Header with project name, country, report date
- AI summary in info box
- 2×2 metric cards (today sales qty, sales amount, 7-day qty, 7-day amount)
- 7-day trend bar chart
- Inventory status (SKU count, OOS, low stock warnings)
- Ad metrics (spend, ROAS, ACOS, CTR)
- Return analysis with top reasons
- Top 5 hot SKUs table
- Call-to-action button to dashboard

### 2.4 Subscription & Delivery Management
**Location:** `backend/app/services/scheduled_report/subscription_service.py`

**Core functions:**
```python
get_active_subscriptions(db, frequency: str) → list[ScheduledReportSubscription]
    # Returns: all enabled subscriptions for a given frequency
    # Used by: future scheduler to dispatch reports

create_subscription(db, user_id, data: SubscriptionCreate) → ScheduledReportSubscription
update_subscription(db, subscription_id, data: SubscriptionUpdate) → ScheduledReportSubscription
delete_subscription(db, subscription_id) → bool

get_subscriptions_by_user(db, user_id, frequency=None, enabled_only=False) → list

create_delivery_log(db, subscription_id, frequency, report_date, report_month, email)
    # Logs each send attempt with PENDING status

mark_delivery_success(db, log_id, resend_id=None)
    # Updates status to SENT, records sent_at timestamp

mark_delivery_failed(db, log_id, error_message: str)
    # Updates status to FAILED, stores error_message
```

### 2.5 Database Models
**Location:** `backend/app/models/scheduled_report.py`

**ScheduledReportSubscription:**
```python
id: int (PK)
user_id: int | None (optional, for multi-tenant support)
email: str (256 chars)
project_ids: str ("1,2,3" or "*" for all projects)
country: str (e.g., "US", "GB")
frequency: str ("daily", "weekly", "monthly")
enabled: bool (default=True)
created_at: datetime
updated_at: datetime
```

**ScheduledReportDeliveryLog:**
```python
id: int (PK)
subscription_id: int (FK)
frequency: str
report_date: str (ISO format)
report_month: str | None (e.g., "2026-05" for monthly reports)
email: str
status: str ("pending", "sent", "failed") [DeliveryStatus enum]
error_message: str | None
sent_at: datetime | None
created_at: datetime
```

---

## 3. How Scheduled Reports Are Currently Triggered

### Current State: Manual Trigger Only

**Only entry point:** `POST /api/v1/scheduled-reports/test-email`

**Flow:**
1. Frontend/admin calls test-email endpoint with subscription details
2. API builds report data from database (`build_report_email_data`)
3. Sends email via Resend (`send_scheduled_report_email`)
4. Returns success/failure response
5. **No automatic scheduling** - requires manual API call

### What's Missing: Automated Dispatcher

**The infrastructure exists but dispatcher is NOT implemented:**
- ✅ `get_active_subscriptions()` exists to fetch subscriptions by frequency
- ✅ `build_report_email_data()` ready to aggregate data
- ✅ `send_scheduled_report_email()` ready to send
- ✅ Delivery logging via `create_delivery_log()` / `mark_delivery_success/failed()`
- ✅ APScheduler is initialized in `app/core/scheduler.py`
- 🚫 **No service that loops through subscriptions and sends reports**
- 🚫 **No cron jobs registered for daily/weekly/monthly dispatch**
- 🚫 **No background task that monitors and retries failed deliveries**

---

## 4. Concurrency & Rate Limiting

### Current State: No Rate Limiting on Dispatch

**Issues identified:**
1. **No concurrency control** - if a future scheduler dispatches to 1000 subscriptions, all 1000 emails queued at once
2. **No rate limiting** - Resend API has rate limits; no backpressure mechanism
3. **No retry logic** - failed deliveries not automatically retried
4. **No batch queuing** - all subscriptions processed sequentially in a single task

### Email Sending (via Resend):
- **API rate limit:** Resend rate limits vary by plan (typically 1000 req/min for standard)
- **Current:** No throttling in `send_scheduled_report_email()`
- **Recommendation:** Implement queue-based dispatch with configurable batch size and delay

### AI Summary Generation:
- **Concurrency concern:** If 100 daily reports generated simultaneously, 100 LLM calls fired at once
- **No pooling/batching** - each report independently calls Claude API
- **No caching** - same project/date generates unique summaries (could cache for identical project_ids/date)

---

## 5. Key Data Flows

### Flow 1: Building a Report (Test Email)
```
POST /scheduled-reports/test-email (email, frequency, project_ids, country)
  ↓
build_report_email_data()
  ├─ Determine anchor date (handles timezone)
  ├─ Query dashboard overview (sales, inventory, ads, returns)
  ├─ Query top SKUs (7-day grouping)
  ├─ Query inventory alerts (OOS + low stock)
  ├─ Query return reasons (top 3)
  ├─ Generate AI summary (Claude via LLM service)
  └─ Return: {sales, week_sales, trend_days, top_skus, inventory, ads, returns, ai_summary, ...}
  ↓
send_scheduled_report_email(email, frequency, report_data)
  ├─ Render HTML (_render_daily_report_html)
  ├─ Generate screenshot attachment (optional)
  ├─ Call Resend.Emails.send()
  └─ Return: (True, resend_id) or (False, error_message)
  ↓
API response: {success: bool, message: str, resend_id: str}
```

### Flow 2: Subscription Management (CRUD)
```
POST /scheduled-reports/subscriptions (email, frequency, project_ids, country)
  ↓
create_subscription(db, user_id, data)
  ├─ Create ScheduledReportSubscription record
  ├─ Commit to DB
  └─ Return subscription with id, created_at
  ↓
Response: SubscriptionItem
```

### Flow 3: Tracking Deliveries
```
create_delivery_log(db, subscription_id, frequency, report_date, report_month, email)
  ↓
Insert ScheduledReportDeliveryLog with status=PENDING
  ↓
[Email sent]
  ↓
mark_delivery_success(db, log_id, resend_id) OR mark_delivery_failed(db, log_id, error_message)
  ↓
Update status to SENT/FAILED, set sent_at / error_message
```

### Flow 4: Missing - Automated Dispatch (Not Implemented)
```
[Cron: Daily 15:00 UTC] trigger_daily_reports()
  ↓
get_active_subscriptions(db, frequency="daily")
  ├─ Return all enabled subscriptions with frequency="daily"
  └─ Filter by enabled=True
  ↓
FOR EACH subscription:
  ├─ create_delivery_log(subscription_id, "daily", today, None, subscription.email)
  ├─ build_report_email_data(subscription.project_ids, subscription.country, "daily")
  ├─ send_scheduled_report_email(subscription.email, "daily", report_data)
  └─ mark_delivery_success() OR mark_delivery_failed()
  ↓
Log dispatch summary: "Dispatched 150 daily reports, 3 failed, 1 queued for retry"
```

---

## 6. Relevant Source Files Summary

| File | Purpose | Key Functions/Classes |
|------|---------|----------------------|
| `backend/app/api/v1/endpoints/scheduled_reports.py` | API routes | Routes, test_email endpoint |
| `backend/app/services/scheduled_report/subscription_service.py` | Subscription CRUD | get_active_subscriptions, create/update/delete |
| `backend/app/services/scheduled_report/report_builder.py` | Data aggregation | build_report_email_data, _query_top_skus, etc. |
| `backend/app/services/scheduled_report/email_sender.py` | Email sending | send_scheduled_report_email, _render_daily_report_html |
| `backend/app/services/scheduled_report/ai_enhancer.py` | AI summary generation | generate_ai_summary, _generate_fallback_summary |
| `backend/app/models/scheduled_report.py` | Database models | ScheduledReportSubscription, ScheduledReportDeliveryLog |
| `backend/app/core/scheduler.py` | APScheduler init | init_scheduler, shutdown_scheduler (ready for jobs) |
| `backend/app/main.py` | App entry point | Calls init_scheduler() on startup |
| `backend/app/services/alert/dispatcher.py` | Alert dispatch (reference) | Shows batch/single dispatch patterns |
| `backend/worker/tasks.py` | Background job runner | run_job framework (for async dispatch) |

---

## 7. Configuration Requirements

### Environment Variables (in backend/.env)
```
# Email sending
RESEND_API_KEY=re_xxxxx

# Email from address
ALERT_FROM_EMAIL=reports@believeboy.com

# AI summary generation
AI_CHAT_PROVIDER_API_KEY=sk-xxxxx (or other provider key)
AI_CHAT_PROVIDER=openai (or anthropic, etc.)
AI_CHAT_MODEL=gpt-4 (or claude-3-sonnet, etc.)

# Database
DATABASE_URL=postgresql://user:pass@localhost/believeboy

# Frontend URL (for email CTA links)
FRONTEND_URL=https://dash.believeboy.com
```

---

## 8. Next Steps for Implementation

### Missing: Report Dispatch Service
You'll need to create a new service that:

1. **Scheduler trigger (APScheduler)**
   - Register cron jobs: daily @ 15:00, weekly @ 10:00 (Monday), monthly @ 09:00 (1st)
   - OR: manual trigger endpoint for testing

2. **Dispatch runner**
   - Fetch all enabled subscriptions for frequency
   - Group by country (to respect timezone in anchor date)
   - For each subscription: build report → send email → log result
   - Handle failures gracefully (don't fail entire batch)

3. **Concurrency management**
   - Queue subscriptions in batches (e.g., 50 at a time)
   - Add delay between batches to throttle Resend API
   - Retry failed emails with exponential backoff

4. **Monitoring**
   - Log dispatch start/end with counts
   - Track success rate per frequency
   - Alert on batch failures

---

## 9. Alert Dispatcher Reference

For inspiration, the **Alert Dispatcher** (`app/services/alert/dispatcher.py`) shows similar patterns:

```python
dispatch_alert(db, event)  # single dispatch
dispatch_batch(db, events: list)  # batch dispatch with grouping

# Key patterns:
- _get_notification_recipients()  # query for targets
- Filter by preferences (enabled, severity, quiet hours)
- Send to email
- Log results
```

---

## Summary

**Current State:**
- ✅ Subscription management (CRUD) complete
- ✅ Report building from real data complete
- ✅ Email sending via Resend complete
- ✅ Delivery tracking complete
- ✅ APScheduler framework initialized
- 🚫 **Automated dispatch service missing**
- 🚫 **Cron jobs not registered**
- 🚫 **Retry logic missing**
- 🚫 **Concurrency/rate limiting missing**

**To enable automatic scheduled reports, implement:**
1. A dispatcher service (e.g., `scheduled_report_dispatcher.py`)
2. Cron job registration in `init_scheduler()`
3. Batch processing with rate limiting
4. Retry and error handling

**Estimated effort:** 4-6 hours (dispatcher, tests, monitoring)
