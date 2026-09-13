"""Celery application factory and configuration.

This module owns the Celery app instance used by the worker systemd unit
(`believeboy-celery.service`).

BEL-55-P1 added `app.celery_tasks.run_job` (the Celery port of the original
in-process job runner) and the `reports` queue route.
BEL-55-P2 added `app.celery_tasks.insights.generate` and the `insights`
queue route. BLF-1037 removed the last BEL-55-P0/P1 leftovers: the `ping`
smoke-test task and the `backend/worker/` package.
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

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
        # Default routing: every task without an explicit route lands here.
        task_default_queue="default",
        # BEL-55-P1: long-running report jobs land on the `reports` queue
        # so they don't compete for prefetch slots with short-lived
        # default tasks (CRM scans, alerts, ...). The worker systemd
        # unit already consumes from this queue.
        task_routes={
            "app.celery_tasks.run_job.run_job": {"queue": "reports"},
            "generate_insight": {"queue": "insights"},
            "execute_insight_run": {"queue": "insights"},
            # BEL-NEW: 定时报告迁移至 Celery
            # - `dispatch_one` 在 `scheduled` 队列（独立 worker 单元），计划 §4.4
            # - `generate_delivery_summary` 在 `ai_summary` 队列，独立信号量 §4.6
            "dispatch_one": {"queue": "scheduled"},
            "generate_delivery_summary": {"queue": "ai_summary"},
            # 虚拟办公室独立推进器：default 队列（短任务 <100ms）
            "office_tick": {"queue": "default"},
            # CRM 公海自动回收（P3a）：default 队列（每日一次短任务）
            "crm_sea_reclaim": {"queue": "default"},
            # CRM 任务到期提醒扫描（BLF-513）：default 队列（每小时一次短任务）
            "crm_task_reminder": {"queue": "default"},
            # CRM 7 天无跟进提醒（BLF-539）：default 队列（每日一次短任务）
            "crm_follow_up_reminder": {"queue": "default"},
            # CRM 规则引擎执行器（BLF-544）：default 队列（每日一次短任务）
            "crm_rule_engine": {"queue": "default"},
            # CRM 无跟进提醒邮件（BLF-540）：default 队列（每日 09:10 一次短任务）
            "crm_stale_email": {"queue": "default"},
            # 告警定时检测（P1）：default 队列（短任务，每 15 分钟）
            "alert_detect": {"queue": "default"},
            # BEL-377：agent API 审计日志保留清理：default 队列（每日一次短任务）
            "agent_api_audit_cleanup": {"queue": "default"},
            # BLF-460：agent 写操作明细保留清理：default 队列（每日一次短任务）
            "operation_audit_cleanup": {"queue": "default"},
            # BEL-379：ai_chat token 用量每日聚合快照：default 队列（每日一次短任务）
            "ai_chat_token_usage.refresh_daily": {"queue": "default"},
        },
        # beat_schedule 说明（BLF-1034）：曾经的 office-tick 3s beat 条目已移除——
        # 30 天内 office SSE 0 次访问且 digital_employees 仅 1 行，纯后台空转
        # （~28,800 任务/天的 broker 往返 + worker fork + journald 99% 噪音）。
        # office_tick 任务定义保留在 app/celery_tasks/office_tick.py，SSE 端点
        # 走 _build_tick_sync 的 Redis miss fallback 自算；将来恢复调度时在
        # beat_schedule 加回 {"office-tick": {"task": "office_tick", "schedule": 3.0}} 即可。
        beat_schedule={
            # CRM 公海自动回收（P3a）：每日凌晨 3 点扫描 N 天未跟进的客户/线索掉公海。
            "crm-sea-reclaim": {
                "task": "crm_sea_reclaim",
                "schedule": crontab(hour=3, minute=0),
            },
            # CRM 任务到期提醒（BLF-513）：每小时 :05 扫描截止前 24h 内未提醒任务（错开整点）
            "crm-task-reminder": {
                "task": "crm_task_reminder",
                "schedule": crontab(minute=5),
            },
            # CRM 7 天无跟进提醒（BLF-539）：每日 09:00 扫 stale 实体写提醒记录（工作日早高峰）
            "crm-follow-up-reminder": {
                "task": "crm_follow_up_reminder",
                "schedule": crontab(hour=9, minute=0),
            },
            # CRM 规则引擎执行器（BLF-544）：每日 09:05 扫规则执行（错开 P9-1 提醒扫描）
            "crm-rule-engine": {
                "task": "crm_rule_engine",
                "schedule": crontab(hour=9, minute=5),
            },
            # CRM 无跟进提醒邮件（BLF-540）：每日 09:10 扫描超期实体并按负责人发提醒邮件（错开 09:00/09:05）
            "crm-stale-email": {
                "task": "crm_stale_email",
                "schedule": crontab(hour=9, minute=10),
            },
            # 告警定时检测（P1）：每 15 分钟跑全量规则检测 + 分发
            "alert-detect": {
                "task": "alert_detect",
                "schedule": crontab(minute="*/15"),
            },
            # BEL-373：退货分析物化表每日 03:00 UTC 刷新（plan §2.4 拍板）
            "return-analysis-refresh-daily": {
                "task": "return_analysis.refresh_daily",
                "schedule": crontab(hour=3, minute=0),
            },
            # BEL-377：agent API 审计日志每日 04:00 清理超过保留期的行
            "agent-api-audit-cleanup": {
                "task": "agent_api_audit_cleanup",
                "schedule": crontab(hour=4, minute=0),
            },
            # BLF-460：agent 写操作明细每日 04:30 清理（错开 04:00 读侧清理）
            "operation-audit-cleanup": {
                "task": "operation_audit_cleanup",
                "schedule": crontab(hour=4, minute=30),
            },
            # BEL-379：ai_chat token 用量每日 03:15 CST（Asia/Shanghai 时区下）刷新快照，
            # 错开 return-analysis 03:00 与 agent-api-audit 04:00 的整点并发。
            "ai-chat-token-usage-refresh-daily": {
                "task": "ai_chat_token_usage.refresh_daily",
                "schedule": crontab(hour=3, minute=15),
            },
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
