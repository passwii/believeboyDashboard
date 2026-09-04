from __future__ import annotations

from datetime import date, datetime

from fastapi import HTTPException
from sqlalchemy import inspect, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, SkuRecord, ReportUploadStatus
from app.schemas.upload import (
    ProjectReportStatusItem,
    ReportStatusCell,
    ReportStatusResponse,
)
import app.services.project_service as project_service
from app.services.report_type_service import AD_PRODUCT_REPORT
from app.utils.country import normalize_country as _normalize_country

STATUS_REPORT_TYPES = [
    "inventory_report",
    "business_report",
    AD_PRODUCT_REPORT,
    "ad_search_term_report",
    "sales_report",
    "payment_report",
    "return_report",
]


def _status_cell(
    *,
    report_type: str,
    status: str = "missing",
    display_date: str | None = None,
    report_start_date: str | None = None,
    report_end_date: str | None = None,
    source_table: str | None = None,
    updated_at: datetime | None = None,
    original_filename: str | None = None,
    message: str | None = None,
) -> ReportStatusCell:
    return ReportStatusCell(
        report_type=report_type,
        status=status,
        display_date=display_date,
        report_start_date=report_start_date,
        report_end_date=report_end_date,
        source_table=source_table,
        updated_at=updated_at.isoformat(timespec="seconds") if updated_at else None,
        original_filename=original_filename,
        message=message,
    )


def list_report_upload_statuses(
    db: Session,
    *,
    report_date: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
    country: str = "US",
) -> ReportStatusResponse:
    projects = project_service.list_project_items(
        db, operator=operator, is_admin=is_admin
    )
    project_map = {int(project.id): project.project_name for project in projects}
    project_sort_orders = {int(project.id): project.sort_order for project in projects}
    normalized_country = _normalize_country(country)
    if not project_map:
        return ReportStatusResponse(country=normalized_country, items=[])

    project_ids = list(project_map.keys())
    eligible_project_names = {
        str(name)
        for name in db.execute(
            select(SkuRecord.project_name)
            .where(SkuRecord.country == normalized_country)
            .where(SkuRecord.is_active.is_(True))
            .distinct()
        )
        .scalars()
        .all()
        if name
    }
    if eligible_project_names:
        project_ids = [
            project_id
            for project_id in project_ids
            if project_map[project_id] in eligible_project_names
        ]
    else:
        project_ids = []
    target_report_date: date | None = None
    if report_date:
        try:
            target_report_date = datetime.strptime(report_date, "%Y-%m-%d").date()
        except ValueError as error:
            raise HTTPException(
                status_code=400, detail="report_date must be YYYY-MM-DD"
            ) from error

    analysis_stmt = (
        select(AnalysisSourceFile)
        .where(AnalysisSourceFile.project_id.in_(project_ids))
        .where(AnalysisSourceFile.country == normalized_country)
    )
    if target_report_date is not None:
        analysis_stmt = analysis_stmt.where(
            (AnalysisSourceFile.report_date == target_report_date)
            | (
                (AnalysisSourceFile.report_type == "payment_report")
                & (AnalysisSourceFile.report_date.is_(None))
                & (AnalysisSourceFile.period_start_date.is_not(None))
                & (AnalysisSourceFile.period_end_date.is_not(None))
                & (AnalysisSourceFile.period_start_date <= target_report_date)
                & (AnalysisSourceFile.period_end_date >= target_report_date)
            )
        )
        analysis_stmt = analysis_stmt.order_by(
            AnalysisSourceFile.updated_at.desc(),
            AnalysisSourceFile.id.desc(),
        )
    else:
        analysis_stmt = analysis_stmt.where(AnalysisSourceFile.is_current.is_(True))
    analysis_rows = db.execute(analysis_stmt).scalars().all()
    file_only_rows: list[ReportUploadStatus] = []
    try:
        if inspect(db.get_bind()).has_table("report_upload_statuses"):
            file_only_stmt = (
                select(ReportUploadStatus)
                .where(ReportUploadStatus.project_id.in_(project_ids))
                .where(ReportUploadStatus.country == normalized_country)
            )
            if target_report_date is not None:
                file_only_stmt = file_only_stmt.where(
                    ReportUploadStatus.report_date == target_report_date
                )
            file_only_rows = db.execute(file_only_stmt).scalars().all()
    except ProgrammingError:
        db.rollback()
        file_only_rows = []

    status_by_project: dict[int, dict[str, ReportStatusCell]] = {
        project_id: {
            report_type: _status_cell(report_type=report_type)
            for report_type in STATUS_REPORT_TYPES
        }
        for project_id in project_ids
    }

    seen_status_keys: set[tuple[int, str]] = set()
    for row in analysis_rows:
        status_key = (int(row.project_id), str(row.report_type))
        if status_key in seen_status_keys:
            continue
        seen_status_keys.add(status_key)
        display_date = (
            (target_report_date or row.report_date or row.period_end_date).isoformat()
            if (target_report_date or row.report_date or row.period_end_date)
            else None
        )
        is_period_match = (
            target_report_date is not None
            and row.report_type == "payment_report"
            and row.report_date is None
            and row.period_start_date is not None
            and row.period_end_date is not None
            and row.period_start_date <= target_report_date <= row.period_end_date
        )
        message = (
            "历史周期数据已入库"
            if is_period_match
            else ("当日已入库" if target_report_date is not None else "当前版本")
        )
        status_by_project[int(row.project_id)][row.report_type] = _status_cell(
            report_type=row.report_type,
            status="available",
            display_date=display_date,
            report_start_date=(row.report_date or row.period_start_date).isoformat()
            if (row.report_date or row.period_start_date)
            else None,
            report_end_date=(row.report_date or row.period_end_date).isoformat()
            if (row.report_date or row.period_end_date)
            else None,
            source_table="analysis_source_files",
            updated_at=row.updated_at,
            original_filename=row.original_filename,
            message=message,
        )

    for row in file_only_rows:
        display_date = row.report_date.isoformat()
        status_by_project[int(row.project_id)][row.report_type] = _status_cell(
            report_type=row.report_type,
            status="saved_only",
            display_date=display_date,
            report_start_date=display_date,
            report_end_date=display_date,
            source_table="report_upload_statuses",
            updated_at=row.updated_at,
            original_filename=row.original_filename,
            message="当日仅保存文件，未拆分明细"
            if target_report_date is not None
            else "仅保存文件，未拆分明细",
        )

    items = [
        ProjectReportStatusItem(
            project_id=project_id,
            project_name=project_map[project_id],
            statuses=status_by_project[project_id],
        )
        for project_id in sorted(project_ids, key=lambda item: (project_sort_orders.get(item, 0), project_map[item]))
    ]
    return ReportStatusResponse(country=normalized_country, items=items)
