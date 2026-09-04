"""虚拟办公室编排：读真实任务 → 伸展引擎 advance → 持久化游标 → 富化展示字段。

FIX-2: 只查 virtual_index 之后的待播任务，不加载全量历史。
FIX-3: today_done / success_rate 只统计当日任务。
FIX-4: advance_employee 不自行 commit，由 build_wall_snapshot 统一提交。
P3-A: chatter 事件检测（状态转换 → 拟人化动态文案）。
"""
from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

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

logger = logging.getLogger(__name__)

PERSONA_BY_TYPE = {
    "auto_report_upload": {"emoji": "📤", "color_key": "blue", "tagline": "报表快递员"},
    "scheduled_job": {"emoji": "⏰", "color_key": "orange", "tagline": "定时指挥官"},
    "rpa_bot": {"emoji": "🤖", "color_key": "violet", "tagline": "流程机器人"},
    "ai_agent": {"emoji": "💬", "color_key": "emerald", "tagline": "洞察分析师"},
    "monitoring": {"emoji": "📊", "color_key": "pink", "tagline": "数据观察员"},
    "database": {"emoji": "🗄️", "color_key": "slate", "tagline": "数据库守护者"},
    "custom": {"emoji": "⚙️", "color_key": "gray", "tagline": "自定义任务"},
}

# 每次 advance 最多加载的待播任务数（防止历史任务无限增长拖慢查询）
MAX_PENDING_TASKS = 200


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


def _today_stats(db: Session, employee_id: int, now: datetime) -> tuple[int, float]:
    """FIX-3: 只统计当日任务。返回 (today_done, success_rate)。"""
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(
        select(DigitalEmployeeTask.status)
        .where(
            DigitalEmployeeTask.employee_id == employee_id,
            DigitalEmployeeTask.started_at >= today_start,
        )
    ).scalars().all()
    total = len(rows)
    if total == 0:
        return 0, 1.0
    succeeded = sum(
        1 for s in rows if (s.value if hasattr(s, "value") else str(s)) == "succeeded"
    )
    return succeeded, round(succeeded / total, 2)


def _detect_chatter(
    old_state: PlaybackState,
    new_engine: PlaybackState,
    snap,
    employee: DigitalEmployee,
    now: datetime,
) -> list[dict]:
    """P3-A: 比较 advance 前后状态，检测转换事件并生成拟人化 chatter。

    返回 chatter 事件列表（可能为空）。每个事件：
    {employee_id, name, emoji, event_type, text, timestamp}
    """
    persona = PERSONA_BY_TYPE.get(
        employee.employee_type.value, PERSONA_BY_TYPE["custom"],
    )
    events: list[dict] = []

    def _emit(event_type: str, text: str):
        events.append({
            "employee_id": employee.id,
            "name": employee.name,
            "emoji": persona["emoji"],
            "event_type": event_type,
            "text": text,
            "timestamp": now.isoformat(),
        })

    meta = snap.current_task.metadata if snap.current_task else None
    project = (meta or {}).get("project_name") or ""
    report = (meta or {}).get("report_label") or ""
    work_label = f"【{project}】{report}" if project else (report or snap.current_task.task_name if snap.current_task else "任务")

    # 任务完成（virtual_index 递增）
    if new_engine.virtual_index > 0 and snap.current_task:
        if snap.current_task.status.upper() == "FAILED":
            _emit("task_failed", f"😵 {work_label} 卡住了，需要人帮忙")
        else:
            _emit("task_completed", f"✅ 完成了 {work_label}")

    # 新任务开始（之前没有 current_task，现在有了）
    elif old_state.current_task_id is None and new_engine.current_task_id is not None:
        _emit("task_started", f"📋 开始处理 {work_label}")

    # 进入停顿（之前没 pause，现在有 pause，且不是因为任务完成）
    elif old_state.pause_until is None and new_engine.pause_until is not None and new_engine.virtual_index == 0:
        _emit("pause_started", "🍵 稍作整理，喝口水…")

    # 离线检测
    if snap.display_status == "OFFLINE" and old_state.last_advanced_at is not None:
        _emit("went_offline", "🌙 今日工作告一段落")

    return events


def advance_employee(db: Session, employee: DigitalEmployee, now: datetime) -> tuple[dict, list[dict]]:
    """推进单个员工的虚拟播放状态。

    FIX-2: 只查 virtual_index 之后的待播任务。
    FIX-4: 不自行 commit，由 build_wall_snapshot 统一提交。
    P3-A: 返回 (snapshot_dict, chatter_events)。
    """
    state, row = _load_state(db, employee.id)

    # FIX-2: 只加载尚未播完的任务（跳过已播完的历史）
    pending_rows = list(db.execute(
        select(DigitalEmployeeTask)
        .where(DigitalEmployeeTask.employee_id == employee.id)
        .order_by(DigitalEmployeeTask.started_at.asc())
        .offset(state.virtual_index)
        .limit(MAX_PENDING_TASKS)
    ).scalars().all())

    # 引擎以 virtual_index=0 视角处理这批任务
    engine_state = PlaybackState(
        employee_id=state.employee_id,
        virtual_index=0,
        current_task_id=state.current_task_id,
        virtual_progress=state.virtual_progress,
        display_started_at=state.display_started_at,
        display_duration_s=state.display_duration_s,
        pause_until=state.pause_until,
        pace=state.pace,
        busy_level=state.busy_level,
        last_advanced_at=state.last_advanced_at,
    )
    new_engine, snap = advance(
        engine_state, _to_real_tasks(pending_rows), now, DEFAULT_CONFIG,
        employee.last_heartbeat_at,
    )

    # P3-A: 检测状态转换 → chatter 事件
    chatter = _detect_chatter(state, new_engine, snap, employee, now)

    # 映射回绝对 virtual_index
    new_state = PlaybackState(
        employee_id=state.employee_id,
        virtual_index=state.virtual_index + new_engine.virtual_index,
        current_task_id=new_engine.current_task_id,
        virtual_progress=new_engine.virtual_progress,
        display_started_at=new_engine.display_started_at,
        display_duration_s=new_engine.display_duration_s,
        pause_until=new_engine.pause_until,
        pace=new_engine.pace,
        busy_level=new_engine.busy_level,
        last_advanced_at=new_engine.last_advanced_at,
    )
    _persist(row, new_state)

    return _enrich(db, employee, snap, now), chatter


def _enrich(db: Session, employee: DigitalEmployee, snap, now: datetime) -> dict:
    persona = dict(PERSONA_BY_TYPE.get(
        employee.employee_type.value, PERSONA_BY_TYPE["custom"],
    ))
    meta = snap.current_task.metadata if snap.current_task else None
    today_done, success_rate = _today_stats(db, employee.id, now)
    return {
        "employee_id": employee.id,
        "name": employee.name,
        "persona": persona,
        "display_status": snap.display_status,
        "busy_level": snap.busy_level,
        "queued_count": snap.queued_count,
        "pace": snap.pace,
        "current_task": (
            {
                "task_id": snap.current_task.task_id,
                "task_name": snap.current_task.task_name,
                "status": snap.current_task.status,
            }
            if snap.current_task else None
        ),
        "work_item": {
            "project_name": (meta or {}).get("project_name"),
            "report_label": (meta or {}).get("report_label"),
        },
        "virtual_progress": snap.virtual_progress,
        "step_label": snap.step_label,
        "today_done": today_done,
        "success_rate": success_rate,
        "last_heartbeat_at": (
            employee.last_heartbeat_at.isoformat() if employee.last_heartbeat_at else None
        ),
    }


def build_wall_snapshot(db: Session, now: datetime) -> tuple[list[dict], list[dict]]:
    """推进所有员工并返回整墙快照 + chatter 事件。

    FIX-4: 用 SAVEPOINT 隔离单员工失败，统一一次 commit。
    P3-A: 返回 (employees, chatter_events)。
    """
    employees = list(db.execute(
        select(DigitalEmployee).where(DigitalEmployee.is_deleted == 0)
    ).scalars().all())
    results = []
    all_chatter = []
    for e in employees:
        try:
            with db.begin_nested():  # SAVEPOINT：单员工失败不影响其他
                snapshot, chatter = advance_employee(db, e, now)
                results.append(snapshot)
                all_chatter.extend(chatter)
        except Exception:
            logger.exception("advance_employee failed for employee %s", e.id)
    db.commit()
    return results, all_chatter
