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
        # BEL-NEW: `scheduled_report.dispatch_one` (方案 §4.5) and
        # `ai_summary.generate_delivery_summary` (§4.6) add two more tasks
        # on dedicated `scheduled` and `ai_summary` queues.
        include=[
            "app.celery_tasks.ping",
            "app.celery_tasks.run_job",
            "app.celery_tasks.insights.generate",
            "app.celery_tasks.scheduled_report",
            "app.celery_tasks.ai_summary",
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
            # BEL-NEW: 定时报告迁移至 Celery
            # - `dispatch_one` 在 `scheduled` 队列（独立 worker 单元），计划 §4.4
            # - `generate_delivery_summary` 在 `ai_summary` 队列，独立信号量 §4.6
            "dispatch_one": {"queue": "scheduled"},
            "generate_delivery_summary": {"queue": "ai_summary"},
        },
        # All timestamps in messages/results use project timezone.
        timezone="Asia/Shanghai",
        enable_utc=True,
        # Concurrency is set per worker (`-c` flag in systemd unit); keep
        # the setting here as a documented fallback for `celery -A ... beat`
        # style invocations. The systemd unit also passes `--concurrency`
        # explicitly so a VPS resize only needs an env-var bump, not a
        # code change.
        worker_concurrency=settings.celery_worker_concurrency,
        # BEL-55-P4: route worker logs through the root logger and let them
        # flow to stdout. The systemd unit's `StandardOutput=journal`
        # (inherited from the unit defaults) ships the stream to journald
        # for central collection — see backend/docs/multi-worker-ops.md.
        # `worker_hijack_root_logger` rewires Celery's own loggers onto
        # the root so a `logging.basicConfig` from a task module can't
        # silently swallow records.
        worker_hijack_root_logger=True,
        # CELERYD_TASK_LOG_FORMAT keeps a single task prefix on each log
        # line so journald grep can pivot on `[<task_id>] [<task_name>]`
        # without re-joining multi-line records.
        worker_task_log_format="[%(processName)s] [%(levelname)s] %(task_name)s[%(task_id)s]: %(message)s",
    )

    return app


# Singleton Celery app — import this from `app.tasks.celery_app` everywhere.
celery_app: Celery = _build_celery_app()
# BEL-128 follow-up: `set_as_current()` only pins the *main* thread's
# `current_app`. FastAPI runs sync endpoints (ledger resend, etc.) in a
# ThreadPoolExecutor; those threads fall back to the process-wide default
# app. Without `set_default()`, the fallback is `Celery("default")` with
# broker=None → AMQP localhost:5672 → `Connection refused` on `.delay()`.
# Making believeboy the default binds `@shared_task` correctly in every
# thread. See tests/tasks/test_celery_app_config.py.
celery_app.set_default()


# Re-export the smoke-test task so callers can do `from app.tasks.celery_app
# import ping; ping.delay().get()` without reaching into the celery_tasks
# package directly. Mirrors the call shape in the BEL-55-P0 acceptance check.
from app.celery_tasks.ping import ping  # noqa: E402


__all__ = ["celery_app", "ping"]
