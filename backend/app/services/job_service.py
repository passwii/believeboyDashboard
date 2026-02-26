from datetime import datetime, UTC
from pathlib import Path

from redis import Redis
from redis.exceptions import RedisError
from rq import Queue
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Job, JobRun, JobStatus


def enqueue_job(db: Session, settings: Settings, payload: dict, operator: str | None = None) -> Job:
    job = Job(job_type=payload['job_type'], status=JobStatus.pending, payload_json=payload, operator=operator)
    db.add(job)
    db.commit()
    db.refresh(job)

    try:
        redis = Redis.from_url(settings.redis_url)
        queue = Queue(name='default', connection=redis)
        queue.enqueue('worker.tasks.run_job', job.id)
    except RedisError:
        if not settings.allow_sync_job_fallback:
            raise
        from worker.tasks import run_job

        run_job(job.id)
        db.refresh(job)

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
