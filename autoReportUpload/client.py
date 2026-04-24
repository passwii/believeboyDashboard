"""
数字员工心跳客户端 - autoReportUpload 通过此模块向后端上报状态。
"""

import os
import httpx
from dataclasses import dataclass
from datetime import datetime

from config import API_BASE

API_KEY = os.environ.get("API_KEY", "")
EMPLOYEE_ID = int(os.environ.get("DIGITAL_EMPLOYEE_ID", "3"))
API_SECRET = os.environ.get("DIGITAL_EMPLOYEE_SECRET", "")


@dataclass
class HeartbeatPayload:
    task_id: str | None = None
    status: str | None = None
    progress_percent: int | None = None
    current_step: str | None = None
    message: str | None = None


def _payload_to_dict(payload: HeartbeatPayload) -> dict:
    result = {}
    if payload.task_id is not None:
        result["task_id"] = payload.task_id
    if payload.status is not None:
        result["status"] = payload.status
    if payload.progress_percent is not None:
        result["progress_percent"] = payload.progress_percent
    if payload.current_step is not None:
        result["current_step"] = payload.current_step
    if payload.message is not None:
        result["message"] = payload.message
    return result


def send_heartbeat(payload: HeartbeatPayload) -> bool:
    """向数字员工心跳端点发送状态上报"""
    if not API_SECRET:
        return False
    try:
        with httpx.Client(timeout=10) as client:
            resp = client.post(
                f"{API_BASE}/api/v1/digital-employees/{EMPLOYEE_ID}/heartbeat",
                headers={
                    "X-API-Key": API_KEY,
                    "Content-Type": "application/json",
                },
                params={"api_secret": API_SECRET},
                json=_payload_to_dict(payload),
            )
            return resp.status_code == 200
    except Exception:
        return False


def report_scan_start(project_name: str) -> str:
    """上报扫描开始，返回 task_id"""
    task_id = f"rpa-scan-{datetime.now().strftime('%Y%m%d%H%M%S')}"
    send_heartbeat(HeartbeatPayload(
        task_id=task_id,
        status="RUNNING",
        progress_percent=0,
        current_step=f"开始扫描项目: {project_name}",
        message=f"定时扫描开始",
    ))
    return task_id


def report_scan_progress(task_id: str, step: str, files_seen: int, files_done: int) -> None:
    """上报扫描进度"""
    progress = min(99, int(files_done / max(files_seen, 1) * 100))
    send_heartbeat(HeartbeatPayload(
        task_id=task_id,
        status="RUNNING",
        progress_percent=progress,
        current_step=step,
        message=f"处理文件 {files_done}/{files_seen}",
    ))


def report_scan_complete(task_id: str, stats: dict) -> None:
    """上报扫描完成"""
    send_heartbeat(HeartbeatPayload(
        task_id=task_id,
        status="SUCCEEDED",
        progress_percent=100,
        current_step="扫描完成",
        message=f"完成: {stats['files_seen']} 文件, {stats['success']} 成功, {stats['failed']} 失败",
    ))


def report_scan_error(task_id: str, error: str) -> None:
    """上报扫描异常"""
    send_heartbeat(HeartbeatPayload(
        task_id=task_id,
        status="FAILED",
        progress_percent=100,
        current_step="扫描异常",
        message=error,
    ))


def trigger_pt1_recompute(
    project_id: int,
    country: str,
    period_start_date: str,
    period_end_date: str,
) -> bool:
    """
    Call backend to trigger PT1 recompute for a single period.
    Used by processor.py after source files are successfully persisted.
    """
    if not API_KEY:
        return False
    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(
                f"{API_BASE}/api/v1/product-analysis/trigger-recompute",
                headers={"X-API-Key": API_KEY},
                params={
                    "project_id": str(project_id),
                    "country": country,
                    "period_start_date": period_start_date,
                    "period_end_date": period_end_date,
                },
            )
            return resp.status_code == 200
    except Exception:
        return False