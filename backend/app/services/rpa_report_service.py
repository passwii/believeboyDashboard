from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, Project, ReportUploadLog
from app.services import project_service

REPORT_TYPES = [
    # 已接入
    "inventory_report",      # 库存
    "business_report",        # 业务
    "ad_product_report",      # 广告
    "sales_report",           # 销售
    "payment_report",         # 付款
    "return_report",          # 退货
    # 预留（未来报表类型）
    "storage_report",         # 仓储
    "returns_detail_report",  # 退货明细
    "fba_inventory_report",   # FBA库存
    "reimbursement_report",   # 赔偿
    "tax_invoice_report",     # 税务发票
    "health_report",          # 健康报告
    "advertising_reports",    # 广告报表
    "brand_report",           # 品牌报表
    "vendor_report",          # 供应商报表
]


@dataclass
class ReportTypeStatus:
    report_type: str
    has_data: bool  # 有真实业务数据
    is_uploaded: bool  # 今日是否有上传记录
    latest_date: Optional[str] = None
    original_filename: Optional[str] = None


@dataclass
class ProjectReportStatus:
    project_id: int
    project_name: str
    country: str
    statuses: list[ReportTypeStatus]


@dataclass
class RpaReportStatusResponse:
    country: str
    items: list[ProjectReportStatus]


def get_report_status_for_date(
    db: Session,
    *,
    report_date: str,
    country: str = "US",
    operator: Optional[str] = None,
    is_admin: bool = True,
) -> RpaReportStatusResponse:
    """Query RPA report status for a given date using report_upload_logs.

    Unified logic for all report types:
    1. Check report_upload_logs for today's upload record
    2. Optionally fetch original_filename from linked source_file
    """
    try:
        target_date = date.fromisoformat(report_date)
    except ValueError:
        target_date = None

    projects = project_service.list_project_items(
        db, operator=operator, is_admin=is_admin
    )
    project_map = {int(p.id): p.project_name for p in projects}
    project_ids = list(project_map.keys())

    if not project_ids:
        return RpaReportStatusResponse(country=country, items=[])

    # Build default status map
    status_by_project: dict[int, dict[str, ReportTypeStatus]] = {
        pid: {rt: ReportTypeStatus(report_type=rt, has_data=False, is_uploaded=False) for rt in REPORT_TYPES}
        for pid in project_ids
    }

    if target_date is None:
        items = [
            ProjectReportStatus(
                project_id=pid,
                project_name=project_map[pid],
                country=country,
                statuses=list(status_by_project[pid].values()),
            )
            for pid in sorted(
                project_ids,
                key=lambda pid: next(
                    (p.sort_order for p in projects if int(p.id) == pid), 0
                ),
            )
        ]
        return RpaReportStatusResponse(country=country, items=items)

    # Unified query: fetch all upload logs for target date
    logs = db.execute(
        select(ReportUploadLog)
        .where(ReportUploadLog.project_id.in_(project_ids))
        .where(ReportUploadLog.country == country)
        .where(ReportUploadLog.upload_date == target_date)
    ).scalars().all()

    # Group by (project_id, report_type) — keep latest if multiple
    log_map: dict[tuple[int, str], ReportUploadLog] = {}
    for log in logs:
        key = (int(log.project_id), log.report_type)
        if key not in log_map or log.created_at > log_map[key].created_at:
            log_map[key] = log

    # Populate status from upload logs (priority 1)
    for (pid, rt), log in log_map.items():
        if pid not in status_by_project:
            continue
        original_filename = None
        if log.source_file_id:
            source = db.execute(
                select(AnalysisSourceFile).where(AnalysisSourceFile.id == log.source_file_id)
            ).scalar_one_or_none()
            if source:
                original_filename = source.original_filename

        status_by_project[pid][rt] = ReportTypeStatus(
            report_type=rt,
            has_data=log.has_real_data,
            is_uploaded=True,
            latest_date=report_date,
            original_filename=original_filename,
        )

    # ── Fallback: query analysis_source_files for date coverage ──
    # Priority 2: if no upload_log, check actual source file rows by business date.
    # This turns previously red (missing) markers green when data actually exists.
    missing_pairs = [
        (pid, rt)
        for pid in project_ids
        for rt, st in status_by_project[pid].items()
        if not st.is_uploaded
    ]
    if missing_pairs and target_date is not None:
        sources = db.execute(
            select(AnalysisSourceFile)
            .where(AnalysisSourceFile.project_id.in_(project_ids))
            .where(AnalysisSourceFile.country == country)
            .where(AnalysisSourceFile.is_current.is_(True))
            .where(AnalysisSourceFile.ingestion_status == "success")
            .where(
                or_(
                    # Periodic reports: target_date within [period_start, period_end]
                    and_(
                        AnalysisSourceFile.report_type.in_([
                            "business_report",
                            "payment_report",
                            "ad_product_report",
                            "sales_report",
                            "return_report",
                        ]),
                        AnalysisSourceFile.period_start_date.isnot(None),
                        AnalysisSourceFile.period_end_date.isnot(None),
                        AnalysisSourceFile.period_start_date <= target_date,
                        AnalysisSourceFile.period_end_date >= target_date,
                    ),
                    # Inventory snapshot: snapshot_at date matches target_date
                    and_(
                        AnalysisSourceFile.report_type == "inventory_report",
                        func.date(AnalysisSourceFile.snapshot_at) == target_date,
                    ),
                )
            )
        ).scalars().all()

        # Keep latest source per (project_id, report_type)
        source_map: dict[tuple[int, str], AnalysisSourceFile] = {}
        for src in sources:
            key = (int(src.project_id), src.report_type)
            if key not in source_map or src.created_at > source_map[key].created_at:
                source_map[key] = src

        for (pid, rt), src in source_map.items():
            if pid not in status_by_project:
                continue
            if status_by_project[pid][rt].is_uploaded:
                continue  # log already covered
            status_by_project[pid][rt] = ReportTypeStatus(
                report_type=rt,
                has_data=src.row_count_total > 0,
                is_uploaded=True,
                latest_date=report_date,
                original_filename=src.original_filename,
            )

    items = [
        ProjectReportStatus(
            project_id=pid,
            project_name=project_map[pid],
            country=country,
            statuses=list(status_by_project[pid].values()),
        )
        for pid in sorted(
            project_ids,
            key=lambda pid: next(
                (p.sort_order for p in projects if int(p.id) == pid), 0
            ),
        )
    ]
    return RpaReportStatusResponse(country=country, items=items)
