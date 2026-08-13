"""CRM 无跟进提醒邮件定时任务（P9-2, BLF-540）。

每日 09:00（Asia/Shanghai，crontab(hour=9, minute=0)）扫描有主但超过
``crm_workflow_settings.stale_days`` 天未跟进的客户/线索，按负责人聚合
发提醒邮件。开关 ``stale_email_enabled=false`` 时跳过（admin 设置页可关）。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task
from app.services.infra.cache_decorator import invalidate_cache_on_commit_celery

logger = logging.getLogger(__name__)


@shared_task(name="crm_stale_email", acks_late=False)
@invalidate_cache_on_commit_celery(
    domains=["crm"], project_id_from="global", on_error="log"
)
def crm_stale_email() -> str:
    """扫描并发送无跟进提醒邮件。

    acks_late=False：幂等周期任务（stale_email_sent_at 去重），丢了重跑即可。
    """
    from app.db.session import SessionLocal
    from app.services.crm.stale_email_service import send_stale_reminder_emails
    from app.services.infra.cache_decorator import mark_committed

    db = SessionLocal()
    try:
        result = send_stale_reminder_emails(db)
        mark_committed()  # BLF-669: service 内部已 commit，协议标记
    finally:
        db.close()

    if result.get("disabled"):
        logger.info("crm_stale_email 已关闭（stale_email_enabled=false），跳过")
        return "disabled"

    logger.info(
        "crm_stale_email 完成：邮件 %d 封（客户 %d、线索 %d，负责人 %d 有邮箱 / %d 无邮箱）",
        result["emails_sent"],
        result["customers"],
        result["leads"],
        result["owners_emailed"],
        result["owners_without_email"],
    )
    return (
        f"emails={result['emails_sent']} customers={result['customers']} "
        f"leads={result['leads']}"
    )
