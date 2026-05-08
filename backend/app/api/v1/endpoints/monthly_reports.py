from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from time import perf_counter
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.models.job import JobStatus
from app.schemas.monthly_report import (
    MonthlyFinancialAccountingDetailResponse,
    CreateMonthlyReportRequest,
    MonthlyFinancialSeriesResponse,
    MonthlyReportDetailResponse,
    MonthlyReportListItem,
    MonthlyReportResponse,
    MonthlyReportTaskStatusResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services import (
    monthly_report_runtime_service,
    monthly_report_service,
    payment_report_locale,
    project_service,
    upload_service,
)
from app.services.redis_service import (
    get_financial_series_cache,
    invalidate_financial_series_cache,
    set_financial_series_cache,
)

router = APIRouter(dependencies=[Depends(protected)])


@router.post("/monthly-reports", response_model=MonthlyReportResponse)
def create_monthly_report(
    data: CreateMonthlyReportRequest,
    request: Request,
    response: Response,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> MonthlyReportResponse:
    started_at = perf_counter()
    monthly_report_service.parse_report_month(data.report_month)

    provided_project_name = (data.project_name or "").strip()
    if not provided_project_name:
        raise HTTPException(status_code=422, detail="project_name is required")

    project_id = data.project_id
    project_name = provided_project_name
    try:
        country = payment_report_locale.normalize_country(data.country)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    after_project = perf_counter()

    transaction_path = upload_service.build_upload_file_path(
        settings,
        project_name,
        "payment_report",
        data.transaction_file_id,
    )
    summary_pdf_path = (
        upload_service.build_upload_file_path(
            settings,
            project_name,
            "monthly_summary_pdf",
            data.summary_pdf_file_id,
        )
        if data.summary_pdf_file_id
        else None
    )
    after_resolve_paths = perf_counter()

    # ── Foolproof: validate payment report CSV matches selected project & country ──
    validation = monthly_report_service.validate_payment_report_project_match(
        db,
        transaction_file_path=str(transaction_path),
        selected_project_name=project_name,
        selected_country=country,
    )
    if not validation.get("valid", True):
        error_detail = "；".join(validation.get("errors", ["文件校验失败"]))
        raise HTTPException(status_code=400, detail=error_detail)
    if validation.get("warnings"):
        append_operation_audit_log(
            db,
            action="monthly_reports.validation_warning",
            target_type="monthly_report_validation",
            target_id=None,
            operator=operator,
            after={
                "project_name": project_name,
                "country": country,
                "warnings": validation["warnings"],
            },
            request=request,
        )
    after_validation = perf_counter()

    task = monthly_report_runtime_service.create_task(
        settings,
        project_id=project_id,
        project_name=project_name,
        country=country,
        report_month=data.report_month.strip(),
        transaction_file_id=data.transaction_file_id,
        summary_pdf_file_id=data.summary_pdf_file_id,
        resolved_file_paths={
            "transaction_report": str(transaction_path),
            **(
                {"monthly_summary_pdf": str(summary_pdf_path)}
                if summary_pdf_path
                else {}
            ),
        },
    )
    append_operation_audit_log(
        db,
        action="monthly_reports.create",
        target_type="monthly_report_task",
        target_id=task.id,
        operator=operator,
        after={
            "job_id": task.id,
            "project_id": project_id,
            "project_name": project_name,
            "country": country,
            "report_month": data.report_month.strip(),
        },
        request=request,
    )
    db.commit()
    after_enqueue_job = perf_counter()
    validation_ms = int((after_validation - after_resolve_paths) * 1000)
    enqueue_ms = int((after_enqueue_job - after_validation) * 1000)
    total_ms = int((after_enqueue_job - started_at) * 1000)
    if response is not None:
        response.headers["X-Monthly-Create-Total-Ms"] = str(total_ms)
        response.headers["X-Monthly-Create-Project-Ms"] = str(
            int((after_project - started_at) * 1000)
        )
        response.headers["X-Monthly-Create-Resolve-Ms"] = str(
            int((after_resolve_paths - after_project) * 1000)
        )
        response.headers["X-Monthly-Create-Validation-Ms"] = str(validation_ms)
        response.headers["X-Monthly-Create-Enqueue-Ms"] = str(enqueue_ms)

    return MonthlyReportResponse(
        job_id=task.id,
        monthly_report_id=None,
        status_endpoint=f"/api/v1/monthly-reports/tasks/{task.id}",
        result_endpoint=f"/api/v1/monthly-reports/tasks/{task.id}/result",
        status=task.status,
        created_at=task.created_at,
    )


@router.get(
    "/monthly-reports/tasks/{task_id}", response_model=MonthlyReportTaskStatusResponse
)
def get_monthly_report_task(task_id: int) -> MonthlyReportTaskStatusResponse:
    task = monthly_report_runtime_service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    return MonthlyReportTaskStatusResponse(
        task_id=task.id,
        status=task.status,
        stage=task.stage,
        progress=task.progress,
        message=task.message,
        error_message=task.error_message,
        persistence_status=task.persistence_status,
        persistence_message=task.persistence_message,
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


@router.get("/monthly-reports/tasks/{task_id}/result")
def download_monthly_report_task_result(
    task_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
):
    task = monthly_report_runtime_service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status != JobStatus.success:
        raise HTTPException(status_code=409, detail="Task not finished")
    if not task.result_path:
        raise HTTPException(status_code=404, detail="Result file missing")

    result_path = Path(task.result_path)
    if not result_path.exists() or not result_path.is_file():
        raise HTTPException(status_code=404, detail="Result file missing")
    append_operation_audit_log(
        db,
        action="monthly_reports.result.export",
        target_type="monthly_report_task",
        target_id=task.id,
        operator=operator,
        after={"job_id": task.id, "filename": result_path.name},
        request=request,
    )
    db.commit()

    return FileResponse(path=str(result_path), filename=result_path.name)


@router.get("/monthly-reports", response_model=list[MonthlyReportListItem])
def list_monthly_reports(
    project_id: int | None = Query(default=None, gt=0),
    country: str | None = Query(default=None),
    month: str | None = Query(default=None),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> list[MonthlyReportListItem]:
    report_month = monthly_report_service.parse_report_month(month) if month else None
    normalized_country: str | None = None
    if country is not None:
        try:
            normalized_country = payment_report_locale.normalize_country(country)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    rows = monthly_report_service.list_reports(
        db,
        project_id=project_id,
        country=normalized_country,
        report_month=report_month,
        current_only=not include_history,
    )
    return [_to_report_item(row) for row in rows]


@router.get(
    "/monthly-reports/financial-series", response_model=MonthlyFinancialSeriesResponse
)
def get_monthly_financial_series(
    project_id: int = Query(gt=0),
    country: str = Query(default='US'),
    start_month: str | None = Query(default=None),
    end_month: str | None = Query(default=None),
    fill_missing: bool = Query(default=True),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> MonthlyFinancialSeriesResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    try:
        normalized_country = payment_report_locale.normalize_country(country)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    cached = get_financial_series_cache(project_id, normalized_country, start_month, end_month)
    if cached:
        return MonthlyFinancialSeriesResponse(**cached)

    payload = monthly_report_service.get_financial_series(
        db,
        project_id=project_id,
        country=normalized_country,
        start_month=start_month,
        end_month=end_month,
        fill_missing=fill_missing,
    )

    set_financial_series_cache(project_id, normalized_country, start_month, end_month, payload)

    return MonthlyFinancialSeriesResponse(**payload)


@router.post("/monthly-reports/financial-series/recalculate")
def recalculate_monthly_financial_series(
    project_id: int = Query(gt=0),
    country: str = Query(default='US'),
    start_month: str | None = Query(default=None),
    end_month: str | None = Query(default=None),
    fill_missing: bool = Query(default=True),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> MonthlyFinancialSeriesResponse:
    """重新核算月度财务数据：清除缓存后重新计算"""
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    try:
        normalized_country = payment_report_locale.normalize_country(country)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    invalidate_financial_series_cache(project_id)

    payload = monthly_report_service.get_financial_series(
        db,
        project_id=project_id,
        country=normalized_country,
        start_month=start_month,
        end_month=end_month,
        fill_missing=fill_missing,
    )

    set_financial_series_cache(project_id, normalized_country, start_month, end_month, payload)

    return MonthlyFinancialSeriesResponse(**payload)


@router.get(
    "/monthly-reports/financial-series/accounting-detail",
    response_model=MonthlyFinancialAccountingDetailResponse,
)
def get_monthly_financial_accounting_detail(
    project_id: int = Query(gt=0),
    country: str = Query(default='US'),
    report_month: str = Query(min_length=7, max_length=7),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> MonthlyFinancialAccountingDetailResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    try:
        normalized_country = payment_report_locale.normalize_country(country)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    payload = monthly_report_service.get_financial_accounting_detail(
        db,
        project_id=project_id,
        country=normalized_country,
        report_month=report_month,
    )
    return MonthlyFinancialAccountingDetailResponse(**payload)


@router.get("/monthly-reports/financial-series/accounting-detail/export")
def export_monthly_financial_accounting_detail(
    project_id: int = Query(gt=0),
    country: str = Query(default='US'),
    report_month: str = Query(min_length=7, max_length=7),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    try:
        normalized_country = payment_report_locale.normalize_country(country)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    filename, content = monthly_report_service.export_financial_accounting_detail_workbook(
        db,
        project_id=project_id,
        country=normalized_country,
        report_month=report_month,
        is_admin=bool(is_admin),
    )
    encoded_filename = quote(filename)
    content_disposition = (
        f'attachment; filename="accounting-detail.xlsx"; '
        f"filename*=UTF-8''{encoded_filename}"
    )
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": content_disposition},
    )


@router.get(
    "/monthly-reports/{report_id:int}", response_model=MonthlyReportDetailResponse
)
def get_monthly_report_detail(
    report_id: int,
    db: Session = Depends(get_db_session),
) -> MonthlyReportDetailResponse:
    report, pt3, pt4 = monthly_report_service.get_report_detail(
        db,
        report_id=report_id,
    )
    return MonthlyReportDetailResponse(
        report=_to_report_item(report),
        pt3=_serialize_calculation_row(pt3),
        pt4=_serialize_calculation_row(pt4),
    )


@router.get("/monthly-reports/{report_id:int}/export")
def download_monthly_report_export(
    report_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
):
    report = monthly_report_service.get_report_or_404(db, report_id)
    if report.status != JobStatus.success:
        raise HTTPException(status_code=409, detail="Monthly report is not finished")

    result_path = monthly_report_service.resolve_result_path(report)
    if result_path is None:
        raise HTTPException(status_code=404, detail="Result file missing")
    append_operation_audit_log(
        db,
        action="monthly_reports.export",
        target_type="monthly_report",
        target_id=report.id,
        operator=operator,
        after={
            "report_id": report.id,
            "project_id": report.project_id,
            "filename": Path(result_path).name,
        },
        request=request,
    )
    db.commit()

    return FileResponse(path=str(result_path), filename=result_path.name)


def _to_report_item(row) -> MonthlyReportListItem:
    return MonthlyReportListItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        report_month=row.report_month,
        version=row.version,
        is_current=row.is_current,
        superseded_at=row.superseded_at,
        status=row.status,
        settlement_id=row.settlement_id,
        total_transactions=row.total_transactions,
        total_orders=row.total_orders,
        total_refunds=row.total_refunds,
        total_adjustments=row.total_adjustments,
        total_service_fees=row.total_service_fees,
        total_trans_fees=row.total_trans_fees,
        result_file_path=row.result_file_path,
        error_message=row.error_message,
        calculation_version=row.calculation_version,
        computed_at=row.computed_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_float(value: Decimal | float | int | None) -> float:
    if value is None:
        return 0.0
    return float(value)


def _serialize_calculation_row(row) -> dict[str, float] | None:
    if row is None:
        return None
    excluded = {
        "id",
        "report_id",
        "project_name",
        "report_month",
        "calculation_version",
        "computed_at",
        "created_at",
        "updated_at",
    }
    payload: dict[str, float] = {}
    for column in row.__table__.columns:  # noqa: SLF001
        key = column.name
        if key in excluded:
            continue
        payload[key] = _to_float(getattr(row, key))
    return payload
