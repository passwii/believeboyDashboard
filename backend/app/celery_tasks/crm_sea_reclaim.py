"""CRM 公海自动回收定时任务（P3a）。

每日凌晨扫描有主但 N 天未跟进的客户/线索，自动掉公海。
N 由 settings.crm_sea_reclaim_days 控制（0 = 关闭）。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(name="crm_sea_reclaim", acks_late=False)
def crm_sea_reclaim() -> str:
    """扫描并回收 N 天未跟进的客户/线索至公海。

    acks_late=False：幂等周期任务，丢了重跑即可。
    """
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.services.crm.sea_reclaim_service import reclaim_stale_to_sea

    settings = get_settings()
    days = settings.crm_sea_reclaim_days
    if days <= 0:
        logger.info("crm_sea_reclaim 已关闭（crm_sea_reclaim_days=0），跳过")
        return "disabled"

    db = SessionLocal()
    try:
        result = reclaim_stale_to_sea(db, days=days)
    finally:
        db.close()

    logger.info(
        "crm_sea_reclaim 完成（阈值 %d 天）：回收客户 %d、线索 %d",
        days,
        result["customers"],
        result["leads"],
    )
    return f"reclaimed customers={result['customers']} leads={result['leads']}"
