"""CRM 规则引擎执行器定时任务（P9-6, BLF-544）。

每日扫 `crm_rules` 中 enabled 的规则，条件命中实体后执行动作
（MVP：notify_owner → 写 active 提醒记录，复用 P9-1 SSE 推送链路）。

全局开关 settings.crm_rule_engine_enabled（False = 关闭，不扫）。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging

from celery import shared_task
from app.services.infra.cache_decorator import invalidate_cache_on_commit_celery

logger = logging.getLogger(__name__)


@shared_task(name="crm_rule_engine", acks_late=False)
@invalidate_cache_on_commit_celery(
    domains=["crm"],
    project_id_from="global",
    on_error="log",
)
def crm_rule_engine() -> str:
    """扫描规则并执行。acks_late=False：幂等周期任务，丢了重跑即可。"""
    from app.core.config import get_settings
    from app.db.session import SessionLocal
    from app.services.crm.rule_engine_service import scan_rules
    from app.services.infra.cache_decorator import mark_committed

    settings = get_settings()
    if not settings.crm_rule_engine_enabled:
        logger.info("crm_rule_engine 已关闭（crm_rule_engine_enabled=False），跳过")
        return "disabled"

    db = SessionLocal()
    try:
        result = scan_rules(db)
        db.commit()  # scan_rules 只 flush；此处统一 commit，否则 close 时回滚丢写
        mark_committed()  # BLF-669: commit 后必须 mark（装饰器在返回时统一失效）
    finally:
        db.close()

    logger.info(
        "crm_rule_engine 完成：规则 %d（跳过 %d）、命中实体 %d、新建提醒 %d"
        "（去重跳过 %d、无负责人跳过 %d）",
        result["rules_evaluated"],
        result["rules_skipped_unsupported"],
        result["entities_matched"],
        result["notify_created"],
        result["notify_skipped_active"],
        result["notify_skipped_no_owner"],
    )
    return (
        f"rules={result['rules_evaluated']} skipped={result['rules_skipped_unsupported']} "
        f"matched={result['entities_matched']} created={result['notify_created']}"
    )
