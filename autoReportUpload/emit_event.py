"""
autoReportUpload → Digital Employee 上报。

调用 digital_employee_reporter 把每个报表处理任务注册到数字员工基础设施。
不在主流程上引入额外失败点：所有 DB 写入都包在 try/except 里，失败仅记日志。
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from sqlalchemy.orm import Session

# backend 在 sys.path 里已就绪（由 models.py 提前注入）
from app.services.digital_employee_reporter import (
    get_or_create_employee as _get_or_create_employee,
    start_task as _reporter_start_task,
    complete_task as _reporter_complete_task,
)

logger = logging.getLogger("autorun.emit_event")

EMPLOYEE_NAME = "AutoReport Upload"
EMPLOYEE_TYPE = "auto_report_upload"
EMPLOYEE_DESCRIPTION = "负责自动识别和上传 RPA 文件夹下的亚马逊报表"


# ── task_id 生成 ──────────────────────────────────────────────────────────────

_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


def _safe_task_id(*parts: Any) -> str:
    """生成稳定的 task_id，同一文件多次处理会复用同一 task_id。

    使用 SHA-1 hash 保证唯一性，避免中文等非 ASCII 字符被 regex 吞掉。
    """
    raw = "|".join(str(p) for p in parts if p is not None)
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
    # report_type 作为可读前缀（限 ASCII，最长 20 字符）
    prefix = str(parts[0]) if parts else "task"
    safe_prefix = _UNSAFE_CHARS.sub("-", prefix).strip("-")[:20]
    return f"aru-{safe_prefix}-{digest}"


# ── metadata 辅助 ─────────────────────────────────────────────────────────────


def _date_range_for(result) -> str | None:
    """把 detected_start_date / detected_end_date 压缩成 'MM-DD~DD' 格式。"""
    sd = getattr(result, "detected_start_date", None)
    ed = getattr(result, "detected_end_date", None)
    if not sd and not ed:
        return None
    if not sd:
        return ed[5:] if ed and len(ed) >= 10 else ed
    if not ed or sd == ed:
        return sd[5:] if len(sd) >= 10 else sd
    if sd[:7] == ed[:7]:
        return f"{sd[5:]}~{ed[8:]}" if len(ed) >= 10 else f"{sd[5:]}~{ed}"
    return f"{sd[5:]}~{ed[5:]}"


def _build_metadata(
    *,
    project_name: str | None,
    report_label: str,
    country: str | None,
    row_count: int | None,
    detected_date_range: str | None,
) -> str:
    """把项目/报表上下文序列化为 JSON 字符串，存入 task.metadata_json。"""
    return json.dumps(
        {
            "project_name": project_name or "_global",
            "report_label": report_label,
            "country": country or "US",
            "row_count": row_count or 0,
            "detected_date_range": detected_date_range or "",
        },
        ensure_ascii=False,
    )


# ── 上报函数 ──────────────────────────────────────────────────────────────────


def ensure_employee(db: Session) -> int | None:
    """确保数字员工存在，返回 employee_id；失败返回 None。"""
    try:
        emp = _get_or_create_employee(db, EMPLOYEE_NAME, EMPLOYEE_TYPE, EMPLOYEE_DESCRIPTION)
        return emp.id
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] 创建/获取员工失败: {exc}")
        return None


def emit_start(
    db: Session,
    *,
    project_name: str | None,
    report_type: str,
    report_label: str,
    country: str,
    source_file_name: str,
    row_count: int | None = None,
    detected_date_range: str | None = None,
) -> str | None:
    """上报任务开始。返回 task_id（用于后续 complete 调用），失败返回 None。"""
    employee_id = ensure_employee(db)
    if employee_id is None:
        return None

    task_id = _safe_task_id(report_type, project_name, country, source_file_name, detected_date_range)
    task_name = f"{project_name or '未匹配'}/{report_type}"
    metadata = _build_metadata(
        project_name=project_name,
        report_label=report_label,
        country=country,
        row_count=row_count,
        detected_date_range=detected_date_range,
    )

    try:
        _reporter_start_task(
            db,
            employee_id,
            task_id,
            task_name,
            report_type,
            metadata_json=metadata,
        )
        return task_id
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] start_task 失败: {exc}")
        try:
            db.rollback()
        except Exception:
            pass
        return None


def emit_complete(
    db: Session,
    *,
    task_id: str | None,
    success: bool,
    error_message: str | None = None,
) -> None:
    """上报任务完成。task_id 为 None 时跳过。"""
    if task_id is None:
        return
    try:
        _reporter_complete_task(db, task_id, success=success, error_message=error_message)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[emit_event] complete_task 失败: {exc}")
        try:
            db.rollback()
        except Exception:
            pass
