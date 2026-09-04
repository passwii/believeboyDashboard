from datetime import UTC, datetime, timedelta

from app.services.digital.playback_engine import (
    PlaybackConfig,
    PlaybackState,
    RealTask,
    advance,
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


def _task(task_id="t1", status="RUNNING", started=T0, ended=None, step=None, meta=None):
    return RealTask(
        task_id=task_id, task_name="润茗/payment_report", task_type="payment_report",
        status=status, progress_percent=0, current_step=step,
        started_at=started, ended_at=ended, metadata=meta or {"project_name": "润茗", "report_label": "Payment Report"},
    )


def test_empty_tasks_idle():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [], T0, CFG)
    assert snap.display_status == "IDLE"


def test_stale_heartbeat_offline():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [], T0, CFG, last_heartbeat_at=T0 - timedelta(seconds=3600))
    assert snap.display_status == "OFFLINE"


def test_first_task_starts_working_with_stretched_duration():
    state = PlaybackState(employee_id=1)
    new, snap = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0, CFG)
    assert snap.display_status == "WORKING"
    assert new.current_task_id == "t1"
    assert new.display_duration_s == 3600.0  # 5min 真实 → 1h 展示


def test_progress_smooth_and_monotonic():
    state = PlaybackState(
        employee_id=1, current_task_id="t1",
        display_started_at=T0, display_duration_s=3600.0,
    )
    _, snap_a = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=1800), CFG)
    _, snap_b = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=1980), CFG)
    assert snap_a.virtual_progress == 50.0
    assert snap_b.virtual_progress > snap_a.virtual_progress
    assert snap_b.virtual_progress < 100.0


def test_completion_inserts_pause():
    state = PlaybackState(
        employee_id=1, current_task_id="t1",
        display_started_at=T0, display_duration_s=3600.0,
    )
    new, snap = advance(state, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=3600), CFG)
    assert snap.virtual_progress == 100.0
    assert new.virtual_index == 1
    assert new.pause_until is not None
    # 停顿窗口内再次 advance → PAUSING
    _, snap2 = advance(new, [_task(ended=T0 + timedelta(seconds=300))], T0 + timedelta(seconds=3601), CFG)
    assert snap2.display_status == "PAUSING"


def test_queue_builds_up_pace():
    tasks = [
        _task(task_id=f"t{i}", started=T0 + timedelta(seconds=i), ended=T0 + timedelta(seconds=60 + i))
        for i in range(6)
    ]
    state = PlaybackState(employee_id=1)
    new, snap = advance(state, tasks, T0, CFG)
    # 当前 1 个 + 排队 5 个 → pace = 1 + (5-1)*0.5 = 3.0
    assert snap.pace == 3.0
    assert snap.queued_count == 5
    assert snap.busy_level in ("BUSY", "SWAMPED")


def test_failed_task_label_has_warning_prefix():
    state = PlaybackState(employee_id=1)
    _, snap = advance(state, [_task(status="FAILED", ended=T0 + timedelta(seconds=300))], T0, CFG)
    assert "⚠️" in snap.step_label