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
from . import product_analysis_source_service, redis_service

logger = logging.getLogger(__name__)
_TASK_TTL_SECONDS = 24 * 60 * 60


@dataclass
class AnalysisReportTask:
    id: int
    report_type: str
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
_TASKS: dict[int, AnalysisReportTask] = {}
_TASKS_LOCK = Lock()


def _is_terminal(task: AnalysisReportTask) -> bool:
    return task.status in {JobStatus.success, JobStatus.failed}


def _prune_tasks_locked(now: datetime) -> None:
    stale_ids = [
        task_id
        for task_id, task in _TASKS.items()
        if _is_terminal(task)
        and (now - task.updated_at).total_seconds() > _TASK_TTL_SECONDS
    ]
    for task_id in stale_ids:
        _TASKS.pop(task_id, None)


def create_task(
    settings: Settings,
    *,
    report_type: str,
    input_path: str,
    params: dict[str, Any],
) -> AnalysisReportTask:
    if report_type not in {"daily_report", "product_analysis"}:
        raise ValueError(f"Unsupported report_type: {report_type}")

    now = datetime.now(UTC)
    task = AnalysisReportTask(
        id=next(_TASK_ID_COUNTER),
        report_type=report_type,
        status=JobStatus.pending,
        stage="started",
        progress=1,
        message="处理中：任务已接收",
        error_message=None,
        result_path=None,
        persistence_status="idle",
        persistence_message=None,
        created_at=now,
        updated_at=now,
    )
    payload = {
        "settings": settings,
        "report_type": report_type,
        "input_path": input_path,
        "params": params,
    }

    with _TASKS_LOCK:
        _prune_tasks_locked(now)
        _TASKS[task.id] = task

    thread = Thread(
        target=_run_task,
        args=(task.id, payload),
        daemon=True,
        name=f"{report_type}-runtime-{task.id}",
    )
    thread.start()
    return task


def get_task(task_id: int) -> AnalysisReportTask | None:
    with _TASKS_LOCK:
        _prune_tasks_locked(datetime.now(UTC))
        task = _TASKS.get(task_id)
        return replace(task) if task is not None else None


def update_task_progress(
    task_id: int, *, stage: str, progress: int, message: str | None
) -> None:
    safe_progress = max(0, min(100, int(progress)))
    with _TASKS_LOCK:
        task = _TASKS.get(task_id)
        if task is None:
            return
        task.stage = stage
        task.progress = safe_progress
        task.message = message
        task.updated_at = datetime.now(UTC)


def mark_task_running(
    task_id: int, *, stage: str, progress: int, message: str | None
) -> None:
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
        task.stage = "completed"
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
        task.stage = "failed"
        task.progress = 100
        task.message = f"处理失败：{error_message}"
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


def _run_task(task_id: int, payload: dict[str, Any]) -> None:
    try:
        settings: Settings = payload["settings"]
        report_type = str(payload["report_type"])
        input_path = Path(str(payload["input_path"]))
        params = payload["params"] if isinstance(payload.get("params"), dict) else {}

        handler = SCRIPT_HANDLERS.get(report_type)
        if handler is None:
            raise ValueError(f"Unsupported report_type: {report_type}")

        params = {
            **params,
            "_progress_callback": lambda stage, progress, message: update_task_progress(
                task_id,
                stage=stage,
                progress=progress,
                message=message,
            ),
        }

        output_dir = settings.result_root / f"{report_type}-runtime-{task_id}"
        mark_task_running(
            task_id, stage="processing", progress=10, message="处理中：开始执行核算逻辑"
        )
        result = handler(str(input_path), str(output_dir), params)
        result_path = str(Path(result["result_path"]).resolve())
        mark_task_success(task_id, result_path, "处理完成：报表已生成，可下载")
        if report_type == "product_analysis":
            set_persistence_state(
                task_id, status="running", message="后台同步中：正在写入数据库"
            )
            persist_thread = Thread(
                target=_persist_product_analysis_sources,
                args=(task_id, params, result),
                daemon=True,
                name=f"product-analysis-persist-{task_id}",
            )
            persist_thread.start()
        elif report_type == "daily_report":
            set_persistence_state(
                task_id, status="running", message="后台同步中：正在写入数据库"
            )
            persist_thread = Thread(
                target=_persist_single_date_report_sources,
                args=(task_id, params),
                daemon=True,
                name=f"daily-report-persist-{task_id}",
            )
            persist_thread.start()
    except Exception as exc:  # noqa: BLE001
        logger.exception("analysis runtime task failed: %s", exc)
        mark_task_failed(task_id, str(exc))


def _persist_product_analysis_sources(
    task_id: int, params: dict[str, Any], result: dict[str, Any]
) -> None:
    db = SessionLocal()
    try:
        report_start_date = str(params.get("report_start_date") or "").strip()
        report_end_date = str(params.get("report_end_date") or "").strip()
        project_name = str(params.get("project_name") or "").strip()
        country = str(params.get("country") or "US").strip() or "US"
        file_ids = (
            params.get("file_ids") if isinstance(params.get("file_ids"), dict) else {}
        )
        resolved_file_paths = (
            params.get("resolved_file_paths")
            if isinstance(params.get("resolved_file_paths"), dict)
            else {}
        )
        created_by = str(params.get("operator") or "").strip() or None

        outcomes = product_analysis_source_service.persist_product_analysis_sources(
            db,
            project_name=project_name,
            report_start_date=report_start_date,
            report_end_date=report_end_date,
            country=country,
            file_ids=file_ids,
            resolved_file_paths=resolved_file_paths,
            created_by=created_by,
        )
        failed = [item for item in outcomes if not item.success]
        if failed:
            details = "; ".join(
                f"{item.report_type}: {(item.error_message or 'unknown error')[:120]}"
                for item in failed
            )
            set_persistence_state(
                task_id, status="failed", message=f"后台同步失败：{details}"
            )
            return
        pt1_payload = result.get("pt1")
        product_analysis_source_service.persist_product_analysis_pt1_calculation(
            db,
            project_name=project_name,
            report_start_date=report_start_date,
            report_end_date=report_end_date,
            pt1=pt1_payload if isinstance(pt1_payload, dict) else {},
            result_file_path=str(result.get("result_path") or "").strip() or None,
            calculation_version=1,
        )
        db.commit()
        set_persistence_state(
            task_id, status="success", message="后台同步完成：数据库已更新"
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("product analysis persistence failed: %s", exc)
        set_persistence_state(task_id, status="failed", message=f"后台同步失败：{exc}")
    finally:
        db.close()


def _persist_single_date_report_sources(task_id: int, params: dict[str, Any]) -> None:
    db = SessionLocal()
    try:
        report_date = str(params.get("report_date") or "").strip()
        project_name = str(params.get("project_name") or "").strip()
        country = str(params.get("country") or "US").strip() or "US"
        file_ids = (
            params.get("file_ids") if isinstance(params.get("file_ids"), dict) else {}
        )
        resolved_file_paths = (
            params.get("resolved_file_paths")
            if isinstance(params.get("resolved_file_paths"), dict)
            else {}
        )
        created_by = str(params.get("operator") or "").strip() or None

        outcomes = product_analysis_source_service.persist_single_date_report_sources(
            db,
            project_name=project_name,
            report_date=report_date,
            country=country,
            file_ids=file_ids,
            resolved_file_paths=resolved_file_paths,
            created_by=created_by,
        )
        failed = [item for item in outcomes if not item.success]
        if failed:
            details = "; ".join(
                f"{item.report_type}: {(item.error_message or 'unknown error')[:120]}"
                for item in failed
            )
            set_persistence_state(
                task_id, status="failed", message=f"后台同步失败：{details}"
            )
            return
        set_persistence_state(
            task_id, status="success", message="后台同步完成：数据库已更新"
        )

        project_id = params.get("project_id")
        if project_id:
            try:
                redis_service.invalidate_daily_analysis_cache(int(project_id))
            except (ValueError, TypeError):
                pass
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("single-date report persistence failed: %s", exc)
        set_persistence_state(task_id, status="failed", message=f"后台同步失败：{exc}")
    finally:
        db.close()
