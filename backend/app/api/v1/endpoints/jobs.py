from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.schemas.job import CreateJobRequest, JobDetailResponse, JobResponse, JobRunResponse
from app.services import job_service

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/jobs', response_model=JobResponse)
def create_job(
    data: CreateJobRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
) -> JobResponse:
    payload = {'job_type': data.job_type, 'file_id': data.file_id, 'params': data.params}
    job = job_service.enqueue_job(db, settings, payload, operator=operator)

    return JobResponse(
        id=job.id,
        job_type=job.job_type,
        status=job.status,
        payload_json=job.payload_json,
        operator=job.operator,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


@router.get('/jobs/{job_id}', response_model=JobDetailResponse)
def get_job(job_id: int, db: Session = Depends(get_db_session)) -> JobDetailResponse:
    job = job_service.get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')

    sorted_runs = sorted(job.runs, key=lambda item: item.id)
    runs = [
        JobRunResponse(
            id=run.id,
            started_at=run.started_at,
            finished_at=run.finished_at,
            operator=run.operator,
            log_excerpt=run.log_excerpt,
            error_message=run.error_message,
            result_path=run.result_path,
        )
        for run in sorted_runs
    ]

    return JobDetailResponse(
        id=job.id,
        job_type=job.job_type,
        status=job.status,
        payload_json=job.payload_json,
        operator=job.operator,
        created_at=job.created_at,
        updated_at=job.updated_at,
        runs=runs,
    )


@router.get('/jobs/{job_id}/result')
def download_job_result(
    job_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
):
    job = job_service.get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    if job.status.value != 'success':
        raise HTTPException(status_code=409, detail='Job not finished')

    run = job_service.get_latest_run(db, job_id)
    if not run or not run.result_path:
        raise HTTPException(status_code=404, detail='Result not found')

    result_path = Path(run.result_path)
    if not result_path.is_absolute():
        result_path = settings.result_root / result_path

    if not result_path.exists() or not result_path.is_file():
        raise HTTPException(status_code=404, detail='Result file missing')

    return FileResponse(path=str(result_path), filename=result_path.name)
