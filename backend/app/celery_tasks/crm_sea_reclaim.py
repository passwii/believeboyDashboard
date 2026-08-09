"""CRM 公海自动回收定时任务（P3a + P9-3 价值差异化）。

每日凌晨扫描有主但 N 天未跟进的客户/线索，自动掉公海。
N 由 settings.crm_sea_reclaim_days 控制（0 = 关闭）。

P9-3（BLF-541）价值差异化：按 crm_reclaim_settings 单行表
（get_reclaim_settings）——exempt_ratings（默认 A）永不回收；
rating_b_days / rating_c_days（默认 7）覆盖 B/C 档回收天数；
未配置档位（如 D）与线索回落全局 crm_sea_reclaim_days。

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
    from app.services.crm.sea_reclaim_service import (
        get_reclaim_settings,
        reclaim_stale_to_sea,
    )

    settings = get_settings()
    days = settings.crm_sea_reclaim_days
    if days <= 0:
        logger.info("crm_sea_reclaim 已关闭（crm_sea_reclaim_days=0），跳过")
        return "disabled"

    db = SessionLocal()
    try:
        reclaim_cfg = get_reclaim_settings(db)
        exempt_ratings = {
            r.strip()
            for r in (reclaim_cfg.exempt_ratings or "").split(",")
            if r.strip()
        }
        rating_days: dict[str, int] = {}
        if reclaim_cfg.rating_b_days is not None:
            rating_days["B"] = reclaim_cfg.rating_b_days
        if reclaim_cfg.rating_c_days is not None:
            rating_days["C"] = reclaim_cfg.rating_c_days
        if reclaim_cfg.rating_d_days is not None:
            rating_days["D"] = reclaim_cfg.rating_d_days

        result = reclaim_stale_to_sea(
            db,
            days=days,
            exempt_ratings=exempt_ratings or None,
            rating_days=rating_days or None,
        )
    finally:
        db.close()

    logger.info(
        "crm_sea_reclaim 完成（全局阈值 %d 天，豁免 %s，分档 %s）：回收客户 %d、线索 %d",
        days,
        sorted(exempt_ratings),
        rating_days,
        result["customers"],
        result["leads"],
    )
    return f"reclaimed customers={result['customers']} leads={result['leads']}"
