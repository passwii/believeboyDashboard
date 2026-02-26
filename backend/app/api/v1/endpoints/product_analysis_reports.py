from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from redis.exceptions import RedisError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import Settings, get_settings
from app.schemas.product_analysis import CreateProductAnalysisReportRequest, ProductAnalysisReportResponse
from app.services import job_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/product-analysis-reports', response_model=ProductAnalysisReportResponse)
def create_product_analysis_report(
    data: CreateProductAnalysisReportRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
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

    file_ids = {
        'business_report': data.business_report_file_id,
        'payment_report': data.payment_report_file_id,
        'ad_report': data.ad_report_file_id,
    }
    if data.inventory_report_file_id and data.inventory_report_file_id.strip():
        file_ids['inventory_report'] = data.inventory_report_file_id.strip()

    payload = {
        'job_type': 'product_analysis',
        'file_id': data.business_report_file_id,
        'params': {
            'project_name': data.project_name.strip(),
            'report_start_date': start_date,
            'report_end_date': end_date,
            'file_ids': file_ids,
        },
    }

    try:
        job = job_service.enqueue_job(db, settings, payload)
    except RedisError as error:
        raise HTTPException(status_code=503, detail=f'Queue unavailable: {error}') from error

    return ProductAnalysisReportResponse(job_id=job.id, status=job.status, created_at=job.created_at)
