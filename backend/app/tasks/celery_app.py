"""Celery application factory and configuration.

This module owns the Celery app instance used by the API process and the
worker systemd units (`believeboy-celery.service`,
`believeboy-celery-scheduled.service`).

BEL-55-P1 added `app.celery_tasks.run_job` (the Celery port of the original
in-process job runner) and the `reports` queue route.
BEL-55-P2 added `app.celery_tasks.insights.generate` and the `insights`
queue route. BLF-1037 removed the last BEL-55-P0/P1 leftovers: the `ping`
smoke-test task and the `backend/worker/` package.
BLF-1047 moved the queue routes + beat schedule into
`app/tasks/celery_shared.py` so beat can import the same tables while using a
different app that skips this module's `include=[...]` import chain — see
`app/tasks/celery_beat_app.py`.
"""

from __future__ import annotations

from celery import Celery

from app.core.config import get_settings
from app.tasks.celery_shared import (
    BEAT_SCHEDULE,
    CELERY_DEFAULT_QUEUE,
    CELERY_TASK_TIMEZONE,
    TASK_ROUTES,
)


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
        # Tasks executed by the workers below are eagerly imported at worker
        # boot. `celery beat` uses the same `init_worker()` path, so it must NOT
        # point at this module (BLF-1047) — beat runs `celery_beat_app` instead.
        #
        # `run_job` is the Celery port of the original in-process job
        # runner. The worker systemd unit consumes from
        # `default,reports,insights` (see
        # deploy/systemd/believeboy-celery.service) so these modules are
        # eagerly imported at worker boot.
        # BEL-NEW: `scheduled_report.dispatch_one` (方案 §4.5) and
        # `ai_summary.generate_delivery_summary` (§4.6) add two more tasks
        # on dedicated `scheduled` and `ai_summary` queues.
        include=[
            "app.celery_tasks.run_job",
            "app.celery_tasks.insights.generate",
            "app.celery_tasks.insights.run",
            "app.celery_tasks.scheduled_report",
            "app.celery_tasks.ai_summary",
            "app.celery_tasks.office_tick",
            "app.celery_tasks.crm_sea_reclaim",
            "app.celery_tasks.crm_task_reminder",
            "app.celery_tasks.crm_follow_up_reminder",
            "app.celery_tasks.crm_rule_engine",
            "app.celery_tasks.crm_stale_email",
            "app.celery_tasks.alert_detection",
            # BEL-373：每日 03:00 UTC 刷新退货分析物化表
            "app.celery_tasks.return_analysis_refresh",
            # BEL-377：agent API 审计日志 90 天保留清理
            "app.celery_tasks.agent_api_audit_cleanup",
            # BLF-460：agent 写操作明细（operation_audit_logs）90 天保留清理
            "app.celery_tasks.operation_audit_cleanup",
            # BEL-379：每日 03:15 CST 刷新 ai_chat token 用量聚合快照
            "app.celery_tasks.ai_chat_token_usage_refresh",
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
        # Default routing + queue routes: shared with the beat app so the
        # publisher and the executor can never disagree (BLF-1047).
        task_default_queue=CELERY_DEFAULT_QUEUE,
        task_routes=TASK_ROUTES,
        beat_schedule=BEAT_SCHEDULE,
        # All timestamps in messages/results use project timezone.
        timezone=CELERY_TASK_TIMEZONE,
        enable_utc=True,
        # Concurrency is set per worker (`-c` flag in systemd unit); keep
        # the setting here as a documented fallback for `celery worker`
        # invocations that omit it. The systemd unit also passes `--concurrency`
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
