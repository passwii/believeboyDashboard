from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.models.job import JobStatus
from app.schemas.monthly_report import (
    CreateMonthlyReportRequest,
    MonthlyFinancialSeriesResponse,
    MonthlyReportDetailResponse,
    MonthlyReportListItem,
    MonthlyReportResponse,
    MonthlyReportTaskStatusResponse,
)
from app.services import monthly_report_runtime_service, monthly_report_service, upload_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/monthly-reports', response_model=MonthlyReportResponse)
def create_monthly_report(
    data: CreateMonthlyReportRequest,
    response: Response,
    settings: Settings = Depends(get_settings),
    _operator: str | None = Depends(get_request_operator),
) -> MonthlyReportResponse:
    started_at = perf_counter()
    monthly_report_service.parse_report_month(data.report_month)

    provided_project_name = (data.project_name or '').strip()
    if not provided_project_name:
        raise HTTPException(status_code=422, detail='project_name is required')

    project_id = data.project_id
    project_name = provided_project_name
    after_project = perf_counter()

    transaction_path = upload_service.build_upload_file_path(
        settings,
        project_name,
        'payment_report',
        data.transaction_file_id,
    )
    summary_pdf_path = upload_service.build_upload_file_path(
        settings,
        project_name,
        'monthly_summary_pdf',
        data.summary_pdf_file_id,
    )
    after_resolve_paths = perf_counter()

    task = monthly_report_runtime_service.create_task(
        settings,
        project_id=project_id,
        project_name=project_name,
        report_month=data.report_month.strip(),
        transaction_file_id=data.transaction_file_id,
        summary_pdf_file_id=data.summary_pdf_file_id,
        resolved_file_paths={
            'transaction_report': str(transaction_path),
            'monthly_summary_pdf': str(summary_pdf_path),
        },
    )
    after_enqueue_job = perf_counter()
    prepare_ms = 0
    enqueue_ms = int((after_enqueue_job - after_resolve_paths) * 1000)
    total_ms = int((after_enqueue_job - started_at) * 1000)
    if response is not None:
        response.headers['X-Monthly-Create-Total-Ms'] = str(total_ms)
        response.headers['X-Monthly-Create-Project-Ms'] = str(int((after_project - started_at) * 1000))
        response.headers['X-Monthly-Create-Resolve-Ms'] = str(int((after_resolve_paths - after_project) * 1000))
        response.headers['X-Monthly-Create-Prepare-Ms'] = str(prepare_ms)
        response.headers['X-Monthly-Create-Enqueue-Ms'] = str(enqueue_ms)

    return MonthlyReportResponse(
        job_id=task.id,
        monthly_report_id=None,
        status_endpoint=f'/api/v1/monthly-reports/tasks/{task.id}',
        result_endpoint=f'/api/v1/monthly-reports/tasks/{task.id}/result',
        status=task.status,
        created_at=task.created_at,
    )


@router.get('/monthly-reports/tasks/{task_id}', response_model=MonthlyReportTaskStatusResponse)
def get_monthly_report_task(task_id: int) -> MonthlyReportTaskStatusResponse:
    task = monthly_report_runtime_service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')

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


@router.get('/monthly-reports/tasks/{task_id}/result')
def download_monthly_report_task_result(task_id: int):
    task = monthly_report_runtime_service.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail='Task not found')
    if task.status != JobStatus.success:
        raise HTTPException(status_code=409, detail='Task not finished')
    if not task.result_path:
        raise HTTPException(status_code=404, detail='Result file missing')

    result_path = Path(task.result_path)
    if not result_path.exists() or not result_path.is_file():
        raise HTTPException(status_code=404, detail='Result file missing')

    return FileResponse(path=str(result_path), filename=result_path.name)


@router.get('/monthly-reports', response_model=list[MonthlyReportListItem])
def list_monthly_reports(
    project_id: int | None = Query(default=None, gt=0),
    month: str | None = Query(default=None),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_db_session),
) -> list[MonthlyReportListItem]:
    report_month = monthly_report_service.parse_report_month(month) if month else None
    rows = monthly_report_service.list_reports(
        db,
        project_id=project_id,
        report_month=report_month,
        current_only=not include_history,
    )
    return [_to_report_item(row) for row in rows]


@router.get('/monthly-reports/financial-series', response_model=MonthlyFinancialSeriesResponse)
def get_monthly_financial_series(
    project_id: int = Query(gt=0),
    start_month: str | None = Query(default=None),
    end_month: str | None = Query(default=None),
    fill_missing: bool = Query(default=True),
    db: Session = Depends(get_db_session),
) -> MonthlyFinancialSeriesResponse:
    payload = monthly_report_service.get_financial_series(
        db,
        project_id=project_id,
        start_month=start_month,
        end_month=end_month,
        fill_missing=fill_missing,
    )
    return MonthlyFinancialSeriesResponse(**payload)


@router.get('/monthly-reports/{report_id:int}', response_model=MonthlyReportDetailResponse)
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


@router.get('/monthly-reports/{report_id:int}/export')
def download_monthly_report_export(report_id: int, db: Session = Depends(get_db_session)):
    report = monthly_report_service.get_report_or_404(db, report_id)
    if report.status != JobStatus.success:
        raise HTTPException(status_code=409, detail='Monthly report is not finished')

    result_path = monthly_report_service.resolve_result_path(report)
    if result_path is None:
        raise HTTPException(status_code=404, detail='Result file missing')

    return FileResponse(path=str(result_path), filename=result_path.name)


def _to_report_item(row) -> MonthlyReportListItem:
    return MonthlyReportListItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
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
    excluded = {'id', 'report_id', 'project_name', 'report_month', 'calculation_version', 'computed_at', 'created_at', 'updated_at'}
    payload: dict[str, float] = {}
    for column in row.__table__.columns:  # noqa: SLF001
        key = column.name
        if key in excluded:
            continue
        payload[key] = _to_float(getattr(row, key))
    return payload
