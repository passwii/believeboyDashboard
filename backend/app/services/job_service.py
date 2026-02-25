from datetime import datetime, UTC
from pathlib import Path

from redis import Redis
from rq import Queue
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Job, JobRun, JobStatus


def enqueue_job(db: Session, settings: Settings, payload: dict) -> Job:
    job = Job(job_type=payload['job_type'], status=JobStatus.pending, payload_json=payload)
    db.add(job)
    db.commit()
    db.refresh(job)

    redis = Redis.from_url(settings.redis_url)
    queue = Queue(name='default', connection=redis)
    queue.enqueue('worker.tasks.run_job', job.id)

    return job


def get_job(db: Session, job_id: int) -> Job | None:
    return db.get(Job, job_id)


def get_latest_run(db: Session, job_id: int) -> JobRun | None:
    stmt = select(JobRun).where(JobRun.job_id == job_id).order_by(desc(JobRun.id)).limit(1)
    return db.execute(stmt).scalar_one_or_none()


def mark_job_running(db: Session, job: Job) -> JobRun:
    job.status = JobStatus.running
    run = JobRun(job_id=job.id, started_at=datetime.now(UTC))
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def mark_job_success(db: Session, job: Job, run: JobRun, result_path: str, log_excerpt: str | None = None) -> None:
    job.status = JobStatus.success
    run.finished_at = datetime.now(UTC)
    run.result_path = result_path
    run.log_excerpt = log_excerpt
    db.commit()


def mark_job_failed(db: Session, job: Job, run: JobRun, error_message: str) -> None:
    job.status = JobStatus.failed
    run.finished_at = datetime.now(UTC)
    run.error_message = error_message
    db.commit()


def resolve_upload_path(settings: Settings, file_id: str) -> Path:
    candidates = list(settings.upload_root.rglob(file_id))
    if not candidates:
        raise FileNotFoundError(f'file_id not found: {file_id}')
    return candidates[0]
