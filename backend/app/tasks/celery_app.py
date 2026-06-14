"""Celery application factory and configuration.

This module owns the Celery app instance used by the worker systemd unit
(`believeboy-worker.service`).

BEL-55-P0 brought up the broker + ping smoke-test task. BEL-55-P1 adds
`app.celery_tasks.run_job` (the lifted `worker.tasks.run_job`) and the
`reports` queue route. BEL-55-P2 adds `app.celery_tasks.insights.generate`
and the `insights` queue route.
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
        # `ping` is the BEL-55-P0 smoke-test task; `run_job` is the
        # BEL-55-P1 lift of `worker.tasks.run_job` into Celery. The
        # worker systemd unit consumes from `default,reports,insights`
        # (see deploy/systemd/believeboy-worker.service) so both modules
        # are eagerly imported at worker boot.
        include=[
            "app.celery_tasks.ping",
            "app.celery_tasks.run_job",
            "app.celery_tasks.insights.generate",
        ],
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
        # BEL-55-P1: long-running report jobs land on the `reports` queue
        # so they don't compete for prefetch slots with short-lived
        # default tasks (e.g. the smoke-test ping). The worker systemd
        # unit already consumes from this queue.
        task_routes={
            "app.celery_tasks.run_job.run_job": {"queue": "reports"},
            "generate_insight": {"queue": "insights"},
        },
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
