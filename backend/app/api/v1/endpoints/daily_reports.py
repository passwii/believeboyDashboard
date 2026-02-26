from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from redis.exceptions import RedisError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.daily_report import CreateDailyReportRequest, DailyReportResponse
from app.services import job_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/daily-reports', response_model=DailyReportResponse)
def create_daily_report(
    data: CreateDailyReportRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
) -> DailyReportResponse:
    report_date = data.report_date.strip()
    try:
        datetime.strptime(report_date, '%Y-%m-%d')
    except ValueError as error:
        raise HTTPException(status_code=400, detail='report_date must be YYYY-MM-DD') from error

    payload = {
        'job_type': 'daily_report',
        'file_id': data.sales_report_file_id,
        'params': {
            'project_name': data.project_name.strip(),
            'report_date': report_date,
            'file_ids': {
                'sales_report': data.sales_report_file_id,
                'ad_report': data.ad_report_file_id,
                'inventory_report': data.inventory_report_file_id,
            },
        },
    }

    try:
        job = job_service.enqueue_job(db, settings, payload, operator=operator)
    except RedisError as error:
        raise HTTPException(status_code=503, detail=f'Queue unavailable: {error}') from error

    return DailyReportResponse(job_id=job.id, status=job.status, created_at=job.created_at)
