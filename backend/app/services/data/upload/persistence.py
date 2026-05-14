from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.schemas.upload import (
    ReportCommitRequest,
    ReportCommitResponse,
    ReportProjectMatchSummary,
)
from app.models import ReportUploadStatus
from app.services.data.upload.recognition import recognize_saved_report_upload
from app.services.product.persistence import (
    _get_project_by_name,
    persist_single_analysis_source,
)
from app.services.product.sales import persist_sales_report_by_purchase_date
from app.services import project_service
from app.services import upload_service
from app.services.infra import invalidate_daily_analysis_cache as _invalidate_daily_analysis_cache
from app.services.report_type_service import AD_PRODUCT_REPORT, normalize_report_type
from app.utils.constants import SUPPORTED_REPORT_TYPES
from app.utils.country import normalize_country as _normalize_country
from app.utils.date_utils import parse_yyyy_mm_dd as _parse_yyyy_mm_dd


def commit_report_upload(
    db: Session,
    settings: Settings,
    *,
    payload: ReportCommitRequest,
    operator: str | None = None,
    is_admin: bool = True,
) -> ReportCommitResponse:
    recognition: ReportRecognitionResponse | None = None
    project_match: ReportProjectMatchSummary | None = None
    report_type = normalize_report_type(payload.report_type)
    if report_type not in SUPPORTED_REPORT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported report_type: {report_type}",
        )

    country = _normalize_country(payload.country)
    raw_project_name = (payload.project_name or "").strip()

    is_auto_commit = not raw_project_name

    allowed_projects = {
        str(item.project_name)
        for item in project_service.list_project_items(db, operator=operator, is_admin=is_admin)
    }

    if is_auto_commit:
        if report_type != "ad_search_term_report":
            auto_recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if auto_recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{auto_recognition.reason}",
                )
            recognized_type = normalize_report_type(auto_recognition.report_type)
            if recognized_type != report_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if report_type in {"sales_report", "inventory_report", "business_report", AD_PRODUCT_REPORT, "payment_report", "return_report"} and auto_recognition.country != country:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"文件站点（{auto_recognition.country}）与所选站点（{country}）不一致，"
                        "请确认后重新上传到对应站点"
                    ),
                )
            auto_project_match = auto_recognition.project_match
            if auto_project_match.status != "matched" or not auto_project_match.project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            project_name = auto_project_match.project_name
            if project_name not in allowed_projects:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
                )
            recognition = auto_recognition
            project_match = auto_project_match

    else:
        project_name = raw_project_name
        if project_name not in allowed_projects:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="无权限访问该项目"
            )
        if report_type != "ad_search_term_report":
            recognition = recognize_saved_report_upload(
                db,
                settings,
                temp_file_id=payload.temp_file_id,
                original_filename=(
                    payload.original_filename or payload.temp_file_id
                ).strip(),
                country=country,
                operator=operator,
                is_admin=is_admin,
            )
            if recognition.status != "recognized":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"文件识别失败，无法确认项目归属：{recognition.reason}",
                )
            recognized_type = normalize_report_type(recognition.report_type)
            if recognized_type != report_type:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="report_type does not match recognized report",
                )
            if report_type in {"sales_report", "inventory_report", "business_report", AD_PRODUCT_REPORT, "payment_report", "return_report"} and recognition.country != country:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"文件站点（{recognition.country}）与所选站点（{country}）不一致，"
                        "请确认后重新上传到对应站点"
                    ),
                )
            project_match = recognition.project_match
            if project_match.status != "matched" or not project_match.project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="文件未匹配到唯一项目，请先确认文件归属后再入库",
                )
            if project_match.project_name != project_name:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        "文件匹配项目与当前选择不一致："
                        f"文件匹配为 {project_match.project_name}，当前选择为 {project_name}"
                    ),
                )

    original_filename = (
        payload.original_filename or ""
    ).strip() or payload.temp_file_id
    file_meta = upload_service.finalize_report_upload_temp_file(
        settings,
        temp_file_id=payload.temp_file_id,
        original_filename=original_filename,
        project_name=project_name,
        file_type=report_type,
    )

    persisted_source_id: int | None = None
    persisted_table: str | None = None
    response_status: str = "saved"
    message = "文件已保存"

    if report_type == "inventory_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            if recognition and recognition.detected_date:
                report_date = recognition.detected_date
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="inventory_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "库存报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "库存报表已保存并写入库存源数据"
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "business_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="business_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            report_start_date=report_date,
            report_end_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "业务报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "业务报表已保存并写入业务源数据"
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == AD_PRODUCT_REPORT:
        report_date = (payload.report_date or "").strip()
        if not report_date:
            if recognition and recognition.detected_date:
                report_date = recognition.detected_date
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        outcome = persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type=AD_PRODUCT_REPORT,
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_date=report_date,
            report_start_date=report_date,
            report_end_date=report_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "广告报表入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "广告报表已保存并写入分析广告源数据"
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "sales_report":
        outcome = persist_sales_report_by_purchase_date(
            db,
            project_name=project_name,
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            created_by=operator,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "销售报表入库失败"),
            )
        persisted_source_id = outcome.get("latest_source_id")
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = (
            outcome.get("message") or "销售报表已按购买日期拆分并写入分析销售源数据"
        )
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "payment_report":
        start_date = (payload.report_start_date or "").strip()
        end_date = (payload.report_end_date or "").strip()
        if not start_date or not end_date:
            raise HTTPException(
                status_code=422,
                detail="report_start_date and report_end_date are required",
            )
        outcome = persist_single_analysis_source(
            db,
            project_name=project_name,
            report_type="payment_report",
            country=country,
            upload_file_id=file_meta["file_id"],
            upload_file_path=file_meta["file_path"],
            report_start_date=start_date,
            report_end_date=end_date,
            created_by=operator,
        )
        if not outcome.success:
            raise HTTPException(
                status_code=400, detail=outcome.error_message or "付款报告入库失败"
            )
        persisted_source_id = outcome.source_id
        persisted_table = "analysis_source_files"
        response_status = "persisted"
        message = "付款报告已保存并写入付款源数据"
        project = _get_project_by_name(db, project_name)
        _invalidate_daily_analysis_cache(project.id)
    elif report_type == "ad_search_term_report":
        report_date = (payload.report_date or "").strip()
        if not report_date:
            raise HTTPException(status_code=422, detail="report_date is required")
        persisted_source_id = upsert_file_only_report_status(
            db,
            project_name=project_name,
            report_type="ad_search_term_report",
            report_date=report_date,
            country=country,
            file_id=str(file_meta["file_id"]),
            file_path=str(file_meta["file_path"]),
            original_filename=str(file_meta["original_filename"]),
            created_by=operator,
        )
        persisted_table = "report_upload_statuses"
        message = "搜索词报表已保存，本期不拆行落库"
    elif report_type == "return_report":
        from app.services.analysis.return_analysis import persist_return_report

        outcome = persist_return_report(
            db,
            project_name=project_name,
            country=country,
            file_path=str(file_meta["file_path"]),
            created_by=operator,
        )
        if not outcome["success"]:
            raise HTTPException(
                status_code=400,
                detail=str(outcome.get("error_message") or "退货报表入库失败"),
            )
        persisted_source_id = outcome.get("source_id")
        persisted_table = "return_analysis_records"
        response_status = "persisted"
        payload.report_start_date = outcome.get("report_start_date")
        payload.report_end_date = outcome.get("report_end_date")
        message = outcome.get("message") or "退货报表已保存并写入退货数据"

    return ReportCommitResponse(
        report_type=report_type,
        status=response_status,
        project_name=project_name,
        country=country,
        report_date=payload.report_date,
        report_start_date=payload.report_start_date,
        report_end_date=payload.report_end_date,
        file_id=str(file_meta["file_id"]),
        file_path=str(file_meta["file_path"]),
        persisted_source_id=persisted_source_id,
        persisted_table=persisted_table,
        message=message,
    )


def upsert_file_only_report_status(
    db: Session,
    *,
    project_name: str,
    report_type: str,
    report_date: str,
    country: str,
    file_id: str,
    file_path: str,
    original_filename: str,
    created_by: str | None,
) -> int:
    if report_type != "ad_search_term_report":
        raise ValueError(f"Unsupported file-only report_type: {report_type}")

    ReportUploadStatus.__table__.create(bind=db.get_bind(), checkfirst=True)
    project = _get_project_by_name(db, project_name)
    target_date = _parse_yyyy_mm_dd(
        report_date, "report_date"
    )
    row = (
        db.execute(
            select(ReportUploadStatus).where(
                ReportUploadStatus.project_id == project.id,
                ReportUploadStatus.report_type == report_type,
                ReportUploadStatus.country == country,
                ReportUploadStatus.report_date == target_date,
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        row = ReportUploadStatus(
            project_id=project.id,
            report_type=report_type,
            country=country,
            report_date=target_date,
            upload_file_id=file_id,
            upload_file_path=file_path,
            original_filename=original_filename,
            stored_filename=file_id,
            file_size_bytes=Path(file_path).stat().st_size
            if Path(file_path).exists()
            else None,
            created_by=(created_by or "").strip()[:255] or None,
        )
        db.add(row)
    else:
        row.upload_file_id = file_id
        row.upload_file_path = file_path
        row.original_filename = original_filename
        row.stored_filename = file_id
        row.file_size_bytes = (
            Path(file_path).stat().st_size if Path(file_path).exists() else None
        )
        row.created_by = (created_by or "").strip()[:255] or row.created_by

    db.commit()
    db.refresh(row)
    return int(row.id)
