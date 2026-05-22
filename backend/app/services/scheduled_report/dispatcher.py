"""Scheduled report dispatcher with AI summary rate limiting.

Dispatches report emails for all active subscriptions of a given frequency.
Uses a threading semaphore to limit concurrent AI API calls (default: 2),
and caches AI summaries by (project_ids, country, date) to avoid duplicate
requests when multiple users subscribe to the same project.

Design notes on the job pipeline:
- ThreadPoolExecutor runs subscription tasks concurrently (max 8 workers)
- Inside each task, _build_report_with_throttle() acquires the AI semaphore
- Semaphore holds while calling generate_ai_summary() — so at most
  AI_CONCURRENCY_LIMIT AI calls run in parallel at any moment
- Same project+country+date combo hits in-process cache, skipping semaphore
- Cache is cleared per dispatch run to keep memory bounded
- AI calls use signal-based timeout (AI_SUMMARY_TIMEOUT_SEC = 90s);
  if exceeded, fallback summary is used and the semaphore slot is released
"""

from __future__ import annotations

import logging
import signal
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from typing import Any

from app.db.session import SessionLocal
from app.services.scheduled_report.email_sender_daily import send_scheduled_report_email
from app.services.scheduled_report.report_builder_daily import build_report_email_data
from app.services.scheduled_report.subscription_service import (
    create_delivery_log,
    get_active_subscriptions,
    mark_delivery_failed,
    mark_delivery_success,
)

logger = logging.getLogger(__name__)

# ── AI concurrency & timeout control ─────────────────────────────────────────
AI_CONCURRENCY_LIMIT = 2
# Timeout per AI call (seconds). If exceeded, fall back to text summary
# and release the semaphore slot so the queue keeps moving.
AI_SUMMARY_TIMEOUT_SEC = 90

_ai_semaphore = threading.Semaphore(AI_CONCURRENCY_LIMIT)

# Per-dispatch-run cache: (project_ids_key, country, date_str) -> report_data dict
# Date is included so same project+country on different days don't collide.
_summary_cache: dict[tuple[str, str, str], dict[str, Any]] = {}
_cache_lock = threading.Lock()

# Per-dispatch timestamp — used as the "report date" for the cache key.
# Set at the start of each dispatch_reports() call.
_dispatch_date_str: str = ""


def _cache_key(project_ids: list[int] | None, country: str, date_str: str) -> tuple[str, str, str]:
    """Build a cache key that includes project list, country, and date."""
    if not project_ids:
        proj_key = "*"
    else:
        proj_key = ",".join(str(pid) for pid in sorted(project_ids))
    return (proj_key, country, date_str)


def _raise_timeout(*args):
    """Called by signal handler when AI call times out."""
    raise TimeoutError("AI summary timed out")


def _build_report_data_with_timeout(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    date_str: str,
    ai_model: str | None = None,
) -> dict[str, Any]:
    """Build report data inside the semaphore, with optional per-call timeout.

    Uses signal.SIGALRM on UNIX platforms (non-blocking per-call alarm).
    Falls back to direct call on Windows or if signals are unavailable.
    """
    if AI_SUMMARY_TIMEOUT_SEC <= 0:
        return _do_build_report(project_ids, country, frequency, ai_model=ai_model)

    try:
        old_handler = signal.signal(signal.SIGALRM, _raise_timeout)
        signal.alarm(AI_SUMMARY_TIMEOUT_SEC)
        try:
            result = _do_build_report(project_ids, country, frequency, ai_model=ai_model)
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
        return result
    except (AttributeError, OSError):
        # signal.SIGALRM not available on Windows — call without timeout
        return _do_build_report(project_ids, country, frequency, ai_model=ai_model)
    except TimeoutError:
        logger.warning(
            "AI summary timed out for project=%s country=%s date=%s — using fallback",
            project_ids, country, date_str,
        )
        return _fallback_report_data(project_ids, country, frequency)


def _do_build_report(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
) -> dict[str, Any]:
    """Build report data (no timeout protection — run inside semaphore)."""
    db = SessionLocal()
    try:
        return build_report_email_data(
            db=db,
            project_ids=project_ids,
            country=country,
            frequency=frequency,
            ai_model=ai_model,
        )
    finally:
        db.close()


def _fallback_report_data(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
) -> dict[str, Any]:
    """Return report with plain-text fallback summary when AI times out."""
    db = SessionLocal()
    try:
        data = build_report_email_data(
            db=db,
            project_ids=project_ids,
            country=country,
            frequency=frequency,
        )
        # Replace AI summary with fallback text (no AI call)
        from app.services.scheduled_report.report_builder_daily import _generate_summary
        overview = data.get("overview", {})
        data["ai_summary"] = _generate_summary(frequency, overview)
        return data
    finally:
        db.close()


def _build_report_with_throttle(
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
) -> dict[str, Any]:
    """Build report data, throttling AI summary generation via semaphore.

    If another thread already built the same report (same projects + country + date),
    return the cached version to avoid a redundant AI call.

    If the AI call exceeds AI_SUMMARY_TIMEOUT_SEC, it is cancelled and a
    fallback summary is used instead — the semaphore slot is always released.
    """
    date_str = _dispatch_date_str
    key = _cache_key(project_ids, country, date_str)

    # ── fast path: cache hit (no semaphore needed) ──────────────────────────
    with _cache_lock:
        if key in _summary_cache:
            logger.info("AI summary cache hit: %s", key)
            return _summary_cache[key]

    # ── slow path: acquire semaphore → throttle AI calls ────────────────────
    _ai_semaphore.acquire()
    try:
        # Double-check cache after acquiring semaphore
        with _cache_lock:
            if key in _summary_cache:
                return _summary_cache[key]

        report_data = _build_report_data_with_timeout(
            project_ids, country, frequency, date_str, ai_model=ai_model
        )

        with _cache_lock:
            _summary_cache[key] = report_data

        return report_data
    finally:
        _ai_semaphore.release()


def _dispatch_one(
    subscription_id: int,
    email: str,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    ai_model: str | None = None,
) -> dict[str, Any]:
    """Dispatch a single subscription: build data → send email → log result."""
    result: dict[str, Any] = {
        "subscription_id": subscription_id,
        "email": email,
        "success": False,
        "error": None,
    }

    db = SessionLocal()
    try:
        today_str = date.today().isoformat()
        log = create_delivery_log(
            db=db,
            subscription_id=subscription_id,
            frequency=frequency,
            report_date=today_str,
            report_month=today_str[:7] if frequency == "monthly" else None,
            email=email,
        )
        log_id = log.id
    except Exception as e:
        logger.error("Failed to create delivery log for sub %d: %s", subscription_id, e)
        result["error"] = str(e)
        db.close()
        return result

    try:
        report_data = _build_report_with_throttle(project_ids, country, frequency, ai_model=ai_model)

        success, resend_id_or_error = send_scheduled_report_email(email, frequency, report_data)

        if success:
            mark_delivery_success(db, log_id, resend_id_or_error)
            result["success"] = True
            logger.info("Report sent: sub=%d email=%s", subscription_id, email)
        else:
            mark_delivery_failed(db, log_id, resend_id_or_error or "Unknown error")
            result["error"] = resend_id_or_error
            logger.warning("Report send failed: sub=%d error=%s", subscription_id, resend_id_or_error)
    except Exception as e:
        mark_delivery_failed(db, log_id, str(e))
        result["error"] = str(e)
        logger.error("Report dispatch error: sub=%d %s", subscription_id, e)
    finally:
        db.close()

    return result


def _pre_warm_cache(keys: list[tuple[str, str, str]], frequency: str) -> None:
    """Pre-build report data for given cache keys, one at a time.

    Acquires the semaphore for each key sequentially so we don't spike
    AI API concurrency. Pre-warming fills the cache so duplicate
    subscriptions skip the semaphore wait entirely.
    """
    for key in keys:
        proj_key, country, _ = key
        project_ids = None if proj_key == "*" else [int(p) for p in proj_key.split(",")]
        try:
            _build_report_with_throttle(project_ids, country, frequency)
        except Exception as e:
            logger.warning("Pre-warm failed for key=%s: %s", key, e)


def dispatch_reports(frequency: str) -> dict[str, Any]:
    """Dispatch all active subscriptions for the given frequency.

    This is the main entry point called by the scheduler or a manual trigger.
    It runs subscriptions concurrently with a thread pool but limits AI API
    calls to AI_CONCURRENCY_LIMIT at a time via a semaphore.

    Returns a summary dict with counts of sent/failed/total.
    """
    global _summary_cache
    global _dispatch_date_str

    # Reset per-run state
    with _cache_lock:
        _summary_cache = {}
    _dispatch_date_str = date.today().isoformat()

    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, frequency)
    finally:
        db.close()

    if not subscriptions:
        logger.info("No active %s subscriptions found", frequency)
        return {"frequency": frequency, "total": 0, "sent": 0, "failed": 0, "errors": []}

    # ── pre-warm cache for duplicate project+country combos ───────────────────
    combo_counts: dict[tuple[str, str, str], int] = {}
    for sub in subscriptions:
        key = _cache_key(sub.project_id_list or None, sub.country, _dispatch_date_str)
        combo_counts[key] = combo_counts.get(key, 0) + 1

    dupes_exist = any(c > 1 for c in combo_counts.values())
    if dupes_exist:
        logger.info(
            "Pre-warming cache for %d unique combos (duplicates will hit cache)",
            len(combo_counts),
        )
        _pre_warm_cache(list(combo_counts.keys()), frequency)

    # ── dispatch all subscriptions in parallel ────────────────────────────────
    logger.info("Dispatching %d %s report(s)", len(subscriptions), frequency)

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

    results: list[dict[str, Any]] = []
    max_workers = min(len(tasks), 8)
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_dispatch_one, **task): task for task in tasks}
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                task = futures[future]
                logger.error(
                    "Unexpected error dispatching sub %d: %s",
                    task["subscription_id"], e,
                )
                results.append({
                    "subscription_id": task["subscription_id"],
                    "email": task["email"],
                    "success": False,
                    "error": str(e),
                })

    sent = sum(1 for r in results if r["success"])
    failed = sum(1 for r in results if not r["success"])
    errors = [
        {
            "subscription_id": r["subscription_id"],
            "email": r["email"],
            "error": r["error"],
        }
        for r in results if not r["success"]
    ]

    summary = {
        "frequency": frequency,
        "total": len(results),
        "sent": sent,
        "failed": failed,
        "errors": errors,
    }
    logger.info("Dispatch complete: %s", summary)

    # Clear cache after run
    with _cache_lock:
        _summary_cache = {}

    return summary


def prewarm_cache_for_frequency(frequency: str) -> dict[str, Any]:
    """Manually pre-warm the AI summary cache for a frequency.

    Useful for running before a big dispatch to prime the cache.
    Returns the number of unique combos pre-warmed.
    """
    global _dispatch_date_str
    _dispatch_date_str = date.today().isoformat()

    db = SessionLocal()
    try:
        subscriptions = get_active_subscriptions(db, frequency)
    finally:
        db.close()

    if not subscriptions:
        return {"frequency": frequency, "warmed": 0}

    combo_keys = {
        _cache_key(sub.project_id_list or None, sub.country, _dispatch_date_str)
        for sub in subscriptions
    }

    _pre_warm_cache(list(combo_keys), frequency)

    logger.info("Pre-warmed %d unique combos for %s", len(combo_keys), frequency)
    return {"frequency": frequency, "warmed": len(combo_keys)}


def dispatch_report_for_subscription(subscription_id: int) -> dict[str, Any]:
    """Dispatch a single subscription (used by manual trigger API)."""
    global _summary_cache
    global _dispatch_date_str

    if not _dispatch_date_str:
        _dispatch_date_str = date.today().isoformat()

    with _cache_lock:
        _summary_cache = {}

    db = SessionLocal()
    try:
        from app.services.scheduled_report.subscription_service import get_subscription_by_id
        sub = get_subscription_by_id(db, subscription_id)
    finally:
        db.close()

    if not sub:
        return {
            "subscription_id": subscription_id,
            "success": False,
            "error": "Subscription not found",
        }

    return _dispatch_one(
        subscription_id=sub.id,
        email=sub.email,
        project_ids=sub.project_id_list or None,
        country=sub.country,
        frequency=sub.frequency,
        ai_model=getattr(sub, "ai_model", None),
    )
