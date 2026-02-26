from fastapi import APIRouter, Depends, HTTPException
from redis.exceptions import RedisError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.monthly_report import CreateMonthlyReportRequest, MonthlyReportResponse
from app.services import job_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/monthly-reports', response_model=MonthlyReportResponse)
def create_monthly_report(
    data: CreateMonthlyReportRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
) -> MonthlyReportResponse:
    report_month = data.report_month.strip()
    if len(report_month) != 7 or report_month[4] != '-':
        raise HTTPException(status_code=400, detail='report_month must be YYYY-MM')

    payload = {
        'job_type': 'monthly_report',
        'file_id': data.transaction_file_id,
        'params': {
            'project_name': data.project_name.strip(),
            'report_month': report_month,
            'file_ids': {
                'transaction_report': data.transaction_file_id,
                'monthly_summary_pdf': data.summary_pdf_file_id,
            },
        },
    }

    try:
        job = job_service.enqueue_job(db, settings, payload, operator=operator)
    except RedisError as error:
        raise HTTPException(status_code=503, detail=f'Queue unavailable: {error}') from error

    return MonthlyReportResponse(job_id=job.id, status=job.status, created_at=job.created_at)
