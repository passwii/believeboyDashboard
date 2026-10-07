"""Agent 月报的两个 Celery 任务（BLF-1250 阶段一）。

* ``build_monthly_report_preview``（``reports`` 队列）：仅计算草稿。数据库原子
  领取（``claim_queued_build``）保证重复投递不重复执行；worker 被杀导致
  acks_late 重投时，第二次领取看到 ``running`` 会跳过，长期 running 由 janitor
  按硬超时恢复。
* ``agent_monthly_report_cleanup``（``default`` 队列，每小时）：过期/超时恢复与
  临时目录清理。

两者都不经过 Job / ``run_job`` 的 prepare/persist 分支：dashboard 既有自动入库
路径保持不变（增量 A 已验证内核不建正式行）。
"""

from __future__ import annotations

import logging

from billiard.exceptions import SoftTimeLimitExceeded
from celery import shared_task

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services import agent_monthly_report_janitor
from app.services.agent_monthly_report_build_service import (
    claim_queued_build,
    execute_build,
)

logger = logging.getLogger(__name__)

# 与 run_job 同量级：软 15 分钟 / 硬 20 分钟。janitor 的硬超时（25 分钟）必须
# 大于这里的硬超时，否则会把仍在计算的 build 判死。
BUILD_SOFT_TIME_LIMIT = 15 * 60
BUILD_HARD_TIME_LIMIT = 20 * 60


@shared_task(
    name="app.celery_tasks.monthly_report_preview.build_monthly_report_preview",
    bind=True,
    acks_late=True,
    max_retries=0,
    soft_time_limit=BUILD_SOFT_TIME_LIMIT,
    time_limit=BUILD_HARD_TIME_LIMIT,
)
def build_monthly_report_preview(self, build_id: int) -> dict:
    """仅计算草稿：领取 queued → 计算 → 落状态。"""
    settings = get_settings()
    db = SessionLocal()
    try:
        if not claim_queued_build(db, build_id):
            logger.info(
                "agent monthly report build %s not claimable (already running/done)",
                build_id,
            )
            return {"status": "skipped", "build_id": build_id}
        return execute_build(db, settings, build_id)
    except SoftTimeLimitExceeded:  # 领取后、计算前超时（execute_build 内部已兜底）
        logger.warning("agent monthly report build %s soft timeout", build_id)
        return {"status": "failed", "build_id": build_id, "reason": "timeout"}
    finally:
        db.close()


@shared_task(name="agent_monthly_report_cleanup")
def agent_monthly_report_cleanup() -> dict:
    """过期标记 + 超时恢复 + 临时目录清理（只碰 agent 私有根目录）。"""
    settings = get_settings()
    db = SessionLocal()
    try:
        return agent_monthly_report_janitor.sweep(db, settings)
    finally:
        db.close()
