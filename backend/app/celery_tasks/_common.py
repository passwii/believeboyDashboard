"""Shared utilities for the believeboy Celery task package.

BEL-55-P1 lifted the body of the pre-Celery in-process job runner into Celery
(the legacy runner was deleted in BLF-1037). To keep the
new task body readable and to give BEL-55-P3 (the in-memory monthly-report
task table) something to reuse, the cross-task helpers live here:

* `push_progress` / `build_progress_payload` — JSON progress payload that
  surfaces in `JobRun.log_excerpt`. When invoked from a Celery task, pass
  `task_id=self.request.id` so the broker's task UUID lands in the
  progress JSON for cross-referencing with worker logs.
* `monthly_progress_callback` — adapts `push_progress` to the callback
  signature expected by the monthly report pipeline.
* `resolve_extra_file_ids` / `extract_monthly_report_id` /
  `prepare_monthly_report_if_needed` — unchanged helpers lifted from the
  original in-process runner.

The progress helpers commit on success and roll back on serialization
failure (mirroring the original `_push_progress` behavior so
that a bad payload never poisons the surrounding transaction).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.infra.cache_decorator import mark_committed
from app.models import JobRun
from app.services import job_service
from app.services import report as monthly_report_service
from app.services import upload_service

logger = logging.getLogger(__name__)


def build_progress_payload(
    *, stage: str, progress: int, message: str, task_id: str | None = None
) -> str:
    """Build the JSON `JobRun.log_excerpt` payload.

    `task_id` is the Celery task UUID (`self.request.id`); it lands in the
    payload only when supplied so the legacy in-process path keeps emitting
    the original two-key JSON shape.
    """
    safe_progress = max(0, min(progress, 100))
    payload: dict[str, Any] = {
        "stage": stage,
        "progress": safe_progress,
        "message": message,
    }
    if task_id:
        payload["task_id"] = task_id
    return json.dumps(payload, ensure_ascii=False)


def push_progress(
    db: Session,
    run: JobRun,
    *,
    stage: str,
    progress: int,
    message: str,
    task_id: str | None = None,
) -> None:
    """Write the latest progress JSON to `JobRun.log_excerpt`.

    Mirrors the original in-process `_push_progress`: errors during serialization
    or commit are swallowed (and the transaction rolled back) so a
    transient progress-write failure never aborts the surrounding handler.
    """
    try:
        job_service.update_run_log_excerpt(
            db,
            run,
            build_progress_payload(
                stage=stage, progress=progress, message=message, task_id=task_id
            ),
        )
    except Exception:  # noqa: BLE001
        db.rollback()


def monthly_progress_callback(db: Session, run: JobRun):
    """Adapter so the monthly report pipeline can call back with stage/progress/message.

    Note: `task_id` is intentionally not threaded through here — the
    monthly report pipeline doesn't know about Celery, and the outer
    `run_job` task pushes its own progress events that already carry the
    task_id.
    """

    def callback(stage: str, progress: int, message: str) -> None:
        push_progress(db, run, stage=stage, progress=progress, message=message)

    return callback


def resolve_extra_file_ids(settings: Settings, params: dict) -> dict:
    """Resolve `params['file_ids']` to absolute paths under the upload root.

    Only two keys are supported today (transaction_report and
    monthly_summary_pdf); unknown keys are silently dropped.
    """
    file_ids = params.get("file_ids")
    if not isinstance(file_ids, dict):
        return {}

    resolved: dict[str, str] = {}
    project_name = str(params.get("project_name") or "").strip()
    file_type_by_key = {
        "transaction_report": "payment_report",
        "monthly_summary_pdf": "monthly_summary_pdf",
    }
    for key, file_id in file_ids.items():
        if not isinstance(file_id, str) or not file_id.strip():
            continue
        file_type = file_type_by_key.get(key)
        if not (project_name and file_type):
            continue
        path = upload_service.build_upload_file_path(
            settings, project_name, file_type, file_id
        )
        resolved[key] = str(path)
    return resolved


def extract_monthly_report_id(payload: dict, params: dict) -> int | None:
    """Pull `monthly_report_id` out of `params` when this is a monthly_report job."""
    if payload.get("job_type") != "monthly_report":
        return None
    value = params.get("monthly_report_id")
    try:
        report_id = int(value)
    except (TypeError, ValueError):
        return None
    return report_id if report_id > 0 else None


def prepare_monthly_report_if_needed(
    settings: Settings, db: Session, payload: dict, params: dict
) -> int | None:
    """Create a `MonthlyReport` row up front so the report has an id we can attach state to.

    Returns the report id (existing or newly created), or None if this job
    isn't a monthly_report. Caller is responsible for committing.
    """
    if payload.get("job_type") != "monthly_report":
        return None

    existing_report_id = extract_monthly_report_id(payload, params)
    if existing_report_id is not None:
        return existing_report_id

    raw_project_id = params.get("project_id")
    try:
        project_id = int(raw_project_id)
    except (TypeError, ValueError) as exc:
        raise ValueError("project_id is required for monthly_report job") from exc
    if project_id <= 0:
        raise ValueError("project_id must be positive for monthly_report job")

    project_name = str(params.get("project_name") or "").strip()
    if not project_name:
        raise ValueError("project_name is required for monthly_report job")

    report_month_raw = str(params.get("report_month") or "").strip()
    report_month = monthly_report_service.parse_report_month(report_month_raw)

    file_ids = params.get("file_ids")
    file_ids_dict = file_ids if isinstance(file_ids, dict) else {}
    transaction_file_id = str(
        file_ids_dict.get("transaction_report") or payload.get("file_id") or ""
    ).strip()
    if not transaction_file_id:
        raise ValueError("transaction_file_id is required for monthly_report job")
    summary_pdf_file_id_raw = file_ids_dict.get("monthly_summary_pdf")
    summary_pdf_file_id = (
        str(summary_pdf_file_id_raw).strip()
        if summary_pdf_file_id_raw is not None
        else None
    )

    resolved_file_paths = params.get("resolved_file_paths")
    resolved_paths_dict = (
        resolved_file_paths if isinstance(resolved_file_paths, dict) else {}
    )
    transaction_file_path = str(
        resolved_paths_dict.get("transaction_report")
        or upload_service.build_upload_file_path(
            settings, project_name, "payment_report", transaction_file_id
        )
    ).strip()
    if not transaction_file_path:
        raise ValueError("transaction_file_path is required for monthly_report job")
    if summary_pdf_file_id:
        summary_pdf_file_path = str(
            resolved_paths_dict.get("monthly_summary_pdf")
            or upload_service.build_upload_file_path(
                settings, project_name, "monthly_summary_pdf", summary_pdf_file_id
            )
        ).strip()
    else:
        summary_pdf_file_path = None

    report = monthly_report_service.prepare_monthly_report(
        db,
        project_id=project_id,
        project_name=project_name,
        country=str(params.get("country") or "US"),
        report_month=report_month,
        transaction_file_id=transaction_file_id,
        transaction_file_path=transaction_file_path,
        summary_pdf_file_id=summary_pdf_file_id,
        summary_pdf_file_path=summary_pdf_file_path,
        file_size=None,
    )
    db.commit()
    mark_committed()  # BLF-669: 服务层 commit 后协议标记（ContextVar 跨调用栈可见）
    return report.id
