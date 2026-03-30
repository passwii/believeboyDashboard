from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session
from app.api.deps import get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.daily_report import CreateDailyReportRequest, DailyReportResponse, DailyReportTaskStatusResponse
from app.services.audit_log_service import append_operation_audit_log
from app.services import analysis_report_runtime_service, upload_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/daily-reports', response_model=DailyReportResponse)
def create_daily_report(
    data: CreateDailyReportRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> DailyReportResponse:
    report_date = data.report_date.strip()
    try:
        datetime.strptime(report_date, '%Y-%m-%d')
    except ValueError as error:
        raise HTTPException(status_code=400, detail='report_date must be YYYY-MM-DD') from error

    project_name = data.project_name.strip()
    sales_path = upload_service.build_upload_file_path(settings, project_name, 'sales_report', data.sales_report_file_id)
    ad_path = upload_service.build_upload_file_path(settings, project_name, 'ad_report', data.ad_report_file_id)
    inventory_path = upload_service.build_upload_file_path(
        settings,
        project_name,
        'inventory_report',
        data.inventory_report_file_id,
    )

    task = analysis_report_runtime_service.create_task(
        settings,
        report_type='daily_report',
        input_path=str(sales_path),
        params={
            'project_name': project_name,
            'country': data.country.strip() or 'US',
            'report_date': report_date,
            'file_ids': {
                'sales_report': data.sales_report_file_id,
                'ad_report': data.ad_report_file_id,
                'inventory_report': data.inventory_report_file_id,
            },
            'resolved_file_paths': {
                'sales_report': str(sales_path),
                'ad_report': str(ad_path),
                'inventory_report': str(inventory_path),
            },
            'operator': operator,
        },
    )

    append_operation_audit_log(
        db,
        action='daily_reports.create',
        target_type='daily_report_task',
        target_id=task.id,
        operator=operator,
        after={
            'job_id': task.id,
            'project_name': project_name,
            'country': data.country.strip() or 'US',
            'report_date': report_date,
        },
        request=request,
    )
    db.commit()

    return DailyReportResponse(
        job_id=task.id,
        status_endpoint=f'/api/v1/daily-reports/tasks/{task.id}',
        result_endpoint=f'/api/v1/daily-reports/tasks/{task.id}/result',
        status=task.status,
        created_at=task.created_at,
    )


@router.get('/daily-reports/tasks/{task_id}', response_model=DailyReportTaskStatusResponse)
def get_daily_report_task(task_id: int) -> DailyReportTaskStatusResponse:
    task = analysis_report_runtime_service.get_task(task_id)
    if task is None or task.report_type != 'daily_report':
        raise HTTPException(status_code=404, detail='Task not found')
    return DailyReportTaskStatusResponse(
        task_id=task.id,
        status=task.status,
        stage=task.stage,
        progress=task.progress,
        message=task.message,
        error_message=task.error_message,
        persistence_status=getattr(task, 'persistence_status', None),
        persistence_message=getattr(task, 'persistence_message', None),
        created_at=task.created_at,
        updated_at=task.updated_at,
    )


@router.get('/daily-reports/tasks/{task_id}/result')
def download_daily_report_task_result(
    task_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
):
    task = analysis_report_runtime_service.get_task(task_id)
    if task is None or task.report_type != 'daily_report':
        raise HTTPException(status_code=404, detail='Task not found')
    if task.status.value != 'success':
        raise HTTPException(status_code=409, detail='Task not finished')
    if not task.result_path:
        raise HTTPException(status_code=404, detail='Result file missing')

    result_path = Path(task.result_path)
    if not result_path.exists() or not result_path.is_file():
        raise HTTPException(status_code=404, detail='Result file missing')
    append_operation_audit_log(
        db,
        action='daily_reports.result.export',
        target_type='daily_report_task',
        target_id=task.id,
        operator=operator,
        after={'job_id': task.id, 'filename': result_path.name},
        request=request,
    )
    db.commit()
    return FileResponse(path=str(result_path), filename=result_path.name)
