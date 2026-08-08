"""调度前"当日是否有写文件动作"门禁（BLF-533）。

判断订阅覆盖的项目/国家在目标日期（日报=调度日当天；周报/月报=覆盖周期内
任一日期）是否有"写文件动作"——依据 autoReportUpload 的 Write Log：

- 判据一（主）：``report_upload_logs``——RPA 状态页的权威来源（priority 1），
  按 ``project_id + upload_date + country`` 精确匹配（写入当天语义）。
- 判据二（兜底）：``auto_report_upload_logs``——autoReportUpload 服务
  ``RunLogger.result()`` 每处理一个文件写一行（含 success/skipped/failed），
  覆盖 report_upload_logs 未写入的路径；按 ``project_name + created_at + country``。

用户拍板（2026-08-08）：
1. 项目维度：**全部**项目都需有写动作才推进；
2. 多国家：**全部**国家都需有写动作才推进；
3. 周报/月报：覆盖周期内**任一日期**有写动作即可；
4. 无写动作时 delivery_log 标 ``failed`` + error_message（台账显示"失败"，可补发）；
5. 历史回填：需做一次性回填（见 scripts/backfill_no_write_action_ledger.py）。
"""

from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.auto_report_upload_log import AutoReportUploadLog
from app.models.project import Project
from app.models.report_upload_log import ReportUploadLog
from app.services.scheduled_report.report_builder_monthly import _get_report_month
from app.services.scheduled_report.report_builder_weekly import (
    _get_previous_natural_week,
)

logger = logging.getLogger(__name__)

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


def coverage_date_range(frequency: str, report_date: str) -> tuple[date, date]:
    """返回订阅调度日对应报告的数据覆盖日期范围。

    - daily:   调度日当天（[report_date, report_date]）
    - weekly:  调度日所在周的上一个自然周（周一~周日）
    - monthly: 调度日所在月的上一个自然月

    与 report_builder 的数据锚定逻辑保持一致：周报/月报锚定 reference_date
    本身，其覆盖范围即上一个完整自然周/自然月。
    """
    ref = date.fromisoformat(report_date)
    if frequency == "weekly":
        return _get_previous_natural_week(ref)
    if frequency == "monthly":
        return _get_report_month(ref)
    return ref, ref


def _iter_dates(start: date, end: date) -> Iterable[date]:
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def resolve_project_ids(db: Session, project_ids: list[int] | None) -> list[int]:
    """订阅 project_ids（None="*" 全部项目）→ 实际项目 ID 列表。"""
    if project_ids:
        return list(project_ids)
    rows = db.execute(select(Project.id)).scalars().all()
    return list(rows)


def _project_names_for(db: Session, project_ids: list[int]) -> dict[int, str]:
    rows = db.execute(
        select(Project.id, Project.project_name).where(Project.id.in_(project_ids))
    ).all()
    return {int(pid): (name or "") for pid, name in rows}


def _has_report_upload_log(
    db: Session, project_id: int, country: str, dates: list[date]
) -> bool:
    """判据一：report_upload_logs 当天是否有上传记录（任一日期命中即可）。"""
    row = db.execute(
        select(ReportUploadLog.id)
        .where(ReportUploadLog.project_id == project_id)
        .where(ReportUploadLog.country == country)
        .where(ReportUploadLog.upload_date.in_(dates))
        .limit(1)
    ).first()
    return row is not None


def _has_auto_upload_log(
    db: Session, project_name: str, country: str, start: date, end: date
) -> bool:
    """判据二：auto_report_upload_logs 在覆盖周期内是否有处理文件记录（兜底）。

    created_at 落在 [start 00:00, end 23:59:59]（上海时区）。country 大小写
    归一后比较（autoReportUpload 写入的是大写国家码）。
    """
    start_dt = datetime.combine(start, time.min, tzinfo=SHANGHAI_TZ)
    end_dt = datetime.combine(end + timedelta(days=1), time.min, tzinfo=SHANGHAI_TZ)
    row = db.execute(
        select(AutoReportUploadLog.id)
        .where(AutoReportUploadLog.project_name == project_name)
        .where(
            or_(
                AutoReportUploadLog.country == country,
                AutoReportUploadLog.country.is_(None),
            )
        )
        .where(AutoReportUploadLog.created_at >= start_dt)
        .where(AutoReportUploadLog.created_at < end_dt)
        .limit(1)
    ).first()
    return row is not None


def has_write_action(
    db: Session,
    *,
    project_ids: list[int] | None,
    country: str,
    frequency: str,
    report_date: str,
) -> bool:
    """判断订阅在报告覆盖范围内是否有写文件动作（全部项目 × 全部国家）。

    Args:
        project_ids: 订阅覆盖项目（None="*" 全部项目）。
        country: 订阅国家（逗号分隔，如 "US,DE"；全部国家都要有写动作）。
        frequency: daily / weekly / monthly。
        report_date: 调度日（YYYY-MM-DD）。

    Returns:
        True = 覆盖范围内所有（项目, 国家）组合都有写文件动作，可推进调度。
    """
    try:
        pids = resolve_project_ids(db, project_ids)
        if not pids:
            logger.warning(
                "has_write_action: 无有效项目（project_ids=%s），视为有数据放行",
                project_ids,
            )
            return True

        countries = [c.strip().upper() for c in country.split(",") if c.strip()]
        if not countries:
            countries = ["US"]

        start, end = coverage_date_range(frequency, report_date)
        dates = list(_iter_dates(start, end))
        names_by_id = _project_names_for(db, pids)

        for pid in pids:
            project_name = names_by_id.get(pid, "")
            for c in countries:
                if _has_report_upload_log(db, pid, c, dates):
                    continue
                if project_name and _has_auto_upload_log(
                    db, project_name, c, start, end
                ):
                    continue
                logger.info(
                    "has_write_action: 项目 %s (id=%s) 国家 %s 在 %s~%s 无写文件动作",
                    project_name or pid,
                    pid,
                    c,
                    start,
                    end,
                )
                return False
        return True
    except Exception as exc:  # noqa: BLE001 — 门禁异常不应阻断正常调度
        logger.error("has_write_action 查询失败，视为有数据放行: %s", exc)
        return True


__all__ = [
    "coverage_date_range",
    "has_write_action",
    "resolve_project_ids",
]
