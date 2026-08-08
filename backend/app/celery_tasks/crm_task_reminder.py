"""CRM 任务到期提醒扫描定时任务（P7-4, BLF-513）。

每小时 :05（crontab(minute=5)，错开整点）扫描截止前 REMIND_LEAD_HOURS 小时内
未提醒的 pending/in_progress 任务，命中即置 reminded_at=now（单次提醒，不轰炸）。
SSE 端点（GET /crm/tasks/reminders/stream）轮询拾取后推送给对应负责人。

队列：default（短任务，每小时一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task

from app.services.crm.task_service import REMIND_LEAD_HOURS

logger = logging.getLogger(__name__)


@shared_task(name="crm_task_reminder", acks_late=False)
def crm_task_reminder() -> str:
    """扫描并标记截止前 24h 内未提醒的任务。

    acks_late=False：幂等周期任务，丢了重跑即可（reminded_at 已置的任务会跳过）。
    """
    from app.db.session import SessionLocal
    from app.services.crm.task_service import mark_due_tasks_reminded

    db = SessionLocal()
    try:
        marked = mark_due_tasks_reminded(db, lead_hours=REMIND_LEAD_HOURS)
    finally:
        db.close()

    logger.info("crm_task_reminder 完成：标记提醒 %d 个任务", marked)
    return f"marked={marked}"
