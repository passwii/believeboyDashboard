"""数字员工拟人化伸展引擎（纯逻辑，无 DB）。

把"脉冲式"真实任务流拉伸成平滑的"虚拟当前状态"：短任务拉伸到
[min_display, max_display] 慢慢演、任务间插入拟人化停顿、排队越多 pace
越大（加速消化）、据 pace/排队判定 busy_level。节奏常量集中在 PlaybackConfig。
"""
from __future__ import annotations

from dataclasses import dataclass


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