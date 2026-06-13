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
    """Create a `Job` row and dispatch the work to Celery or the legacy thread.

    BEL-55-P1 dual-write: when `settings.enable_celery_dispatch` is true
    (the default), the new job is pushed onto the Celery `reports` queue
    via `app.celery_tasks.run_job.run_job.delay(job_id)`. When false —
    the rollback knob — the job runs in an in-process daemon thread,
    matching the pre-Celery behavior of `worker.tasks.run_job`. The
    legacy path is kept for one PR cycle as a safety net; remove once
    the Celery path is battle-tested.
    """
    job = Job(job_type=payload['job_type'], status=JobStatus.pending, payload_json=payload, operator=operator)
    db.add(job)
    db.commit()
    job_id = job.id

    if settings.enable_celery_dispatch:
        from app.celery_tasks.run_job import run_job as celery_run_job
        celery_run_job.delay(job_id)
    else:
        from worker.tasks import run_job as thread_run_job
        thread = threading.Thread(target=thread_run_job, args=(job_id,), daemon=True, name=f'job-runner-{job_id}')
        thread.start()
    return job


def get_job(db: Session, job_id: int) -> Job | None:
    return db.get(Job, job_id)


def get_latest_run(db: Session, job_id: int) -> JobRun | None:
    stmt = select(JobRun).where(JobRun.job_id == job_id).order_by(desc(JobRun.id)).limit(1)
    return db.execute(stmt).scalar_one_or_none()


def mark_job_running(db: Session, job: Job, operator: str | None = None) -> JobRun:
    """Mark the job as `running` and create a new `JobRun` row.

    BEL-55-P1 idempotency: if the job is already in the `running` state
    (e.g. a broker-redelivered Celery message arriving while the original
    worker is still processing), we return the existing latest `JobRun`
    rather than creating a duplicate. Without this guard, redelivery
    would create a second `JobRun` and skew operator-facing metrics.
    """
    if job.status == JobStatus.running:
        existing = get_latest_run(db, job.id)
        if existing is not None:
            return existing
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
    """Mark the job as `failed` and persist the error message.

    BEL-55-P1 retry semantics: when the Celery task is retrying, each
    attempt calls `mark_job_failed` and would otherwise overwrite the
    previous attempt's stack trace. We append the new error below the
    previous one (separated by a delimiter) so operators can see the
    full retry history on a single row, not just the latest attempt.
    """
    job.status = JobStatus.failed
    run.finished_at = datetime.now(UTC)
    if run.error_message:
        run.error_message = f"{run.error_message}\n---\n{error_message}"
    else:
        run.error_message = error_message
    db.commit()


def update_run_log_excerpt(db: Session, run: JobRun, log_excerpt: str) -> None:
    run.log_excerpt = log_excerpt
    db.commit()


def resolve_upload_path(settings: Settings, file_id: str) -> Path:
    for candidate in settings.upload_root.rglob(file_id):
        return candidate
    raise FileNotFoundError(f'file_id not found: {file_id}')
