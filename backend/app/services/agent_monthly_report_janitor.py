"""Agent 月报临时件生命周期（BLF-1250 阶段一）：过期、超时恢复与清理。

规则（契约 §已确认产品规则）：

* 未确认输入与结果保留 24 小时；到期后不可 build/confirm，由本 janitor 清理；
* **运行中的任务不被清理**：running 且未超过硬超时的 build 一律跳过，只有超过
  ``agent_monthly_report_build_timeout_minutes``（> celery 硬超时）才恢复为
  failed 再清理——避免状态永远 running 导致永不清理；
* 期限不延长：``expires_at`` 只在建会话/建 build 时写定，本模块从不改它；
* 只碰 ``agent_monthly_report_root`` 下的目录：正式文件（upload_root /
  result_root）绝不删除。

清理与数据库状态互斥：先落状态（同一事务提交），再删目录；删目录失败只记录，
下次扫描重试（增量 A 的清理失败路径也由这里兜底）。
"""

from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportBuildStatus,
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)
from app.services.agent_monthly_report_common import (
    build_dir,
    remove_tree_best_effort,
    upload_dir,
    utc_now,
)

logger = logging.getLogger(__name__)

_CLEANABLE_BUILD_STATUSES = (
    AgentMonthlyReportBuildStatus.queued.value,
    AgentMonthlyReportBuildStatus.success.value,
    AgentMonthlyReportBuildStatus.failed.value,
)


def _safe_remove(path: Path, root: Path) -> bool:
    """只允许删除 root 之下的目录（防配置错误删到正式目录）。"""
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()):
        logger.error("refusing to clean path outside agent root: %s", resolved)
        return False
    return remove_tree_best_effort(resolved)


def sweep(
    db: Session, settings: Settings, *, now=None, limit: int = 500
) -> dict[str, int]:
    """一次扫描：超时恢复 → 过期标记 → 清理临时目录。返回计数。"""
    moment = now or utc_now()
    root = settings.agent_monthly_report_root
    counts = {
        "timeout_recovered": 0,
        "builds_expired": 0,
        "builds_cleaned": 0,
        "uploads_expired": 0,
        "uploads_cleaned": 0,
        "orphans_cleaned": 0,
    }

    # 1. 过期 build：queued/success/failed 且已过期限 → expired。
    #    （running 不在此列：超时恢复优先，保留更有信息量的 failed 原因）
    expired_builds = (
        db.query(AgentMonthlyReportBuild)
        .filter(
            AgentMonthlyReportBuild.status.in_(_CLEANABLE_BUILD_STATUSES),
            AgentMonthlyReportBuild.expires_at <= moment,
        )
        .limit(limit)
        .all()
    )
    for build in expired_builds:
        build.status = AgentMonthlyReportBuildStatus.expired.value
        build.finished_at = build.finished_at or moment
        counts["builds_expired"] += 1
    db.commit()

    # 2. 超时恢复：running 超过硬超时 → failed（独立于 celery 的恢复策略）。
    timeout_cutoff = moment - timedelta(
        minutes=settings.agent_monthly_report_build_timeout_minutes
    )
    stale_running = (
        db.query(AgentMonthlyReportBuild)
        .filter(
            AgentMonthlyReportBuild.status
            == AgentMonthlyReportBuildStatus.running.value,
            AgentMonthlyReportBuild.started_at.isnot(None),
            AgentMonthlyReportBuild.started_at < timeout_cutoff,
        )
        .limit(limit)
        .all()
    )
    for build in stale_running:
        build.status = AgentMonthlyReportBuildStatus.failed.value
        build.error_message = "build_timeout_recovered"
        build.finished_at = moment
        counts["timeout_recovered"] += 1
    db.commit()

    # 3. 清理不可再用的 build 目录（failed / expired / cancelled；running 跳过）。
    cleanable = (
        db.query(AgentMonthlyReportBuild)
        .filter(
            AgentMonthlyReportBuild.status.in_(
                (
                    AgentMonthlyReportBuildStatus.failed.value,
                    AgentMonthlyReportBuildStatus.expired.value,
                    AgentMonthlyReportBuildStatus.cancelled.value,
                )
            )
        )
        .limit(limit)
        .all()
    )
    for build in cleanable:
        if _safe_remove(build_dir(settings, build.id), root):
            counts["builds_cleaned"] += 1

    # 4. 过期会话：非 confirmed 且已过期限 → expired；随后清理其输入目录。
    expired_uploads = (
        db.query(AgentMonthlyReportUpload)
        .filter(
            AgentMonthlyReportUpload.expires_at <= moment,
            AgentMonthlyReportUpload.status != AgentMonthlyReportUploadStatus.confirmed.value,
        )
        .limit(limit)
        .all()
    )
    for upload in expired_uploads:
        upload.status = AgentMonthlyReportUploadStatus.expired.value
        counts["uploads_expired"] += 1
    db.commit()

    for upload in expired_uploads:
        active = (
            db.query(AgentMonthlyReportBuild.id)
            .filter(
                AgentMonthlyReportBuild.upload_id == upload.id,
                AgentMonthlyReportBuild.status.in_(
                    (
                        AgentMonthlyReportBuildStatus.queued.value,
                        AgentMonthlyReportBuildStatus.running.value,
                    )
                ),
            )
            .first()
        )
        if active is not None:
            # 运行中的任务不清理（其目录仍被 worker 使用）。
            continue
        if _safe_remove(upload_dir(settings, upload.id), root):
            counts["uploads_cleaned"] += 1

    # 5. 孤儿目录：没有数据库行、且早于超时窗口的残留（增量 A 的清理失败兜底）。
    counts["orphans_cleaned"] += _clean_orphans(db, settings, moment)
    return counts


def _clean_orphans(db: Session, settings: Settings, moment) -> int:
    root = settings.agent_monthly_report_root
    removed = 0
    builds_root = root / "builds"
    if builds_root.is_dir():
        known = {
            str(row)
            for (row,) in db.query(AgentMonthlyReportBuild.id).all()
        }
        for child in builds_root.iterdir():
            if not child.is_dir() or child.name in known:
                continue
            try:
                if child.stat().st_mtime > moment.timestamp() - 3600:
                    continue
            except OSError:
                continue
            if _safe_remove(child, root):
                removed += 1
    uploads_root = root / "uploads"
    if uploads_root.is_dir():
        known_uploads = {
            str(row) for (row,) in db.query(AgentMonthlyReportUpload.id).all()
        }
        for child in uploads_root.iterdir():
            if not child.is_dir() or child.name in known_uploads:
                continue
            try:
                if child.stat().st_mtime > moment.timestamp() - 3600:
                    continue
            except OSError:
                continue
            if _safe_remove(child, root):
                removed += 1
    return removed


__all__ = ["sweep"]
