from datetime import datetime, timedelta, UTC

from app.services.digital.playback_engine import (
    PlaybackConfig,
    classify_busy,
    compute_pace,
    stretch_duration_s,
)

T0 = datetime(2026, 7, 22, 9, 0, 0, tzinfo=UTC)
CFG = PlaybackConfig()


def test_stretch_short_task_into_30min_to_2h():
    # 5 分钟真实 → 5*60*12=3600s=1h，落在 [1800, 7200]
    assert stretch_duration_s(300.0, 1.0, CFG) == 3600.0
    # 极短任务被抬到下限 30min
    assert stretch_duration_s(10.0, 1.0, CFG) == 1800.0
    # 极长任务被压到上限 2h
    assert stretch_duration_s(10_000.0, 1.0, CFG) == 7200.0


def test_stretch_busy_pace_shortens_display():
    base = stretch_duration_s(300.0, 1.0, CFG)
    busy = stretch_duration_s(300.0, 3.0, CFG)
    assert busy == base / 3.0


def test_compute_pace_calm_then_accelerate():
    assert compute_pace(0, CFG) == 1.0
    assert compute_pace(1, CFG) == 1.0          # calm_queue=1
    assert compute_pace(5, CFG) == 3.0          # 1 + (5-1)*0.5
    assert compute_pace(100, CFG) == CFG.max_pace  # 钳制上限


def test_classify_busy_levels():
    assert classify_busy(0, 1.0) == "IDLE"
    assert classify_busy(2, 1.0) == "NORMAL"
    assert classify_busy(4, 2.0) == "BUSY"
    assert classify_busy(10, 5.0) == "SWAMPED"