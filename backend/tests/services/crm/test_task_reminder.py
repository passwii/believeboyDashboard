"""task_service 提醒逻辑测试 (BLF-513) — 24h 扫描窗口 / reminded_at 去重 / owner 过滤 / 状态排除。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.crm import CrmTask
from app.services.crm.task_service import (
    list_user_reminder_tasks,
    mark_due_tasks_reminded,
)

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"

NOW = datetime(2026, 8, 8, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（独立 session + commit）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_tasks, crm_follows, crm_opportunities, "
                "crm_contacts, crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_task(
    db, *, owner=ALICE, due_date=None, status="pending", reminded_at=None, **kw
):
    t = CrmTask(
        title=kw.pop("title", "任务A"),
        owner_id=owner,
        due_date=due_date,
        status=status,
        reminded_at=reminded_at,
        **kw,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _now(delta_hours: float = 0) -> datetime:
    return NOW + timedelta(hours=delta_hours)


# ─── mark_due_tasks_reminded：扫描窗口 ────────────────────────────────────────


def test_mark_flags_task_within_24h_window(db_session):
    due = _now(12)
    t = _mk_task(db_session, due_date=due)
    marked = mark_due_tasks_reminded(db_session, now=NOW)
    assert marked == 1
    db_session.refresh(t)
    assert t.reminded_at == NOW


def test_mark_includes_due_exactly_at_24h_boundary(db_session):
    """边界：due_date == now+24h（闭区间）→ 标记。"""
    t = _mk_task(db_session, due_date=_now(24))
    marked = mark_due_tasks_reminded(db_session, now=NOW)
    assert marked == 1
    db_session.refresh(t)
    assert t.reminded_at == NOW


def test_mark_excludes_due_after_24h(db_session):
    """边界：due_date > now+24h → 不标记（还没进入提醒窗口）。"""
    t = _mk_task(db_session, due_date=_now(24) + timedelta(seconds=1))
    assert mark_due_tasks_reminded(db_session, now=NOW) == 0
    db_session.refresh(t)
    assert t.reminded_at is None


def test_mark_excludes_overdue_due_at_now(db_session):
    """边界：due_date <= now（逾期/刚好到期）→ 不标记（逾期不提醒）。"""
    t = _mk_task(db_session, due_date=_now(0))
    t2 = _mk_task(db_session, due_date=_now(-1))
    assert mark_due_tasks_reminded(db_session, now=NOW) == 0
    db_session.refresh(t)
    db_session.refresh(t2)
    assert t.reminded_at is None
    assert t2.reminded_at is None


def test_mark_ignores_null_due_date(db_session):
    """无截止时间 → 不参与提醒。"""
    t = _mk_task(db_session, due_date=None)
    assert mark_due_tasks_reminded(db_session, now=NOW) == 0
    db_session.refresh(t)
    assert t.reminded_at is None


def test_mark_excludes_done_and_cancelled(db_session):
    """done/cancelled 不提醒（扫描条件排除）。"""
    t1 = _mk_task(db_session, due_date=_now(12), status="done")
    t2 = _mk_task(db_session, due_date=_now(12), status="cancelled")
    assert mark_due_tasks_reminded(db_session, now=NOW) == 0
    db_session.refresh(t1)
    db_session.refresh(t2)
    assert t1.reminded_at is None
    assert t2.reminded_at is None


def test_mark_includes_in_progress(db_session):
    """in_progress 也提醒（pending + in_progress 都在扫描范围内）。"""
    t = _mk_task(db_session, due_date=_now(6), status="in_progress")
    assert mark_due_tasks_reminded(db_session, now=NOW) == 1
    db_session.refresh(t)
    assert t.reminded_at == NOW


def test_mark_idempotent_reminded_at_dedup(db_session):
    """同一任务只提醒一次：reminded_at 已置后再次扫描不再标记。"""
    _mk_task(db_session, due_date=_now(12))
    assert mark_due_tasks_reminded(db_session, now=NOW) == 1
    assert mark_due_tasks_reminded(db_session, now=NOW + timedelta(hours=1)) == 0


def test_mark_scans_all_owners(db_session):
    """扫描不按 owner 过滤（标记全量，SSE 端按当前用户过滤推送）。"""
    _mk_task(db_session, owner=ALICE, due_date=_now(12))
    _mk_task(db_session, owner=BOB, due_date=_now(12))
    assert mark_due_tasks_reminded(db_session, now=NOW) == 2


# ─── list_user_reminder_tasks：SSE 推送源 ─────────────────────────────────────


def test_list_user_reminders_owner_filter(db_session):
    """只返回当前用户的任务；他人任务不推送。"""
    mine = _mk_task(db_session, owner=ALICE, due_date=_now(12), reminded_at=NOW)
    _mk_task(db_session, owner=BOB, due_date=_now(12), reminded_at=NOW)
    rows = list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW)
    assert [r.id for r in rows] == [mine.id]


def test_list_user_reminders_requires_reminded_at(db_session):
    """reminded_at 为空（尚未被扫描标记）→ 不推送。"""
    _mk_task(db_session, owner=ALICE, due_date=_now(12), reminded_at=None)
    assert list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW) == []


def test_list_user_reminders_excludes_overdue(db_session):
    """due_date < now（已过期）→ 不再推送（逾期场景另有 toast 覆盖）。"""
    _mk_task(db_session, owner=ALICE, due_date=_now(-1), reminded_at=NOW)
    assert list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW) == []


def test_list_user_reminders_includes_due_at_now(db_session):
    """due_date == now 仍推送（未过期）。"""
    t = _mk_task(db_session, owner=ALICE, due_date=_now(0), reminded_at=NOW)
    rows = list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW)
    assert [r.id for r in rows] == [t.id]


def test_list_user_reminders_excludes_done_cancelled(db_session):
    """已 done/cancelled 的任务不再推送。"""
    _mk_task(db_session, owner=ALICE, due_date=_now(12), reminded_at=NOW, status="done")
    _mk_task(
        db_session, owner=ALICE, due_date=_now(12), reminded_at=NOW, status="cancelled"
    )
    assert list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW) == []


def test_list_user_reminders_excludes_null_due(db_session):
    """无截止时间（reminded_at 也不可能被扫描置上）→ 不推送。"""
    _mk_task(db_session, owner=ALICE, due_date=None, reminded_at=NOW)
    assert list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW) == []


def test_list_user_reminders_empty_user(db_session):
    """未指派（owner 空）不提醒。"""
    _mk_task(db_session, owner=None, due_date=_now(12), reminded_at=NOW)
    assert list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW) == []


def test_list_user_reminders_orders_by_due_date(db_session):
    """按 due_date 升序（紧迫在前）。"""
    later = _mk_task(db_session, owner=ALICE, due_date=_now(20), reminded_at=NOW)
    earlier = _mk_task(db_session, owner=ALICE, due_date=_now(2), reminded_at=NOW)
    rows = list_user_reminder_tasks(db_session, user_id=ALICE, now=NOW)
    assert [r.id for r in rows] == [earlier.id, later.id]
