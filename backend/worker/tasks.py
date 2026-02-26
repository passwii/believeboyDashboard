from pathlib import Path

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services import job_service
from app.tasks.script_registry import SCRIPT_HANDLERS


def _resolve_extra_file_ids(settings, params: dict) -> dict:
    file_ids = params.get('file_ids')
    if not isinstance(file_ids, dict):
        return {}

    resolved: dict[str, str] = {}
    for key, file_id in file_ids.items():
        if not isinstance(file_id, str) or not file_id.strip():
            continue
        path = job_service.resolve_upload_path(settings, file_id)
        resolved[key] = str(path.resolve())
    return resolved


def run_job(job_id: int) -> None:
    settings = get_settings()

    db = SessionLocal()
    try:
        job = job_service.get_job(db, job_id)
        if not job:
            return

        run = job_service.mark_job_running(db, job)
        payload = job.payload_json

        handler = SCRIPT_HANDLERS.get(payload.get('job_type', ''))
        if not handler:
            raise ValueError(f"Unsupported job_type: {payload.get('job_type')}")

        upload_path = job_service.resolve_upload_path(settings, payload['file_id'])
        output_dir = settings.result_root / str(job.id)
        params = payload.get('params', {})
        if isinstance(params, dict):
            params = {**params, 'resolved_file_paths': _resolve_extra_file_ids(settings, params)}
        else:
            params = {}

        result = handler(str(upload_path), str(output_dir), params)

        job_service.mark_job_success(
            db,
            job,
            run,
            result_path=str(Path(result['result_path']).resolve()),
            log_excerpt=result.get('message'),
        )
    except Exception as error:  # noqa: BLE001
        if 'job' in locals() and job is not None:
            if 'run' not in locals():
                run = job_service.mark_job_running(db, job)
            job_service.mark_job_failed(db, job, run, str(error))
    finally:
        db.close()
