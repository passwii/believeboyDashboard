"""告警定时检测任务。

每 15 分钟跑一次全量规则检测，命中则分发（邮件 + 站内通知）。
队列：default（短任务）。
"""

from __future__ import annotations

import logging

from celery import shared_task

from app.db.session import SessionLocal
from app.services.alert.detector import detect_anomalies
from app.services.alert.dispatcher import dispatch_batch

logger = logging.getLogger(__name__)


@shared_task(name="alert_detect", acks_late=False)
def alert_detect() -> str:
    """检测所有激活规则并分发新事件。

    acks_late=False：幂等周期任务，检测器自带 24h 去重，丢了重跑即可。
    """
    db = SessionLocal()
    try:
        events = detect_anomalies(db)
        db.commit()
        if events:
            dispatch_batch(db, events)
    finally:
        db.close()

    logger.info("alert_detect 完成：新增事件 %d", len(events))
    return f"events={len(events)}"
