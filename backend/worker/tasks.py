"""Legacy in-process job runner, kept as the dual-write fallback for BEL-55-P1.

The default execution path is now `app.celery_tasks.run_job.run_job`
(Celery, on the `reports` queue). This module is preserved for the
`enable_celery_dispatch=False` rollback knob and for the
`worker/oneoff_runner.py` script, which keeps importing `run_job` so
operators can re-run a single job synchronously without going through
the broker.

Behavior is byte-for-byte equivalent to the pre-BEL-55-P1 implementation;
the helpers have moved to `app.celery_tasks._common` but the body
below still works without importing them (so a `worker.tasks` import
during a partial deploy still succeeds).
"""

from __future__ import annotations

import json
from pathlib import Path

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.job import JobStatus
from app.services import job_service, upload_service
from app.services import report as monthly_report_service
from app.tasks.script_registry import SCRIPT_HANDLERS


def _resolve_extra_file_ids(settings, params: dict) -> dict:
    file_ids = params.get('file_ids')
    if not isinstance(file_ids, dict):
        return {}

    resolved: dict[str, str] = {}
    project_name = str(params.get('project_name') or '').strip()
    file_type_by_key = {
        'transaction_report': 'payment_report',
        'monthly_summary_pdf': 'monthly_summary_pdf',
    }
    for key, file_id in file_ids.items():
        if not isinstance(file_id, str) or not file_id.strip():
            continue
        file_type = file_type_by_key.get(key)
        if not (project_name and file_type):
            continue
        path = upload_service.build_upload_file_path(settings, project_name, file_type, file_id)
        resolved[key] = str(path)
    return resolved


def _extract_monthly_report_id(payload: dict, params: dict) -> int | None:
    if payload.get('job_type') != 'monthly_report':
        return None
    value = params.get('monthly_report_id')
    try:
        report_id = int(value)
    except (TypeError, ValueError):
        return None
    return report_id if report_id > 0 else None


def _prepare_monthly_report_if_needed(settings, db, payload: dict, params: dict) -> int | None:
    if payload.get('job_type') != 'monthly_report':
        return None

    existing_report_id = _extract_monthly_report_id(payload, params)
    if existing_report_id is not None:
        return existing_report_id

    raw_project_id = params.get('project_id')
    try:
        project_id = int(raw_project_id)
    except (TypeError, ValueError) as exc:
        raise ValueError('project_id is required for monthly_report job') from exc
    if project_id <= 0:
        raise ValueError('project_id must be positive for monthly_report job')

    project_name = str(params.get('project_name') or '').strip()
    if not project_name:
        raise ValueError('project_name is required for monthly_report job')

    report_month_raw = str(params.get('report_month') or '').strip()
    report_month = monthly_report_service.parse_report_month(report_month_raw)

    file_ids = params.get('file_ids')
    file_ids_dict = file_ids if isinstance(file_ids, dict) else {}
    transaction_file_id = str(file_ids_dict.get('transaction_report') or payload.get('file_id') or '').strip()
    if not transaction_file_id:
        raise ValueError('transaction_file_id is required for monthly_report job')
    summary_pdf_file_id_raw = file_ids_dict.get('monthly_summary_pdf')
    summary_pdf_file_id = str(summary_pdf_file_id_raw).strip() if summary_pdf_file_id_raw is not None else None

    resolved_file_paths = params.get('resolved_file_paths')
    resolved_paths_dict = resolved_file_paths if isinstance(resolved_file_paths, dict) else {}
    transaction_file_path = str(
        resolved_paths_dict.get('transaction_report')
        or upload_service.build_upload_file_path(settings, project_name, 'payment_report', transaction_file_id)
    ).strip()
    if not transaction_file_path:
        raise ValueError('transaction_file_path is required for monthly_report job')
    if summary_pdf_file_id:
        summary_pdf_file_path = str(
            resolved_paths_dict.get('monthly_summary_pdf')
            or upload_service.build_upload_file_path(settings, project_name, 'monthly_summary_pdf', summary_pdf_file_id)
        ).strip()
    else:
        summary_pdf_file_path = None

    report = monthly_report_service.prepare_monthly_report(
        db,
        project_id=project_id,
        project_name=project_name,
        country=str(params.get('country') or 'US'),
        report_month=report_month,
        transaction_file_id=transaction_file_id,
        transaction_file_path=transaction_file_path,
        summary_pdf_file_id=summary_pdf_file_id,
        summary_pdf_file_path=summary_pdf_file_path,
        file_size=None,
    )
    db.commit()
    return report.id


def _build_progress_payload(*, stage: str, progress: int, message: str) -> str:
    safe_progress = max(0, min(progress, 100))
    return json.dumps(
        {
            'stage': stage,
            'progress': safe_progress,
            'message': message,
        },
        ensure_ascii=False,
    )


def _push_progress(db, run, *, stage: str, progress: int, message: str) -> None:
    try:
        job_service.update_run_log_excerpt(
            db,
            run,
            _build_progress_payload(stage=stage, progress=progress, message=message),
        )
    except Exception:  # noqa: BLE001
        db.rollback()


def _monthly_progress_callback(db, run):
    def callback(stage: str, progress: int, message: str) -> None:
        _push_progress(db, run, stage=stage, progress=progress, message=message)

    return callback


def _run_job_legacy(job_id: int) -> None:
    """Pre-BEL-55-P1 in-process job body. Kept for the rollback path and oneoff_runner."""
    settings = get_settings()

    db = SessionLocal()
    monthly_report_id: int | None = None
    try:
        job = job_service.get_job(db, job_id)
        if not job:
            return

        run = job_service.mark_job_running(db, job)
        _push_progress(db, run, stage='started', progress=5, message='处理中：任务已启动')
        payload = job.payload_json

        handler = SCRIPT_HANDLERS.get(payload.get('job_type', ''))
        if not handler:
            raise ValueError(f"Unsupported job_type: {payload.get('job_type')}")

        output_dir = settings.result_root / str(job.id)
        params = payload.get('params', {})
        if isinstance(params, dict):
            existing_resolved = params.get('resolved_file_paths')
            resolved_file_paths = (
                {k: v for k, v in existing_resolved.items() if isinstance(v, str) and v.strip()}
                if isinstance(existing_resolved, dict)
                else {}
            )
            resolved_file_paths = {**resolved_file_paths, **_resolve_extra_file_ids(settings, params)}
            params = {**params, 'resolved_file_paths': resolved_file_paths}
        else:
            params = {}
        if payload.get('job_type') == 'monthly_report':
            params = {**params, '_progress_callback': _monthly_progress_callback(db, run)}
        resolved_file_paths = params.get('resolved_file_paths', {}) if isinstance(params, dict) else {}
        upload_path_raw = resolved_file_paths.get('transaction_report')
        if isinstance(upload_path_raw, str) and upload_path_raw.strip():
            upload_path = Path(upload_path_raw)
        elif payload.get('job_type') == 'monthly_report':
            raise FileNotFoundError('transaction_report path not found for monthly_report')
        else:
            upload_path = job_service.resolve_upload_path(settings, payload['file_id'])
        monthly_report_id = _prepare_monthly_report_if_needed(settings, db, payload, params)
        if monthly_report_id is not None:
            monthly_report_service.mark_report_running(db, monthly_report_id)
            db.commit()
        _push_progress(db, run, stage='processing', progress=10, message='处理中：开始执行核算逻辑')

        result = handler(str(upload_path), str(output_dir), params)
        result_path = str(Path(result['result_path']).resolve())

        _push_progress(db, run, stage='completed', progress=100, message='处理完成：报表已生成，可下载')
        job_service.mark_job_success(
            db,
            job,
            run,
            result_path=result_path,
            log_excerpt=_build_progress_payload(
                stage='completed',
                progress=100,
                message='处理完成：报表已生成，可下载',
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
                persist_error_message = f'db_persist_error: {persist_error}'
                monthly_report_service.mark_report_failed(db, monthly_report_id, persist_error_message)
                db.commit()
    except Exception as error:  # noqa: BLE001
        db.rollback()
        if 'job' in locals() and job is not None:
            if 'run' not in locals():
                run = job_service.mark_job_running(db, job)
            payload = job.payload_json if isinstance(job.payload_json, dict) else {}
            raw_params = payload.get('params', {}) if isinstance(payload, dict) else {}
            params = raw_params if isinstance(raw_params, dict) else {}
            if monthly_report_id is None:
                monthly_report_id = _extract_monthly_report_id(payload, params)
            if monthly_report_id is not None:
                monthly_report_service.mark_report_failed(db, monthly_report_id, str(error))
            if job.status != JobStatus.success:
                _push_progress(db, run, stage='failed', progress=100, message=f'处理失败：{error}')
                job_service.mark_job_failed(db, job, run, str(error))
    finally:
        db.close()


def run_job(job_id: int) -> None:
    """Thin dispatcher kept for `worker/oneoff_runner.py` and the rollback path.

    Behavior:
    * `settings.enable_celery_dispatch=True` (default): synchronously
      apply the Celery task (`run_job.apply(...).get()`) so the caller
      still gets a "wait until done" semantic. The actual work runs in
      a worker process via the broker.
    * `settings.enable_celery_dispatch=False`: fall back to the in-process
      `_run_job_legacy` body so the pre-Celery behavior is preserved.
    """
    from app.core.config import get_settings as _get_settings

    settings = _get_settings()
    if settings.enable_celery_dispatch:
        from app.celery_tasks.run_job import run_job as celery_run_job
        celery_run_job.apply(args=[job_id]).get()
        return
    _run_job_legacy(job_id)
