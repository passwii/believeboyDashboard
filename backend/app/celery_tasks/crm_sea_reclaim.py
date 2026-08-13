"""CRM 公海自动回收定时任务（P3a + P9-3 价值分档）。

每日凌晨扫描有主但 N 天未跟进的客户/线索，自动掉公海。
N 由 settings.crm_sea_reclaim_days 控制（0 = 关闭）。
客户按 P6a 价值分档差异化（P9-3, BLF-541）：rating=A 永不回收，
B/C/D 档按 N 天回收；线索无分档维持统一阈值。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task
from app.services.infra.cache_decorator import invalidate_cache_on_commit_celery

logger = logging.getLogger(__name__)


@shared_task(name="crm_sea_reclaim", acks_late=False)
@invalidate_cache_on_commit_celery(
    domains=["crm"],
    project_id_from="global",
    on_error="log",
)
def crm_sea_reclaim() -> str:
    """扫描并回收 N 天未跟进的客户/线索至公海。

    acks_late=False：幂等周期任务，丢了重跑即可。
    """
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.services.crm.sea_reclaim_service import reclaim_stale_to_sea
    from app.services.infra.cache_decorator import mark_committed

    settings = get_settings()
    days = settings.crm_sea_reclaim_days
    if days <= 0:
        logger.info("crm_sea_reclaim 已关闭（crm_sea_reclaim_days=0），跳过")
        return "disabled"

    db = SessionLocal()
    try:
        result = reclaim_stale_to_sea(db, days=days)
        mark_committed()  # BLF-669: service 内部已 commit，协议标记
    finally:
        db.close()

    logger.info(
        "crm_sea_reclaim 完成（阈值 %d 天）：回收客户 %d、线索 %d",
        days,
        result["customers"],
        result["leads"],
    )
    return f"reclaimed customers={result['customers']} leads={result['leads']}"
