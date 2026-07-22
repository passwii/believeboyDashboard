from __future__ import annotations

import json
from datetime import datetime, UTC

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.digital_employee import DigitalEmployee, DigitalEmployeeTask
from app.models.digital_employee_playback import DigitalEmployeePlayback
from app.services.digital.playback_engine import (
    DEFAULT_CONFIG,
    PlaybackState,
    RealTask,
    advance,
)

PERSONA_BY_TYPE = {
    "auto_report_upload": {"emoji": "📤", "color_key": "blue", "tagline": "报表快递员"},
    "scheduled_job": {"emoji": "⏰", "color_key": "orange", "tagline": "定时指挥官"},
    "rpa_bot": {"emoji": "🤖", "color_key": "violet", "tagline": "流程机器人"},
    "ai_agent": {"emoji": "💬", "color_key": "emerald", "tagline": "洞察分析师"},
    "monitoring": {"emoji": "📊", "color_key": "pink", "tagline": "数据观察员"},
    "database": {"emoji": "🗄️", "color_key": "slate", "tagline": "数据库守护者"},
    "custom": {"emoji": "⚙️", "color_key": "gray", "tagline": "自定义任务"},
}


def _load_state(db: Session, employee_id: int) -> tuple[PlaybackState, DigitalEmployeePlayback]:
    row = db.get(DigitalEmployeePlayback, employee_id)
    if row is None:
        row = DigitalEmployeePlayback(employee_id=employee_id)
        db.add(row)
        db.flush()
    state = PlaybackState(
        employee_id=row.employee_id, virtual_index=row.virtual_index,
        current_task_id=row.current_task_id, virtual_progress=row.virtual_progress,
        display_started_at=row.display_started_at, display_duration_s=row.display_duration_s,
        pause_until=row.pause_until, pace=row.pace, busy_level=row.busy_level,
        last_advanced_at=row.last_advanced_at,
    )
    return state, row


def _persist(row: DigitalEmployeePlayback, state: PlaybackState) -> None:
    row.virtual_index = state.virtual_index
    row.current_task_id = state.current_task_id
    row.virtual_progress = state.virtual_progress
    row.display_started_at = state.display_started_at
    row.display_duration_s = state.display_duration_s
    row.pause_until = state.pause_until
    row.pace = state.pace
    row.busy_level = state.busy_level
    row.last_advanced_at = state.last_advanced_at


def _to_real_tasks(rows: list[DigitalEmployeeTask]) -> list[RealTask]:
    out = []
    for t in rows:
        meta = None
        if t.metadata_json:
            try:
                meta = json.loads(t.metadata_json)
            except (ValueError, TypeError):
                meta = None
        out.append(RealTask(
            task_id=t.task_id, task_name=t.task_name, task_type=t.task_type,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            progress_percent=t.progress_percent, current_step=t.current_step,
            started_at=t.started_at or t.created_at, ended_at=t.ended_at, metadata=meta,
        ))
    return out


def advance_employee(db: Session, employee: DigitalEmployee, now: datetime) -> dict:
    state, row = _load_state(db, employee.id)
    task_rows = list(db.execute(
        select(DigitalEmployeeTask)
        .where(DigitalEmployeeTask.employee_id == employee.id)
        .order_by(DigitalEmployeeTask.started_at.asc())
    ).scalars().all())
    new_state, snap = advance(state, _to_real_tasks(task_rows), now, DEFAULT_CONFIG, employee.last_heartbeat_at)
    _persist(row, new_state)
    db.commit()
    return _enrich(employee, snap, task_rows)


def _enrich(employee: DigitalEmployee, snap, task_rows: list[DigitalEmployeeTask]) -> dict:
    persona = dict(PERSONA_BY_TYPE.get(employee.employee_type.value, PERSONA_BY_TYPE["custom"]))
    meta = snap.current_task.metadata if snap.current_task else None
    today_done = sum(1 for t in task_rows if (t.status.value if hasattr(t.status, "value") else t.status) == "succeeded")
    total = len(task_rows) or 1
    succeeded = today_done
    return {
        "employee_id": employee.id,
        "name": employee.name,
        "persona": persona,
        "display_status": snap.display_status,
        "busy_level": snap.busy_level,
        "queued_count": snap.queued_count,
        "pace": snap.pace,
        "current_task": (
            {"task_id": snap.current_task.task_id, "task_name": snap.current_task.task_name, "status": snap.current_task.status}
            if snap.current_task else None
        ),
        "work_item": {"project_name": (meta or {}).get("project_name"), "report_label": (meta or {}).get("report_label")},
        "virtual_progress": snap.virtual_progress,
        "step_label": snap.step_label,
        "today_done": today_done,
        "success_rate": round(succeeded / total, 2),
        "last_heartbeat_at": employee.last_heartbeat_at.isoformat() if employee.last_heartbeat_at else None,
    }


def build_wall_snapshot(db: Session, now: datetime) -> list[dict]:
    employees = list(db.execute(
        select(DigitalEmployee).where(DigitalEmployee.is_deleted == 0)
    ).scalars().all())
    return [advance_employee(db, e, now) for e in employees]
