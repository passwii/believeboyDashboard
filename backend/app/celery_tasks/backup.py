"""Celery tasks for PostgreSQL backup via pgBackRest → Cloudflare R2.

Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/

§3.1 P0-1 异步化承重墙: ``run_backup_task(record_id)`` 从 API 进程迁到
Celery worker, 避免 API 进程被 2h 备份阻塞, 并通过 broker 持久化保证
API 重启不丢备份在途。

§3.2 P0-2 状态机 + 幂等护栏 (Phase 1 循环 3 再实现完整入口逻辑):
  - worker 重投不重复跑 pgbackrest (phase 短路)
  - API 多 worker 触发同一 record 不并发 (SELECT FOR UPDATE 行锁 + 乐观锁)

Phase 1 stub: 只声明 task + 保留延迟入口, 入口护栏在循环 3 TDD 实装。
"""
from __future__ import annotations

import logging

from celery import shared_task

logger = logging.getLogger(__name__)

# 软/硬时间限制占位值 (Plan §3.1): 默认 90 / 120 min。
# Phase 1 实现前跑 pgbackrest info 历史 duration 字段统计后调 (参考
# 2026-07-10-scheduled-report-to-celery.md §4.8 流程)。
BACKUP_SOFT_TIME_LIMIT = 5400  # 90 min
BACKUP_HARD_TIME_LIMIT = 7200  # 120 min


@shared_task(
    name="app.celery_tasks.backup.run_backup_task",
    bind=True,
    acks_late=True,
    max_retries=2,
    default_retry_delay=60,
    soft_time_limit=BACKUP_SOFT_TIME_LIMIT,
    time_limit=BACKUP_HARD_TIME_LIMIT,
)
def run_backup_task(self, record_id: int) -> dict:
    """Run a pgBackRest backup for the given record.

    Phase 1 stub: 完整入口护栏 (行锁 + phase 短路 + 乐观锁) 在循环 3 TDD 实装。
    """
    logger.info("run_backup_task record_id=%s (stub)", record_id)
    return {"record_id": record_id, "status": "stub"}
