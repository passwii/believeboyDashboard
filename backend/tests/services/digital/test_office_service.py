"""office_service 单测 + 集成测试。

纯逻辑测试（不依赖 DB）始终跑；DB 集成测试需 TEST_DATABASE_URL。
覆盖 FIX-2（offset 查询）、FIX-3（today_stats）、FIX-4（统一 commit）。
"""
import os

# 占位 DATABASE_URL：让 Settings 校验通过（引擎惰性创建，纯逻辑测试不会真连接）。
# DB 集成测试由 conftest 的 _require_test_database() 控制 skip。
os.environ.setdefault("DATABASE_URL", "sqlite:///placeholder.db")

from datetime import UTC, datetime, timedelta

import pytest

from app.services.digital.office_service import (
    MAX_PENDING_TASKS,
    _to_real_tasks,
    _today_stats,
)
from app.services.digital.playback_engine import RealTask

T0 = datetime(2026, 7, 22, 9, 0, 0, tzinfo=UTC)


# ─── 纯逻辑测试（无 DB）───────────────────────────────────────────────────────


class _FakeTask:
    """模拟 DigitalEmployeeTask ORM 行。"""

    def __init__(self, task_id="t1", status_str="running", started=None, ended=None,
                 step=None, meta_json=None):
        self.task_id = task_id
        self.task_name = "润茗/payment_report"
        self.task_type = "payment_report"
        self.progress_percent = 50
        self.current_step = step
        self.started_at = started or T0
        self.ended_at = ended
        self.created_at = T0
        self.metadata_json = meta_json

        # 模拟 enum .value
        class _Status:
            value = status_str
        self.status = _Status()


def test_to_real_tasks_basic():
    rows = [_FakeTask(task_id="t1", status_str="running", step="数据识别")]
    result = _to_real_tasks(rows)
    assert len(result) == 1
    assert isinstance(result[0], RealTask)
    assert result[0].task_id == "t1"
    assert result[0].status == "running"
    assert result[0].current_step == "数据识别"


def test_to_real_tasks_parses_metadata_json():
    rows = [_FakeTask(meta_json='{"project_name": "润茗", "report_label": "Payment"}')]
    result = _to_real_tasks(rows)
    assert result[0].metadata == {"project_name": "润茗", "report_label": "Payment"}


def test_to_real_tasks_invalid_json_returns_none():
    rows = [_FakeTask(meta_json="not-json{{{")]
    result = _to_real_tasks(rows)
    assert result[0].metadata is None


def test_to_real_tasks_uses_created_at_when_started_at_is_none():
    row = _FakeTask(started=None)
    row.started_at = None
    result = _to_real_tasks([row])
    assert result[0].started_at == T0  # falls back to created_at


def test_to_real_tasks_empty_list():
    assert _to_real_tasks([]) == []


# ─── DB 集成测试（需 TEST_DATABASE_URL）───────────────────────────────────────


def _seed_employee_with_tasks(db_session, task_count=1, days_ago=0):
    """创建一个员工 + task_count 个任务。"""
    from app.models.digital_employee import (
        DigitalEmployee,
        DigitalEmployeeTask,
        EmployeeType,
        TaskStatus,
    )

    emp = DigitalEmployee(
        name="报表快递员",
        employee_type=EmployeeType.AUTO_REPORT_UPLOAD,
        api_secret=f"s3cret-{datetime.now(UTC).timestamp()}",
    )
    db_session.add(emp)
    db_session.commit()
    db_session.refresh(emp)

    base_time = datetime.now(UTC) - timedelta(days=days_ago)
    for i in range(task_count):
        task = DigitalEmployeeTask(
            employee_id=emp.id,
            task_id=f"aru-{emp.id}-{i}-{days_ago}",
            task_name=f"润茗/payment_report_{i}",
            task_type="payment_report",
            status=TaskStatus.SUCCEEDED,
            progress_percent=100,
            started_at=base_time - timedelta(seconds=300 * (task_count - i)),
            ended_at=base_time - timedelta(seconds=300 * (task_count - i) - 60),
            metadata_json='{"project_name": "润茗", "report_label": "Payment Report"}',
        )
        db_session.add(task)
    db_session.commit()
    return emp


def test_advance_employee_returns_snapshot_and_persists_cursor(db_session):
    from app.services.digital.office_service import advance_employee

    emp = _seed_employee_with_tasks(db_session, task_count=1)
    now = datetime.now(UTC)
    snap = advance_employee(db_session, emp, now)

    assert snap["employee_id"] == emp.id
    assert snap["display_status"] in ("WORKING", "PAUSING")
    assert snap["work_item"]["project_name"] == "润茗"
    assert snap["persona"]["emoji"] == "📤"

    # 再调一次：游标已持久化，virtual_progress 不回退
    snap2 = advance_employee(db_session, emp, now + timedelta(seconds=1))
    assert snap2["virtual_progress"] >= snap["virtual_progress"]


def test_advance_employee_virtual_index_advances(db_session):
    """FIX-2 验证：播完一个任务后 virtual_index 递增。"""
    from app.models.digital_employee_playback import DigitalEmployeePlayback
    from app.services.digital.office_service import advance_employee

    emp = _seed_employee_with_tasks(db_session, task_count=1)
    now = datetime.now(UTC)

    # 第一次 advance：开始播放
    advance_employee(db_session, emp, now)
    db_session.commit()

    row = db_session.get(DigitalEmployeePlayback, emp.id)
    assert row is not None
    initial_index = row.virtual_index

    # 快进到任务播完（display_duration 最多 2h，给 3h 足够）
    advance_employee(db_session, emp, now + timedelta(hours=3))
    db_session.commit()

    row = db_session.get(DigitalEmployeePlayback, emp.id)
    assert row.virtual_index > initial_index


def test_today_stats_only_counts_today(db_session):
    """FIX-3 验证：today_done 只统计当日任务。"""
    from app.services.digital.office_service import _today_stats

    # 创建今天的任务
    emp = _seed_employee_with_tasks(db_session, task_count=2, days_ago=0)
    # 创建昨天的任务
    _seed_employee_with_tasks(db_session, task_count=3, days_ago=1)

    now = datetime.now(UTC)
    today_done, rate = _today_stats(db_session, emp.id, now)

    # 只有今天的 2 个任务被统计
    assert today_done == 2
    assert rate == 1.0  # 全部 SUCCEEDED


def test_today_stats_empty_returns_defaults(db_session):
    """无任务时返回 (0, 1.0)。"""
    from app.models.digital_employee import DigitalEmployee, EmployeeType

    emp = DigitalEmployee(
        name="空员工",
        employee_type=EmployeeType.CUSTOM,
        api_secret=f"empty-{datetime.now(UTC).timestamp()}",
    )
    db_session.add(emp)
    db_session.commit()
    db_session.refresh(emp)

    done, rate = _today_stats(db_session, emp.id, datetime.now(UTC))
    assert done == 0
    assert rate == 1.0


def test_build_wall_snapshot_lists_all_active_employees(db_session):
    """FIX-4 验证：build_wall_snapshot 返回所有未删除员工。"""
    from app.services.digital.office_service import build_wall_snapshot

    _seed_employee_with_tasks(db_session, task_count=1)
    wall = build_wall_snapshot(db_session, datetime.now(UTC))

    assert isinstance(wall, list)
    assert len(wall) >= 1
    assert "persona" in wall[0]
    assert "display_status" in wall[0]
    assert "today_done" in wall[0]


def test_build_wall_snapshot_skips_deleted_employees(db_session):
    """已删除员工不出现在工牌墙。"""
    from app.models.digital_employee import DigitalEmployee, EmployeeType
    from app.services.digital.office_service import build_wall_snapshot

    emp = DigitalEmployee(
        name="已删除员工",
        employee_type=EmployeeType.CUSTOM,
        api_secret=f"deleted-{datetime.now(UTC).timestamp()}",
        is_deleted=1,
    )
    db_session.add(emp)
    db_session.commit()
    db_session.refresh(emp)

    wall = build_wall_snapshot(db_session, datetime.now(UTC))
    employee_ids = [w["employee_id"] for w in wall]
    assert emp.id not in employee_ids
