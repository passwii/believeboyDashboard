from datetime import datetime, UTC
from pathlib import Path
import logging
import threading

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Job, JobRun, JobStatus

logger = logging.getLogger(__name__)


def enqueue_job(db: Session, settings: Settings, payload: dict, operator: str | None = None) -> Job:
    _ = settings
    job = Job(job_type=payload['job_type'], status=JobStatus.pending, payload_json=payload, operator=operator)
    db.add(job)
    db.commit()
    job_id = job.id

    from worker.tasks import run_job

    thread = threading.Thread(target=run_job, args=(job_id,), daemon=True, name=f'job-runner-{job_id}')
    thread.start()
    return job


def get_job(db: Session, job_id: int) -> Job | None:
    return db.get(Job, job_id)


def get_latest_run(db: Session, job_id: int) -> JobRun | None:
    stmt = select(JobRun).where(JobRun.job_id == job_id).order_by(desc(JobRun.id)).limit(1)
    return db.execute(stmt).scalar_one_or_none()


def mark_job_running(db: Session, job: Job, operator: str | None = None) -> JobRun:
    job.status = JobStatus.running
    run_operator = operator if operator is not None else job.operator
    run = JobRun(job_id=job.id, started_at=datetime.now(UTC), operator=run_operator)
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def mark_job_success(db: Session, job: Job, run: JobRun, result_path: str, log_excerpt: str | None = None) -> None:
    job.status = JobStatus.success
    run.finished_at = datetime.now(UTC)
    run.result_path = result_path
    if log_excerpt is not None:
        run.log_excerpt = log_excerpt
    db.commit()


def mark_job_failed(db: Session, job: Job, run: JobRun, error_message: str) -> None:
    job.status = JobStatus.failed
    run.finished_at = datetime.now(UTC)
    run.error_message = error_message
    db.commit()


def update_run_log_excerpt(db: Session, run: JobRun, log_excerpt: str) -> None:
    run.log_excerpt = log_excerpt
    db.commit()


def resolve_upload_path(settings: Settings, file_id: str) -> Path:
    for candidate in settings.upload_root.rglob(file_id):
        return candidate
    raise FileNotFoundError(f'file_id not found: {file_id}')
