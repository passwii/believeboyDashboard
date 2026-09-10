"""Celery task that executes a durable Insight run attempt (BLF-1011).

Thin transport around :func:`app.services.insight.executor.execute_run`:
the attempt's state machine, idempotency, and LLM contract live in the
executor; this module only adds broker semantics — ``acks_late`` redelivery,
soft/hard time limits, and bounded retries for retryable failures.

Retry model
-----------
* Retryable provider failures (rate limit / timeout / 5xx) raise
  ``RetryableFailure`` from the executor: the run stays non-terminal and the
  task requeues the *same* attempt, which resumes on redelivery. Once
  ``max_retries`` is exhausted the run is parked as failed with the typed
  error, so it never hangs in a live state and never raises out of the
  worker as an unhandled exception.
* Soft-time-limit expiry also requeues without marking terminal, until
  ``max_retries`` is exhausted — then the run is parked as failed
  (``UPSTREAM_TIMEOUT``) so it never hangs in a live state.
* Worker kill / hard timeout: ``acks_late`` + ``reject_on_worker_lost`` make
  the broker redeliver; the executor resumes the same attempt.
* Explicit user retry is a different path (``runs.retry_run`` bumps
  ``attempt``) and never goes through ``self.retry``.
"""

from __future__ import annotations

import logging
from typing import Any

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded

from app.schemas.insight import (
    InsightError,
    InsightErrorCode,
    InsightStatus,
    make_error,
)
from app.services.insight.executor import (
    NullEventSink,
    RetryableFailure,
    execute_run,
)
from app.services.insight.lifecycle import is_terminal
from app.services.insight.runs import RunNotFound, get_run, transition

logger = logging.getLogger(__name__)


TASK_NAME = "execute_insight_run"


def _backoff_seconds(retries: int) -> int:
    """30s, 60s, 120s … capped at 10min; honors server Retry-After first."""
    return min(30 * (2**max(0, retries)), 600)


def _park_failed(run_id: str, attempt: int, error: InsightError) -> dict[str, Any]:
    """Mark a run terminal after retry exhaustion, on a fresh session.

    A stale task (explicit retry already bumped ``attempt``) or an already
    terminal run is left untouched, so an old worker can never overwrite a
    newer attempt or a user-driven terminal state.
    """

    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        try:
            run = get_run(db, run_id)
        except RunNotFound:
            logger.warning("execute_insight_run: run_id=%s vanished at park", run_id)
            return {"status": "not_found", "run_id": run_id}
        if run.attempt != attempt:
            logger.warning(
                "execute_insight_run: stale park run_id=%s attempt=%s current=%s",
                run_id,
                attempt,
                run.attempt,
            )
            return {"run_id": run.run_id, "attempt": run.attempt, "status": run.status}
        if not is_terminal(InsightStatus(run.status)):
            transition(db, run, InsightStatus.FAILED, error=error)
        db.commit()
        return {"run_id": run.run_id, "attempt": run.attempt, "status": run.status}
    except Exception:
        db.rollback()
        logger.exception("execute_insight_run: parking run_id=%s failed", run_id)
        raise
    finally:
        db.close()


@shared_task(
    name=TASK_NAME,
    bind=True,
    acks_late=True,
    reject_on_worker_lost=True,
    max_retries=3,
    soft_time_limit=300,
    time_limit=420,
)
def execute_insight_run(self, run_id: str, attempt: int) -> dict[str, Any]:
    """Execute one Insight attempt; see module docstring for retry semantics."""

    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        try:
            run = execute_run(
                db=db, run_id=run_id, attempt=attempt, sink=NullEventSink()
            )
        except RetryableFailure as exc:
            if self.request.retries >= (self.max_retries or 0):
                logger.warning(
                    "execute_insight_run: retries exhausted run_id=%s attempt=%s code=%s",
                    run_id,
                    attempt,
                    exc.error.code.value,
                )
                db.rollback()
                db.close()
                return _park_failed(run_id, attempt, exc.error)
            try:
                db.commit()
            except Exception:  # noqa: BLE001
                db.rollback()
            countdown = exc.retry_after or _backoff_seconds(self.request.retries)
            logger.info(
                "execute_insight_run: retryable run_id=%s attempt=%s code=%s",
                run_id,
                attempt,
                exc.error.code.value,
            )
            raise self.retry(exc=exc, countdown=countdown)
        db.commit()
        return {"run_id": run.run_id, "attempt": run.attempt, "status": run.status}
    except RunNotFound:
        db.rollback()
        logger.warning("execute_insight_run: unknown run_id=%s", run_id)
        return {"status": "not_found", "run_id": run_id, "attempt": attempt}
    except SoftTimeLimitExceeded as exc:
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        if self.request.retries >= (self.max_retries or 0):
            logger.warning(
                "execute_insight_run: retries exhausted run_id=%s attempt=%s",
                run_id,
                attempt,
            )
            db.close()
            return _park_failed(
                run_id,
                attempt,
                make_error(
                    InsightErrorCode.UPSTREAM_TIMEOUT,
                    "Insight run timed out repeatedly",
                ),
            )
        raise self.retry(exc=exc, countdown=_backoff_seconds(self.request.retries))
    except Exception:
        db.rollback()
        logger.exception(
            "execute_insight_run: run_id=%s attempt=%s failed", run_id, attempt
        )
        raise
    finally:
        db.close()


def enqueue_insight_run(run_id: str, attempt: int) -> None:
    """Production EnqueueFunc: send the task (resolved at call time)."""
    execute_insight_run.delay(run_id, attempt)
