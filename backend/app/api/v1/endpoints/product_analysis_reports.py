from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.product_analysis import (
    CreateProductAnalysisReportRequest,
    ProductAnalysisReportResponse,
    ProductAnalysisTaskStatusResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services import analysis_report_runtime_service, upload_service

router = APIRouter(dependencies=[Depends(protected)])


from app.utils.country import _normalize_country_http as _normalize_country


@router.post('/product-analysis-reports', response_model=ProductAnalysisReportResponse)
def create_product_analysis_report(
    data: CreateProductAnalysisReportRequest,
    request: Request,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProductAnalysisReportResponse:
    start_date = data.report_start_date.strip()
    end_date = data.report_end_date.strip()

    try:
        start = datetime.strptime(start_date, '%Y-%m-%d')
        end = datetime.strptime(end_date, '%Y-%m-%d')
    except ValueError as error:
        raise HTTPException(status_code=400, detail='report_start_date/report_end_date must be YYYY-MM-DD') from error

    if start > end:
        raise HTTPException(status_code=400, detail='report_start_date cannot be greater than report_end_date')

    project_name = data.project_name.strip()
    country = _normalize_country(data.country)
    file_ids = {
        'business_report': data.business_report_file_id,
        'payment_report': data.payment_report_file_id,
        'ad_report': data.ad_report_file_id,
    }
    if data.inventory_report_file_id and data.inventory_report_file_id.strip():
        file_ids['inventory_report'] = data.inventory_report_file_id.strip()

    resolved_file_paths = {
        'business_report': str(upload_service.build_upload_file_path(settings, project_name, 'business_report', data.business_report_file_id)),
        'payment_report': str(upload_service.build_upload_file_path(settings, project_name, 'payment_report', data.payment_report_file_id)),
        'ad_report': str(upload_service.build_upload_file_path(settings, project_name, 'ad_report', data.ad_report_file_id)),
    }
    if 'inventory_report' in file_ids:
        resolved_file_paths['inventory_report'] = str(
            upload_service.build_upload_file_path(settings, project_name, 'inventory_report', file_ids['inventory_report'])
        )

    task = analysis_report_runtime_service.create_task(
        settings,
        report_type='product_analysis',
        input_path=resolved_file_paths['business_report'],
        params={
            'project_name': project_name,
            'report_start_date': start_date,
            'report_end_date': end_date,
            'country': country,
            'file_ids': file_ids,
            'resolved_file_paths': resolved_file_paths,
            'operator': operator,
        },
    )
    append_operation_audit_log(
        db,
        action='product_analysis_reports.create',
        target_type='product_analysis_report_task',
        target_id=task.id,
        operator=operator,
        after={
            'job_id': task.id,
            'project_name': project_name,
            'country': country,
            'report_start_date': start_date,
            'report_end_date': end_date,
        },
        request=request,
    )
    db.commit()

    return ProductAnalysisReportResponse(
        job_id=task.id,
        status_endpoint=f'/api/v1/product-analysis-reports/tasks/{task.id}',
        result_endpoint=f'/api/v1/product-analysis-reports/tasks/{task.id}/result',
        status=task.status,
        created_at=task.created_at,
    )


@router.get('/product-analysis-reports/tasks/{task_id}', response_model=ProductAnalysisTaskStatusResponse)
def get_product_analysis_task(task_id: int) -> ProductAnalysisTaskStatusResponse:
    task = analysis_report_runtime_service.get_task(task_id)
    if task is None or task.report_type != 'product_analysis':
        raise HTTPException(status_code=404, detail='Task not found')
    return ProductAnalysisTaskStatusResponse(
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


@router.get('/product-analysis-reports/tasks/{task_id}/result')
def download_product_analysis_task_result(
    task_id: int,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
):
    task = analysis_report_runtime_service.get_task(task_id)
    if task is None or task.report_type != 'product_analysis':
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
        action='product_analysis_reports.result.export',
        target_type='product_analysis_report_task',
        target_id=task.id,
        operator=operator,
        after={'job_id': task.id, 'filename': result_path.name},
        request=request,
    )
    db.commit()
    return FileResponse(path=str(result_path), filename=result_path.name)
