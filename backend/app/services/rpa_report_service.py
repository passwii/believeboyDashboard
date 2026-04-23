from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, Project
from app.models.return_analysis import ReturnAnalysisRecord
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
    has_data: bool  # 有真实业务数据（非标记行）
    is_uploaded: bool  # 有任何上传记录（真实行 OR 标记行）= RPA 应显示绿色
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
    """Query RPA report status for a given date."""
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

    # Build a map: (project_id, report_type) -> latest row
    status_by_project: dict[int, dict[str, ReportTypeStatus]] = {
        pid: {rt: ReportTypeStatus(report_type=rt, has_data=False, is_uploaded=False) for rt in REPORT_TYPES}
        for pid in project_ids
    }

    # Query: for each project+type, get latest row covering the date
    for rt in REPORT_TYPES:
        if rt == "payment_report":
            # payment_report covers a period — match if period_start <= date <= period_end
            stmt = (
                select(AnalysisSourceFile)
                .where(AnalysisSourceFile.project_id.in_(project_ids))
                .where(AnalysisSourceFile.report_type == rt)
                .where(AnalysisSourceFile.country == country)
                .where(AnalysisSourceFile.period_start_date.isnot(None))
                .where(AnalysisSourceFile.period_end_date.isnot(None))
                .where(AnalysisSourceFile.period_start_date <= target_date)
                .where(AnalysisSourceFile.period_end_date >= target_date)
                .order_by(AnalysisSourceFile.updated_at.desc())
            )
        elif rt == "return_report":
            # return_report data lives in return_analysis_records
            # Real data: match by business return_date
            real_stmt = (
                select(ReturnAnalysisRecord)
                .where(ReturnAnalysisRecord.project_id.in_(project_ids))
                .where(ReturnAnalysisRecord.country == country)
                .where(ReturnAnalysisRecord.return_date == report_date)
                .where(ReturnAnalysisRecord.is_upload_marker == False)
                .order_by(ReturnAnalysisRecord.updated_at.desc())
            )
            real_rows = db.execute(real_stmt).scalars().all()

            # Marker: match by upload_marker_date (upload status date, not business date)
            marker_stmt = (
                select(ReturnAnalysisRecord)
                .where(ReturnAnalysisRecord.project_id.in_(project_ids))
                .where(ReturnAnalysisRecord.country == country)
                .where(ReturnAnalysisRecord.upload_marker_date == report_date)
                .where(ReturnAnalysisRecord.is_upload_marker == True)
            )
            marker_exists = db.execute(
                marker_stmt.limit(1)
            ).scalar_one_or_none() is not None

            for row in real_rows:
                pid = int(row.project_id)
                if pid in status_by_project:
                    status_by_project[pid][rt] = ReportTypeStatus(
                        report_type=rt,
                        has_data=True,
                        is_uploaded=True,
                        latest_date=row.return_date,
                        original_filename=None,
                    )

            for pid in project_ids:
                if status_by_project[pid][rt].is_uploaded is False and marker_exists:
                    status_by_project[pid][rt] = ReportTypeStatus(
                        report_type=rt,
                        has_data=False,
                        is_uploaded=True,
                        latest_date=report_date,
                        original_filename=None,
                    )
            continue
        else:
            # Real data: exact match on business report_date
            real_stmt = (
                select(AnalysisSourceFile)
                .where(AnalysisSourceFile.project_id.in_(project_ids))
                .where(AnalysisSourceFile.report_type == rt)
                .where(AnalysisSourceFile.country == country)
                .where(AnalysisSourceFile.report_date == target_date)
                .where(AnalysisSourceFile.is_upload_marker == False)
                .order_by(AnalysisSourceFile.updated_at.desc())
            )
            # Marker: match by upload_marker_date (upload status date, not business date)
            marker_stmt = (
                select(AnalysisSourceFile)
                .where(AnalysisSourceFile.project_id.in_(project_ids))
                .where(AnalysisSourceFile.report_type == rt)
                .where(AnalysisSourceFile.country == country)
                .where(AnalysisSourceFile.upload_marker_date == target_date)
                .where(AnalysisSourceFile.is_upload_marker == True)
                .limit(1)
            )

            real_rows = db.execute(real_stmt).scalars().all()
            marker_exists = db.execute(marker_stmt).scalar_one_or_none() is not None

            for row in real_rows:
                pid = int(row.project_id)
                if pid in status_by_project and not status_by_project[pid][rt].has_data:
                    status_by_project[pid][rt] = ReportTypeStatus(
                        report_type=rt,
                        has_data=True,
                        is_uploaded=True,
                        latest_date=row.report_date.isoformat() if row.report_date else None,
                        original_filename=row.original_filename,
                    )

            for pid in project_ids:
                if status_by_project[pid][rt].is_uploaded is False and marker_exists:
                    status_by_project[pid][rt] = ReportTypeStatus(
                        report_type=rt,
                        has_data=False,
                        is_uploaded=True,
                        latest_date=target_date.isoformat() if target_date else None,
                        original_filename=None,
                    )
            continue

        rows = db.execute(stmt).scalars().all()

        for row in rows:
            pid = int(row.project_id)
            if pid in status_by_project and not status_by_project[pid][rt].has_data:
                display_date = None
                if rt == "payment_report":
                    display_date = (
                        row.period_end_date.isoformat()
                        if row.period_end_date
                        else None
                    )
                else:
                    display_date = (
                        row.report_date.isoformat() if row.report_date else None
                    )
                status_by_project[pid][rt] = ReportTypeStatus(
                    report_type=rt,
                    has_data=True,
                    is_uploaded=True,
                    latest_date=display_date,
                    original_filename=row.original_filename,
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