from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import json
import logging
from typing import Any

from sqlalchemy import desc, func, select, text
from sqlalchemy.orm import Session, selectinload

from app.db.session import SessionLocal
from app.models import MonthlyReport
from app.models.job import Job, JobRun, JobStatus
from app.services import job_service
from app.services.report.monthly import parse_report_month

logger = logging.getLogger(__name__)

# DEPRECATED: DB-backed compatibility adapter for the legacy monthly report task API.
# The in-process task table has been removed; state is sourced from Job/JobRun.
_TASK_ID_COUNTER = None
_TASKS = None
_TASKS_LOCK = None


@dataclass
class MonthlyReportTask:
    id: int
    status: JobStatus
    stage: str
    progress: int
    message: str | None
    error_message: str | None
    result_path: str | None
    persistence_status: str
    persistence_message: str | None
    created_at: datetime
    updated_at: datetime


def create_task(
    *,
    project_id: int | None,
    project_name: str,
    country: str,
    report_month: str,
    transaction_file_id: str,
    summary_pdf_file_id: str | None,
    resolved_file_paths: dict[str, str],
    db: Session | None = None,
    operator: str | None = None,
) -> MonthlyReportTask:
    payload = _build_job_payload(
        project_id=project_id,
        project_name=project_name,
        country=country,
        report_month=report_month,
        transaction_file_id=transaction_file_id,
        summary_pdf_file_id=summary_pdf_file_id,
        resolved_file_paths=resolved_file_paths,
    )

    owns_session = db is None
    if owns_session:
        db = SessionLocal()
    try:
        job = job_service.enqueue_job(db, payload, operator=operator)
        return _task_from_job(db, job)
    finally:
        if owns_session:
            db.close()


def get_task(task_id: int) -> MonthlyReportTask | None:
    db = SessionLocal()
    try:
        stmt = (
            select(Job)
            .options(selectinload(Job.runs))
            .where(
                Job.id == task_id,
                Job.job_type == 'monthly_report',
                _ttl_clause(
                    Job,
                    db.bind.dialect.name if db.bind is not None else 'postgresql',
                ),
            )
        )
        job = db.execute(stmt).scalar_one_or_none()
        if job is None:
            return None
        return _task_from_job(db, job)
    finally:
        db.close()


def _build_job_payload(
    *,
    project_id: int | None,
    project_name: str,
    country: str,
    report_month: str,
    transaction_file_id: str,
    summary_pdf_file_id: str | None,
    resolved_file_paths: dict[str, str],
) -> dict[str, Any]:
    file_ids: dict[str, str] = {'transaction_report': transaction_file_id}
    if summary_pdf_file_id:
        file_ids['monthly_summary_pdf'] = summary_pdf_file_id

    return {
        'job_type': 'monthly_report',
        'file_id': transaction_file_id,
        'params': {
            'project_id': project_id,
            'project_name': project_name,
            'country': country,
            'report_month': parse_report_month(report_month),
            'file_ids': file_ids,
            'resolved_file_paths': resolved_file_paths,
        },
    }


def _ttl_clause(model: type[Job], dialect_name: str):
    if dialect_name == 'postgresql':
        return model.created_at > func.now() - text("interval '24 hours'")
    return model.created_at > func.datetime('now', '-24 hours')


def _task_from_job(db: Session, job: Job) -> MonthlyReportTask:
    run = _latest_run(db, job.id)
    report = _monthly_report_for_job(db, job)
    progress = _parse_progress(run.log_excerpt if run is not None else None, job.status)
    persistence_status, persistence_message = _persistence_state(report)
    updated_at = _task_updated_at(job, run)
    return MonthlyReportTask(
        id=job.id,
        status=job.status,
        stage=progress['stage'],
        progress=progress['progress'],
        message=progress['message'],
        error_message=run.error_message if run is not None else _fallback_error_message(job.status),
        result_path=run.result_path if run is not None else None,
        persistence_status=persistence_status,
        persistence_message=persistence_message,
        created_at=job.created_at or datetime.now(UTC),
        updated_at=updated_at,
    )


def _latest_run(db: Session, job_id: int) -> JobRun | None:
    stmt = select(JobRun).where(JobRun.job_id == job_id).order_by(desc(JobRun.id)).limit(1)
    return db.execute(stmt).scalar_one_or_none()


def _monthly_report_for_job(db: Session, job: Job) -> MonthlyReport | None:
    payload = job.payload_json if isinstance(job.payload_json, dict) else {}
    params = payload.get('params') if isinstance(payload.get('params'), dict) else {}
    file_ids = params.get('file_ids') if isinstance(params.get('file_ids'), dict) else {}
    country = str(params.get('country') or '').strip() or None
    report_month = str(params.get('report_month') or '').strip() or None
    transaction_file_id = (
        str(file_ids.get('transaction_report') or payload.get('file_id') or '').strip() or None
    )
    if not (country and report_month and transaction_file_id):
        return None

    stmt = select(MonthlyReport).where(
        MonthlyReport.country == country,
        MonthlyReport.report_month == report_month,
        MonthlyReport.transaction_file_id == transaction_file_id,
    )
    project_id = params.get('project_id')
    project_name = str(params.get('project_name') or '').strip()
    if project_id is not None:
        try:
            stmt = stmt.where(MonthlyReport.project_id == int(project_id))
        except (TypeError, ValueError):
            stmt = stmt.where(MonthlyReport.project_name == project_name)
    elif project_name:
        stmt = stmt.where(MonthlyReport.project_name == project_name)
    else:
        return None
    return db.execute(
        stmt.order_by(desc(MonthlyReport.created_at)).limit(1),
    ).scalar_one_or_none()


def _parse_progress(log_excerpt: str | None, status: JobStatus) -> dict[str, Any]:
    if isinstance(log_excerpt, str) and log_excerpt.strip():
        try:
            payload = json.loads(log_excerpt)
        except json.JSONDecodeError:
            return _fallback_progress(status, log_excerpt.strip())
        if isinstance(payload, dict):
            stage = str(payload.get('stage') or '').strip() or _fallback_stage(status)
            progress = _safe_progress(payload.get('progress'))
            message = payload.get('message')
            return {
                'stage': stage,
                'progress': progress,
                'message': str(message) if message is not None else _fallback_message(status),
            }
    return _fallback_progress(status)


def _fallback_progress(status: JobStatus, message: str | None = None) -> dict[str, Any]:
    return {
        'stage': _fallback_stage(status),
        'progress': _fallback_progress_value(status),
        'message': message or _fallback_message(status),
    }


def _fallback_stage(status: JobStatus) -> str:
    if status == JobStatus.pending:
        return 'started'
    if status == JobStatus.running:
        return 'processing'
    if status == JobStatus.success:
        return 'completed'
    return 'failed'


def _fallback_progress_value(status: JobStatus) -> int:
    if status == JobStatus.success:
        return 100
    if status == JobStatus.failed:
        return 100
    if status == JobStatus.pending:
        return 2
    return 10


def _fallback_message(status: JobStatus) -> str:
    if status == JobStatus.pending:
        return '处理中：任务排队中'
    if status == JobStatus.running:
        return '处理中：任务执行中'
    if status == JobStatus.success:
        return '处理完成：报表已生成，可下载'
    return '处理失败'


def _fallback_error_message(status: JobStatus) -> str | None:
    return '处理失败' if status == JobStatus.failed else None


def _safe_progress(value: Any) -> int:
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return 0


def _persistence_state(report: MonthlyReport | None) -> tuple[str, str | None]:
    if report is None:
        return 'idle', None

    status = report.status.value if isinstance(report.status, JobStatus) else str(report.status)
    if status == JobStatus.pending.value:
        return status, '等待写入数据库'
    if status == JobStatus.running.value:
        return status, '后台同步中：正在写入数据库'
    if status == JobStatus.success.value:
        return status, '后台同步完成：数据库已更新'
    if status == JobStatus.failed.value:
        return status, f"后台同步失败：{report.error_message or '数据库同步失败'}"
    return status, report.error_message


def _task_updated_at(job: Job, run: JobRun | None) -> datetime:
    candidates = [
        value
        for value in (
            job.updated_at,
            run.finished_at if run is not None else None,
            run.started_at if run is not None else None,
        )
        if value is not None
    ]
    return max(candidates) if candidates else datetime.now(UTC)
