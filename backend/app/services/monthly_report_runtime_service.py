from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import UTC, datetime
from itertools import count
import logging
from pathlib import Path
from threading import Lock, Thread
from typing import Any

from app.core.config import Settings
from app.db.session import SessionLocal
from app.models.job import JobStatus
from app.tasks.script_registry import SCRIPT_HANDLERS
from . import monthly_report_service

logger = logging.getLogger(__name__)
_TASK_TTL_SECONDS = 24 * 60 * 60


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


_TASK_ID_COUNTER = count(1)
_TASKS: dict[int, MonthlyReportTask] = {}
_TASKS_LOCK = Lock()


def _is_terminal(task: MonthlyReportTask) -> bool:
    return task.status in {JobStatus.success, JobStatus.failed}


def _prune_tasks_locked(now: datetime) -> None:
    stale_ids = [
        task_id
        for task_id, task in _TASKS.items()
        if _is_terminal(task) and (now - task.updated_at).total_seconds() > _TASK_TTL_SECONDS
    ]
    for task_id in stale_ids:
        _TASKS.pop(task_id, None)


def create_task(
    settings: Settings,
    *,
    project_id: int | None,
    project_name: str,
    report_month: str,
    transaction_file_id: str,
    summary_pdf_file_id: str | None,
    resolved_file_paths: dict[str, str],
) -> MonthlyReportTask:
    now = datetime.now(UTC)
    task = MonthlyReportTask(
        id=next(_TASK_ID_COUNTER),
        status=JobStatus.pending,
        stage='started',
        progress=1,
        message='处理中：任务已接收',
        error_message=None,
        result_path=None,
        persistence_status='idle',
        persistence_message=None,
        created_at=now,
        updated_at=now,
    )
    payload = {
        'project_id': project_id,
        'project_name': project_name,
        'report_month': report_month,
        'transaction_file_id': transaction_file_id,
        'summary_pdf_file_id': summary_pdf_file_id,
        'resolved_file_paths': resolved_file_paths,
    }

    with _TASKS_LOCK:
        _prune_tasks_locked(now)
        _TASKS[task.id] = task

    thread = Thread(
        target=_run_task,
        args=(task.id, settings, payload),
        daemon=True,
        name=f'monthly-runtime-{task.id}',
    )
    thread.start()
    return task


def get_task(task_id: int) -> MonthlyReportTask | None:
    with _TASKS_LOCK:
        _prune_tasks_locked(datetime.now(UTC))
        task = _TASKS.get(task_id)
        return replace(task) if task is not None else None


def update_task_progress(task_id: int, *, stage: str, progress: int, message: str | None) -> None:
    safe_progress = max(0, min(100, int(progress)))
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.stage = stage
        task.progress = safe_progress
        task.message = message
        task.updated_at = datetime.now(UTC)


def mark_task_running(task_id: int, *, stage: str, progress: int, message: str | None) -> None:
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.status = JobStatus.running
    update_task_progress(task_id, stage=stage, progress=progress, message=message)


def mark_task_success(task_id: int, result_path: str, message: str | None) -> None:
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.status = JobStatus.success
        task.stage = 'completed'
        task.progress = 100
        task.message = message
        task.error_message = None
        task.result_path = result_path
        task.updated_at = datetime.now(UTC)


def mark_task_failed(task_id: int, error_message: str) -> None:
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.status = JobStatus.failed
        task.stage = 'failed'
        task.progress = 100
        task.message = f'处理失败：{error_message}'
        task.error_message = error_message
        task.updated_at = datetime.now(UTC)


def set_persistence_state(task_id: int, *, status: str, message: str | None) -> None:
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.persistence_status = status
        task.persistence_message = message
        task.updated_at = datetime.now(UTC)


def _run_task(task_id: int, settings: Settings, payload: dict[str, Any]) -> None:
    try:
        resolved_paths = payload.get('resolved_file_paths', {})
        if not isinstance(resolved_paths, dict):
            raise ValueError('resolved_file_paths is required')

        upload_path_raw = resolved_paths.get('transaction_report')
        if not isinstance(upload_path_raw, str) or not upload_path_raw.strip():
            raise FileNotFoundError('transaction_report path not found')

        upload_path = Path(upload_path_raw)
        output_dir = settings.result_root / f'monthly-runtime-{task_id}'
        params = {
            'project_name': payload['project_name'],
            'report_month': payload['report_month'],
            'file_ids': {
                'transaction_report': payload['transaction_file_id'],
                'monthly_summary_pdf': payload.get('summary_pdf_file_id'),
            },
            'resolved_file_paths': resolved_paths,
            '_progress_callback': lambda stage, progress, message: update_task_progress(
                task_id,
                stage=stage,
                progress=progress,
                message=message,
            ),
        }

        mark_task_running(task_id, stage='processing', progress=10, message='处理中：开始执行核算逻辑')
        handler = SCRIPT_HANDLERS['monthly_report']
        result = handler(str(upload_path), str(output_dir), params)
        result_path = str(Path(result['result_path']).resolve())
        mark_task_success(task_id, result_path, '处理完成：报表已生成，可下载')
        set_persistence_state(task_id, status='running', message='后台同步中：正在写入数据库')

        persist_thread = Thread(
            target=_persist_monthly_report,
            args=(task_id, payload, result),
            daemon=True,
            name=f'monthly-persist-{task_id}',
        )
        persist_thread.start()
    except Exception as exc:  # noqa: BLE001
        mark_task_failed(task_id, str(exc))


def _persist_monthly_report(task_id: int, payload: dict[str, Any], result: dict[str, Any]) -> None:
    db = SessionLocal()
    report_id: int | None = None
    try:
        project_name = str(payload.get('project_name') or '').strip()
        raw_project_id = payload.get('project_id')
        project_id: int
        if raw_project_id is None:
            project = monthly_report_service.get_project_by_name_or_404(db, project_name)
            project_id = project.id
            project_name = project.project_name.strip()
        else:
            project_id = int(raw_project_id)

        report_month = monthly_report_service.parse_report_month(str(payload.get('report_month') or '').strip())
        transaction_file_id = str(payload.get('transaction_file_id') or '').strip()
        summary_pdf_file_id_raw = payload.get('summary_pdf_file_id')
        summary_pdf_file_id = str(summary_pdf_file_id_raw).strip() if summary_pdf_file_id_raw else None

        resolved_paths = payload.get('resolved_file_paths', {})
        if not isinstance(resolved_paths, dict):
            resolved_paths = {}
        transaction_file_path = str(resolved_paths.get('transaction_report') or '').strip()
        summary_pdf_file_path = str(resolved_paths.get('monthly_summary_pdf') or '').strip() or None

        report = monthly_report_service.prepare_monthly_report(
            db,
            project_id=project_id,
            project_name=project_name,
            report_month=report_month,
            transaction_file_id=transaction_file_id,
            transaction_file_path=transaction_file_path,
            summary_pdf_file_id=summary_pdf_file_id,
            summary_pdf_file_path=summary_pdf_file_path,
            file_size=None,
        )
        report_id = report.id
        monthly_report_service.mark_report_running(db, report.id)
        monthly_report_service.persist_monthly_report_result(
            db,
            report_id=report.id,
            result=result,
            calculation_version=1,
        )
        db.commit()
        set_persistence_state(task_id, status='success', message='后台同步完成：数据库已更新')
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception('monthly report persistence failed: %s', exc)
        if report_id is not None:
            monthly_report_service.mark_report_failed(db, report_id, f'db_persist_error: {exc}')
            db.commit()
        set_persistence_state(task_id, status='failed', message=f'后台同步失败：{exc}')
    finally:
        db.close()
