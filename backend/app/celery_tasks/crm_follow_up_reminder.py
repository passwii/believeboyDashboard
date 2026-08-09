"""CRM 7 天无跟进提醒扫描定时任务（P9-1, BLF-539）。

每日上午扫超 N 天未跟进的客户/线索，写入 active 提醒记录（幂等单次提醒）。
SSE 端点（GET /crm/follow-ups/reminders/stream）轮询拾取后推送给对应负责人，
前端 useNotifications 弹站内 toast。

N 由 settings.crm_follow_up_reminder_days 控制（0 = 关闭）。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(name="crm_follow_up_reminder", acks_late=False)
def crm_follow_up_reminder() -> str:
    """扫描并写入 7 天无跟进提醒记录。

    acks_late=False：幂等周期任务，丢了重跑即可（已有 active 记录会跳过）。
    """
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.services.crm.follow_up_reminder_service import scan_stale_entities

    settings = get_settings()
    days = settings.crm_follow_up_reminder_days
    if days <= 0:
        logger.info(
            "crm_follow_up_reminder 已关闭（crm_follow_up_reminder_days=0），跳过"
        )
        return "disabled"

    db = SessionLocal()
    try:
        result = scan_stale_entities(db, days=days)
        db.commit()  # scan 只 flush；此处统一 commit，否则 close 时回滚丢写
    finally:
        db.close()

    logger.info(
        "crm_follow_up_reminder 完成（阈值 %d 天）：新提醒客户 %d、线索 %d",
        days,
        result["customers"],
        result["leads"],
    )
    return f"reminded customers={result['customers']} leads={result['leads']}"
