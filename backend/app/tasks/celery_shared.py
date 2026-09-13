"""Queue routing + beat schedule — single source of truth for both Celery apps.

`celery_app.py` (API / worker) and `celery_beat_app.py` (beat) both import the
tables below, so a schedule entry or queue route can never drift between the
process that *publishes* a periodic task and the process that *executes* it.

Why this module exists separately (BLF-1047): `celery beat` calls
`app.loader.init_worker()` at startup
(`celery/apps/beat.py:Beat.init_loader`), which eagerly imports everything in
the app's `include=[...]`. Pointing beat at `celery_app.py` therefore dragged
the whole task-module → service → SQLAlchemy model import chain into a process
that only ever publishes *task names* to the broker (measured: 202MB RSS /
177MB RssAnon, 153 `app.*` modules, of which beat uses none). Keeping the
tables in this module lets the beat app be built with `include=[]` while still
sharing one definition.

Import discipline: stdlib + `celery.schedules.crontab` only. Nothing here may
pull in `app.services`, `app.models`, `app.db` or a task module — the beat app
imports this file, and the whole point is that beat stays small.
"""

from __future__ import annotations

from celery.schedules import crontab

# All timestamps in messages/results/schedules use the project timezone.
# Shared so beat and the workers can never disagree on when a cron fires.
CELERY_TASK_TIMEZONE = "Asia/Shanghai"

# Default routing target: every task without an explicit route lands here.
# Every deployed worker unit must consume this queue — `believeboy-celery.service`
# does (`-Q default,reports,insights,ai_summary`). A beat-side app that forgets
# this setting would publish to Celery's built-in `celery` queue, which nothing
# consumes, silently dropping the task.
CELERY_DEFAULT_QUEUE = "default"

# Queue routes by task name. Read by *both* apps: the worker app routes
# in-process `.delay()` publishes, and beat routes the periodic messages it
# sends by name.
# BEL-55-P1: long-running report jobs land on the `reports` queue so they don't
# compete for prefetch slots with short-lived default tasks (CRM scans, alerts).
TASK_ROUTES: dict[str, dict[str, str]] = {
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
}

# beat_schedule 说明（BLF-1034）：曾经的 office-tick 3s beat 条目已移除——
# 30 天内 office SSE 0 次访问且 digital_employees 仅 1 行，纯后台空转
# （~28,800 任务/天的 broker 往返 + worker fork + journald 99% 噪音）。
# office_tick 任务定义保留在 app/celery_tasks/office_tick.py，SSE 端点
# 走 _build_tick_sync 的 Redis miss fallback 自算；将来恢复调度时在
# beat_schedule 加回 {"office-tick": {"task": "office_tick", "schedule": 3.0}} 即可。
BEAT_SCHEDULE: dict[str, dict[str, object]] = {
    # CRM 公海自动回收（P3a）：每日凌晨 3 点扫描 N 天未跟进的客户/线索掉公海。
    "crm-sea-reclaim": {
        "task": "crm_sea_reclaim",
        "schedule": crontab(hour="3", minute="0"),
    },
    # CRM 任务到期提醒（BLF-513）：每小时 :05 扫描截止前 24h 内未提醒任务（错开整点）
    "crm-task-reminder": {
        "task": "crm_task_reminder",
        "schedule": crontab(minute="5"),
    },
    # CRM 7 天无跟进提醒（BLF-539）：每日 09:00 扫 stale 实体写提醒记录（工作日早高峰）
    "crm-follow-up-reminder": {
        "task": "crm_follow_up_reminder",
        "schedule": crontab(hour="9", minute="0"),
    },
    # CRM 规则引擎执行器（BLF-544）：每日 09:05 扫规则执行（错开 P9-1 提醒扫描）
    "crm-rule-engine": {
        "task": "crm_rule_engine",
        "schedule": crontab(hour="9", minute="5"),
    },
    # CRM 无跟进提醒邮件（BLF-540）：每日 09:10 扫描超期实体并按负责人发提醒邮件（错开 09:00/09:05）
    "crm-stale-email": {
        "task": "crm_stale_email",
        "schedule": crontab(hour="9", minute="10"),
    },
    # 告警定时检测（P1）：每 15 分钟跑全量规则检测 + 分发
    "alert-detect": {
        "task": "alert_detect",
        "schedule": crontab(minute="*/15"),
    },
    # BEL-373：退货分析物化表每日 03:00 UTC 刷新（plan §2.4 拍板）
    "return-analysis-refresh-daily": {
        "task": "return_analysis.refresh_daily",
        "schedule": crontab(hour="3", minute="0"),
    },
    # BEL-377：agent API 审计日志每日 04:00 清理超过保留期的行
    "agent-api-audit-cleanup": {
        "task": "agent_api_audit_cleanup",
        "schedule": crontab(hour="4", minute="0"),
    },
    # BLF-460：agent 写操作明细每日 04:30 清理（错开 04:00 读侧清理）
    "operation-audit-cleanup": {
        "task": "operation_audit_cleanup",
        "schedule": crontab(hour="4", minute="30"),
    },
    # BEL-379：ai_chat token 用量每日 03:15 CST（Asia/Shanghai 时区下）刷新快照，
    # 错开 return-analysis 03:00 与 agent-api-audit 04:00 的整点并发。
    "ai-chat-token-usage-refresh-daily": {
        "task": "ai_chat_token_usage.refresh_daily",
        "schedule": crontab(hour="3", minute="15"),
    },
}

__all__ = [
    "BEAT_SCHEDULE",
    "CELERY_DEFAULT_QUEUE",
    "CELERY_TASK_TIMEZONE",
    "TASK_ROUTES",
]
