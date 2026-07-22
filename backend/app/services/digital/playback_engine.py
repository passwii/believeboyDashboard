"""数字员工拟人化伸展引擎（纯逻辑，无 DB）。

把"脉冲式"真实任务流拉伸成平滑的"虚拟当前状态"：短任务拉伸到
[min_display, max_display] 慢慢演、任务间插入拟人化停顿、排队越多 pace
越大（加速消化）、据 pace/排队判定 busy_level。节奏常量集中在 PlaybackConfig。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from datetime import datetime, timedelta


@dataclass(frozen=True)
class RealTask:
    task_id: str
    task_name: str
    task_type: str
    status: str
    progress_percent: int
    current_step: str | None
    started_at: datetime
    ended_at: datetime | None
    metadata: dict | None = None


@dataclass
class PlaybackState:
    employee_id: int
    virtual_index: int = 0
    current_task_id: str | None = None
    virtual_progress: float = 0.0
    display_started_at: datetime | None = None
    display_duration_s: float = 0.0
    pause_until: datetime | None = None
    pace: float = 1.0
    busy_level: str = "IDLE"
    last_advanced_at: datetime | None = None


@dataclass(frozen=True)
class VirtualSnapshot:
    employee_id: int
    display_status: str
    current_task: RealTask | None
    virtual_progress: float
    step_label: str
    pace: float
    busy_level: str
    queued_count: int


@dataclass(frozen=True)
class PlaybackConfig:
    stretch_factor: float = 12.0
    min_display_s: float = 1800.0
    max_display_s: float = 7200.0
    calm_queue: int = 1
    pace_per_extra: float = 0.5
    max_pace: float = 6.0
    pause_min_s: float = 90.0
    pause_max_s: float = 300.0
    offline_after_s: float = 1800.0


DEFAULT_CONFIG = PlaybackConfig()


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def stretch_duration_s(real_dur_s: float, pace: float, cfg: PlaybackConfig = DEFAULT_CONFIG) -> float:
    base = clamp(real_dur_s * cfg.stretch_factor, cfg.min_display_s, cfg.max_display_s)
    return base / max(pace, 1.0)


def compute_pace(queued: int, cfg: PlaybackConfig = DEFAULT_CONFIG) -> float:
    if queued <= cfg.calm_queue:
        return 1.0
    return clamp(1.0 + (queued - cfg.calm_queue) * cfg.pace_per_extra, 1.0, cfg.max_pace)


def classify_busy(total_pending: int, pace: float) -> str:
    if total_pending == 0:
        return "IDLE"
    if pace < 1.5:
        return "NORMAL"
    if pace < 3.0:
        return "BUSY"
    return "SWAMPED"


def _real_duration_s(task: RealTask, now: datetime) -> float:
    end = task.ended_at or now
    return max((end - task.started_at).total_seconds(), 1.0)


def _pause_seconds(employee_id: int, virtual_index: int, pace: float, cfg: PlaybackConfig) -> float:
    seed = hashlib.md5(f"{employee_id}:{virtual_index}".encode()).hexdigest()
    frac = int(seed[:8], 16) / 0xFFFFFFFF
    base = cfg.pause_min_s + (cfg.pause_max_s - cfg.pause_min_s) * frac
    return base / max(pace, 1.0)


def _step_label(task: RealTask) -> str:
    meta = task.metadata or {}
    project = meta.get("project_name") or ""
    report = meta.get("report_label") or task.task_name
    prefix = "⚠️ " if task.status.upper() == "FAILED" else ""
    if task.current_step:
        return f"{prefix}{task.current_step}"
    if project:
        return f"{prefix}正在处理【{project}】的 {report}…"
    return f"{prefix}正在处理 {report}…"


def advance(
    state: PlaybackState,
    real_tasks: list[RealTask],
    now: datetime,
    cfg: PlaybackConfig = DEFAULT_CONFIG,
    last_heartbeat_at: datetime | None = None,
) -> tuple[PlaybackState, VirtualSnapshot]:
    ordered = sorted(real_tasks, key=lambda t: t.started_at)
    pending = ordered[state.virtual_index:]
    current = next((t for t in pending if t.task_id == state.current_task_id), None)
    if current is None and pending:
        queued = len(pending) - 1
    else:
        queued = len(pending) - (1 if current else 0)
    pace = compute_pace(queued, cfg)
    busy = classify_busy(len(pending), pace)

    def snap(status: str, task: RealTask | None, progress: float, label: str) -> VirtualSnapshot:
        return VirtualSnapshot(
            employee_id=state.employee_id, display_status=status, current_task=task,
            virtual_progress=round(progress, 1), step_label=label,
            pace=pace, busy_level=busy, queued_count=queued,
        )

    new = replace(state, pace=pace, busy_level=busy, last_advanced_at=now)

    if new.pause_until and now < new.pause_until:
        return new, snap("PAUSING", current, new.virtual_progress, "🍵 稍作整理…")

    if current is None:
        if pending:
            nxt = pending[0]
            new.current_task_id = nxt.task_id
            new.display_started_at = now
            new.display_duration_s = stretch_duration_s(_real_duration_s(nxt, now), pace, cfg)
            new.virtual_progress = 0.0
            new.pause_until = None
            return new, snap("WORKING", nxt, 0.0, _step_label(nxt))
        new.current_task_id = None
        new.virtual_progress = 0.0
        if last_heartbeat_at and (now - last_heartbeat_at).total_seconds() > cfg.offline_after_s:
            return new, snap("OFFLINE", None, 0.0, "🌙 今日工作告一段落")
        return new, snap("IDLE", None, 0.0, "🍵 静候下一批任务…")

    elapsed = (now - (new.display_started_at or now)).total_seconds()
    progress = clamp(elapsed / max(new.display_duration_s, 1.0) * 100.0, 0.0, 100.0)
    new.virtual_progress = progress

    if progress >= 100.0:
        new.virtual_index = state.virtual_index + 1
        new.current_task_id = None
        new.pause_until = now + timedelta(
            seconds=_pause_seconds(state.employee_id, new.virtual_index, pace, cfg)
        )
        label = "✅ 处理完成，整理中…" if current.status.upper() != "FAILED" else "⚠️ 处理失败，正在排查…"
        return new, snap("PAUSING", current, 100.0, label)

    return new, snap("WORKING", current, progress, _step_label(current))