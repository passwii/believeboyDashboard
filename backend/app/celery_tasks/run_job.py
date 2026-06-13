"""Celery task that executes a `Job` row end-to-end.

This is the BEL-55-P1 lift of `worker/tasks.py:run_job` into a Celery task.
The body is intentionally a near-line-for-line port of the original
`run_job` so the diff against `worker/tasks.py` is reviewable; the helper
functions have moved to `app.celery_tasks._common`.

Key behaviors that differ from the legacy thread path:

* `task_acks_late=True` + `max_retries=3` + `default_retry_delay=30`:
  the broker re-delivers if a worker is killed mid-task, and we retry up
  to 3 times with a 30s backoff. The retry count and the last error
  surface via `JobRun.error_message`.
* `soft_time_limit=900` (15 min) / `time_limit=1200` (20 min): a
  long-running report that hangs (e.g. a stuck file handle) won't pin a
  worker slot forever. The soft limit raises `SoftTimeLimitExceeded`
  which falls through to the same error path as any other exception.
* Early-exit on `Job.status == success`: a redelivered message that
  raced past the original success state will not re-run the handler.
  This protects against the broker-redelivery case where the original
  worker already finished the work but the ack didn't make it back.
"""

from __future__ import annotations

import logging
from pathlib import Path

from celery import shared_task
from celery.exceptions import MaxRetriesExceededError, SoftTimeLimitExceeded

from app.celery_tasks._common import (
    build_progress_payload,
    extract_monthly_report_id,
    monthly_progress_callback,
    prepare_monthly_report_if_needed,
    push_progress,
    resolve_extra_file_ids,
)
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.job import JobStatus
from app.services import job_service
from app.services import monthly_report_runtime_service as monthly_report_service
from app.tasks.script_registry import SCRIPT_HANDLERS

logger = logging.getLogger(__name__)


# soft=15min / hard=20min — long enough for a heavy monthly report, short
# enough that a hung worker frees its prefetch slot before operator paged.
RUN_JOB_SOFT_TIME_LIMIT = 15 * 60
RUN_JOB_HARD_TIME_LIMIT = 20 * 60


@shared_task(
    name="app.celery_tasks.run_job.run_job",
    bind=True,
    acks_late=True,
    max_retries=3,
    default_retry_delay=30,
    soft_time_limit=RUN_JOB_SOFT_TIME_LIMIT,
    time_limit=RUN_JOB_HARD_TIME_LIMIT,
)
def run_job(self, job_id: int) -> dict:
    """Execute the `Job` identified by `job_id`.

    Returns a small dict so the Celery result backend has something
    structured to surface (and the eager-mode tests can assert on it).
    The `JobRun.error_message` column is the source of truth for failure
    detail.
    """
    settings = get_settings()
    db = SessionLocal()
    monthly_report_id: int | None = None
    job = None
    run = None
    try:
        job = job_service.get_job(db, job_id)
        if not job:
            logger.warning("run_job: job %s not found, skipping", job_id)
            return {"status": "missing"}

        # Early-exit on redelivery: if a previous worker already finished
        # the work, don't re-run the handler. Without this check, a
        # broker-redelivered message (e.g. after a worker SIGKILL) would
        # re-execute the report handler a second time, re-writing
        # `result_path` and re-persisting the monthly_report rows.
        if job.status == JobStatus.success:
            logger.info(
                "run_job: job %s already in success state, skipping redelivery",
                job_id,
            )
            return {"status": "already_done", "job_id": job_id}

        run = job_service.mark_job_running(db, job)
        push_progress(
            db,
            run,
            stage="started",
            progress=5,
            message="处理中：任务已启动",
            task_id=self.request.id,
        )
        payload = job.payload_json

        handler = SCRIPT_HANDLERS.get(payload.get("job_type", ""))
        if not handler:
            raise ValueError(f"Unsupported job_type: {payload.get('job_type')}")

        output_dir = settings.result_root / str(job.id)
        params = payload.get("params", {})
        if isinstance(params, dict):
            existing_resolved = params.get("resolved_file_paths")
            resolved_file_paths = (
                {k: v for k, v in existing_resolved.items() if isinstance(v, str) and v.strip()}
                if isinstance(existing_resolved, dict)
                else {}
            )
            resolved_file_paths = {**resolved_file_paths, **resolve_extra_file_ids(settings, params)}
            params = {**params, "resolved_file_paths": resolved_file_paths}
        else:
            params = {}
        if payload.get("job_type") == "monthly_report":
            params = {**params, "_progress_callback": monthly_progress_callback(db, run)}
        resolved_file_paths = params.get("resolved_file_paths", {}) if isinstance(params, dict) else {}
        upload_path_raw = resolved_file_paths.get("transaction_report")
        if isinstance(upload_path_raw, str) and upload_path_raw.strip():
            upload_path = Path(upload_path_raw)
        elif payload.get("job_type") == "monthly_report":
            raise FileNotFoundError("transaction_report path not found for monthly_report")
        else:
            upload_path = job_service.resolve_upload_path(settings, payload["file_id"])
        monthly_report_id = prepare_monthly_report_if_needed(settings, db, payload, params)
        if monthly_report_id is not None:
            monthly_report_service.mark_report_running(db, monthly_report_id)
            db.commit()
        push_progress(
            db,
            run,
            stage="processing",
            progress=10,
            message="处理中：开始执行核算逻辑",
            task_id=self.request.id,
        )

        result = handler(str(upload_path), str(output_dir), params)
        result_path = str(Path(result["result_path"]).resolve())

        push_progress(
            db,
            run,
            stage="completed",
            progress=100,
            message="处理完成：报表已生成，可下载",
            task_id=self.request.id,
        )
        job_service.mark_job_success(
            db,
            job,
            run,
            result_path=result_path,
            log_excerpt=build_progress_payload(
                stage="completed",
                progress=100,
                message="处理完成：报表已生成，可下载",
                task_id=self.request.id,
            ),
        )

        if monthly_report_id is not None:
            try:
                monthly_report_service.persist_monthly_report_result(
                    db,
                    report_id=monthly_report_id,
                    result=result,
                    calculation_version=1,
                )
                db.commit()
            except Exception as persist_error:  # noqa: BLE001
                db.rollback()
                persist_error_message = f"db_persist_error: {persist_error}"
                monthly_report_service.mark_report_failed(db, monthly_report_id, persist_error_message)
                db.commit()

        return {"status": "success", "job_id": job_id, "result_path": result_path}

    except (Exception, SoftTimeLimitExceeded) as error:  # noqa: BLE001
        db.rollback()
        if job is not None:
            if run is None:
                run = job_service.mark_job_running(db, job)
            payload = job.payload_json if isinstance(job.payload_json, dict) else {}
            raw_params = payload.get("params", {}) if isinstance(payload, dict) else {}
            params = raw_params if isinstance(raw_params, dict) else {}
            if monthly_report_id is None:
                monthly_report_id = extract_monthly_report_id(payload, params)
            if monthly_report_id is not None:
                monthly_report_service.mark_report_failed(db, monthly_report_id, str(error))
            if job.status != JobStatus.success:
                push_progress(
                    db,
                    run,
                    stage="failed",
                    progress=100,
                    message=f"处理失败：{error}",
                    task_id=self.request.id,
                )
                job_service.mark_job_failed(db, job, run, str(error))
        # Let Celery schedule a retry (up to max_retries=3). On the last
        # failure, MaxRetriesExceededError is raised and the task lands
        # in FAILURE state — `mark_job_failed` has already written the
        # final error to `JobRun.error_message`.
        try:
            raise self.retry(exc=error, countdown=30, max_retries=3)
        except MaxRetriesExceededError:
            logger.warning("run_job: job %s exhausted retries", job_id)
            return {"status": "failed", "job_id": job_id, "error": str(error)}
    finally:
        db.close()
