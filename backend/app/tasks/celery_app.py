"""Celery application factory and configuration.

This module owns the Celery app instance used by the worker systemd unit
(`believeboy-worker.service`). It is intentionally minimal in BEL-55-P0: it
brings up the broker connection, registers the (currently empty) shared task
package, and exposes a `ping` task that verifies round-trip end-to-end.

Migration of the in-process `enqueue_job` threading model is tracked under
BEL-55-P1+ and is explicitly out of scope here.
"""

from __future__ import annotations

from celery import Celery

from app.core.config import get_settings


def _build_celery_app() -> Celery:
    """Construct the singleton Celery application used by both API and worker.

    The app pulls broker / result backend URLs from `Settings` (which auto-
    derives from `REDIS_*` when `CELERY_BROKER_URL` / `CELERY_RESULT_URL` are
    blank). The `default` queue is bound to `app.celery_tasks` so the worker
    picks up any `@shared_task` registered there without further wiring.
    """
    settings = get_settings()

    app = Celery(
        "believeboy",
        broker=settings._celery_broker_url_resolved,
        backend=settings._celery_result_url_resolved,
        include=["app.celery_tasks.ping"],
    )

    app.conf.update(
        # Reliability: don't ack until the task body returns; if a worker is
        # killed mid-task the broker re-delivers the message.
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        # Prefetch 1 message per worker process: long-running report tasks
        # shouldn't starve short ones, and OOM-killed tasks get redelivered
        # instead of sitting on the prefetch buffer.
        worker_prefetch_multiplier=1,
        # Default routing: every task without an explicit route lands here.
        task_default_queue="default",
        # All timestamps in messages/results use project timezone.
        timezone="Asia/Shanghai",
        enable_utc=True,
        # Concurrency is set per worker (`-c` flag in systemd unit); keep
        # the setting here as a documented fallback for `celery -A ... beat`
        # style invocations.
        worker_concurrency=settings.celery_worker_concurrency,
    )

    return app


# Singleton Celery app — import this from `app.tasks.celery_app` everywhere.
celery_app: Celery = _build_celery_app()


# Re-export the smoke-test task so callers can do `from app.tasks.celery_app
# import ping; ping.delay().get()` without reaching into the celery_tasks
# package directly. Mirrors the call shape in the BEL-55-P0 acceptance check.
from app.celery_tasks.ping import ping  # noqa: E402


__all__ = ["celery_app", "ping"]
