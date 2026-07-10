"""Celery tasks for the SCHEDULED report dispatch (BEL-NEW).

Task `dispatch_one` is the body that used to live inside the API process's
`ThreadPoolExecutor.submit(_dispatch_one, ...)` path. Moving it onto the
`scheduled` Celery queue lets us:

- Persist in-flight messages on the broker (`acks_late=True`) so an API
  restart does not drop reports mid-flight.
- Run screenshots / SMTP / LLM work on a dedicated `scheduled` worker
  process, isolated from the `reports` worker that handles monthly-report
  uploads — OOM in scheduled work no longer kills the monthly pipeline.
- Apply Celery retry / time-limit semantics uniformly.

Implementation contract (see `app/celery_tasks/_common.py` style):

- Task body reuses the shared `_dispatch_one_task_body` from
  `app.services.scheduled_report.dispatcher` so the legacy `_dispatch_one`
  path and the new Celery path stay byte-for-byte identical inside the
  business logic.
- Module-global state (`_dispatch_date_str` / `_summary_cache`) is
  synchronised at task entry using the *passed-in* `report_date` per
  §4.1 P0-1 — never call `date.today()` inside the task body.
- P0-2 / P0-3 idempotency: even before the task body runs, we check the
  unique-tuple `(subscription_id, frequency, report_date, triggered_by)`
  for an existing `sent_at`; if present we short-circuit and return. The
  in-body row-lock + `INSERT ... ON CONFLICT` is the belt-and-suspenders
  for the row-level race window.
- Soft time limit + hard time limit calibrated to the §4.8 P50/P90/P99
  data (`300s / 420s` for the dispatch body, `120s / 240s` for AI
  summary). Monthly max observed 105s, daily max 228s — the bounds leave
  ~70% buffer over P99.
"""

from __future__ import annotations

import logging
from datetime import datetime

from celery import shared_task

from app.db.session import SessionLocal
from app.models.scheduled_report import ScheduledReportDeliveryLog

logger = logging.getLogger(__name__)


TASK_NAME = "dispatch_one"
AUTO_TRIGGERED = "auto"


def _sync_module_global_report_date(report_date: str) -> None:
    """Force `dispatcher._dispatch_date_str` to track `report_date` (P0-1).

    `dispatcher.py` keeps `_dispatch_date_str` / `_summary_cache` as module
    globals for cache reuse across subscriptions on the same day. With a
    Celery worker process we must never call `date.today()` inside the task
    body — every cache decision must be anchored to the `report_date` the
    caller passed in (computed at the trigger moment).
    """
    # Lazy import to avoid circular dep with `app.services.scheduled_report`.
    from app.services.scheduled_report.dispatcher import (
        _cache_lock,
        _dispatch_date_str,
        _summary_cache,
    )

    today_str = report_date  # alias for clarity; report_date is always YYYY-MM-DD

    if _dispatch_date_str != today_str:
        with _cache_lock:
            _summary_cache.clear()
        # `dispatcher` declares `global _dispatch_date_str` at the top of
        # `_dispatch_one`. We re-bind via the same module global so both
        # code paths observe the same value.
        from app.services.scheduled_report import dispatcher as _dispatcher_mod

        _dispatcher_mod._dispatch_date_str = today_str


def _return_if_already_sent(
    subscription_id: int,
    frequency: str,
    report_date: str,
    triggered_by: str,
) -> int | None:
    """P0-2/P0-3 fast path: check the unique tuple for an existing successful log.

    Returns the existing log id if the row was already sent, else ``None``.
    This is the optimistic short-circuit — the real race window is closed
    by the `INSERT ... ON CONFLICT DO NOTHING` + `SELECT ... FOR UPDATE`
    inside `_dispatch_one_task_body`'s row creation path.

    Note: this function does not raise if the log exists with a different
    status (e.g. `superseded`, `failed`); only `sent` rows trigger the
    short-circuit. Failed/superseded rows proceed through normal dispatch
    so retries / re-issuing are not silently dropped.
    """
    db = SessionLocal()
    try:
        from app.models.scheduled_report import DeliveryStatus

        log = (
            db.query(ScheduledReportDeliveryLog)
            .filter(
                ScheduledReportDeliveryLog.subscription_id == subscription_id,
                ScheduledReportDeliveryLog.frequency == frequency,
                ScheduledReportDeliveryLog.report_date == report_date,
                ScheduledReportDeliveryLog.triggered_by == triggered_by,
                ScheduledReportDeliveryLog.sent_at.isnot(None),
                ScheduledReportDeliveryLog.status == DeliveryStatus.SENT.value,
            )
            .first()
        )
        return log.id if log else None
    finally:
        db.close()


@shared_task(
    name=TASK_NAME,
    bind=True,
    acks_late=True,
    max_retries=3,
    soft_time_limit=300,  # §4.8 P99 ~= 185s; +63% buffer for slow Playwright runs
    time_limit=420,  # hard kill at 7min — anything beyond should be a bug, not a normal run
)
def dispatch_one(
    self,
    subscription_id: int,
    email: str,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
    use_cache: bool = True,
    triggered_by: str = AUTO_TRIGGERED,
    report_date: str | None = None,
) -> dict[str, Any]:  # noqa: F821 — local dict ok
    """Celery entry for the report dispatch body.

    Args mirror `_dispatch_one_task_body` plus the `report_date` injection
    (P0-1 P0-3). `triggered_by` defaults to ``"auto"`` since APScheduler is
    the primary caller; manual override is plumbed for the resend API.

    See `tests/tasks/test_scheduled_report_celery.py` for the behaviour
    contract.
    """
    from typing import Any  # local import — keep at top of function for typing

    # 1. Resolve report_date — required for downstream consistency.
    if not report_date:
        # Fall back to today (only happens in the manual / resend path which
        # historically didn't pass it; mark as such for observability).
        report_date = datetime.utcnow().date().isoformat()
        logger.warning(
            "dispatch_one task invoked without report_date; "
            "falling back to today=%s (expected only for manual resend)",
            report_date,
        )

    # 2. Module-global anchor (§4.1 P0-1): pin cache to the trigger date.
    _sync_module_global_report_date(report_date)

    # 3. Fast-path idempotency check (§4.2 P0-2 + §4.9 P0-3). If a previous
    #    run already completed, return immediately — broker redelivery, an
    #    API restart mid-flight, etc. should NEVER re-send the email.
    existing_id = _return_if_already_sent(
        subscription_id=subscription_id,
        frequency=frequency,
        report_date=report_date,
        triggered_by=triggered_by,
    )
    if existing_id is not None:
        logger.info(
            "dispatch_one short-circuit: sub=%d freq=%s date=%s triggered_by=%s "
            "already sent (log_id=%d)",
            subscription_id, frequency, report_date, triggered_by, existing_id,
        )
        return {
            "status": "skipped_already_sent",
            "subscription_id": subscription_id,
            "log_id": existing_id,
        }

    # 4. Delegate to the shared body (manual_log check + business main + ai spawn).
    from app.services.scheduled_report.dispatcher import _dispatch_one_task_body

    return _dispatch_one_task_body(
        subscription_id=subscription_id,
        email=email,
        project_ids=project_ids,
        country=country,
        frequency=frequency,
        ai_model=ai_model,
        use_cache=use_cache,
        triggered_by=triggered_by,
        report_date=report_date,
    )
