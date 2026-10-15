"""follow_up_reminder_service TDD tests — 7 天无跟进提醒（P9-1, BLF-539）。

扫描口径复用 P3a sea_reclaim：客户 COALESCE(last_follow_at, created_at)，
线索 COALESCE(next_follow_at, created_at)；排除 signed / converted / discarded /
已删 / 无主。差异：不回收，写 active 提醒记录（幂等单次），跟进成功后 resolve。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.crm import (
    CrmCustomer,
    CrmLead,
    CrmReminderLog,
    CrmReminderStatus,
    CrmReminderType,
)
from app.schemas.crm import FollowCreate
from app.services.crm.follow_up_reminder_service import (
    list_user_stale_reminders,
    resolve_entity_reminders,
    scan_stale_entities,
)
from app.services.crm.follow_service import create_follow

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"

NOW = datetime(2026, 8, 9, 9, 0, 0, tzinfo=timezone.utc)
DAYS = 7


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（独立 session + commit）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_reminder_logs, crm_audit_logs, crm_tasks, crm_follows, "
                "crm_contacts, crm_leads, crm_customers "
                "restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_customer(db, name="客户A", owner=ALICE, **kw):
    c = CrmCustomer(name=name, owner_id=owner, **kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, name="线索A", owner=ALICE, **kw):
    lead = CrmLead(name=name, owner_id=owner, **kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _old(days=DAYS + 1, delta_hours=0) -> datetime:
    return NOW - timedelta(days=days, hours=delta_hours)


def _set_created_at(db, table, id_, ts):
    db.execute(
        text(f"update {table} set created_at=:t where id=:i"),
        {"t": ts, "i": id_},
    )
    db.commit()


def _active_logs(db):
    return db.execute(
        text(
            "select entity_type, entity_id, owner_id, status, reminder_type "
            "from crm_reminder_logs where status='active' order by id"
        )
    ).all()


# ─── scan_stale_entities：客户 ───────────────────────────────────────────────


def test_scan_creates_log_for_stale_customer(db_session):
    c = _mk_customer(db_session, last_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result == {"customers": 1, "leads": 0}
    rows = _active_logs(db_session)
    assert len(rows) == 1
    assert rows[0][0] == "customer"
    assert rows[0][1] == c.id
    assert rows[0][2] == ALICE  # owner 快照
    assert rows[0][3] == CrmReminderStatus.ACTIVE
    assert rows[0][4] == CrmReminderType.STALE_FOLLOW_UP


def test_scan_customer_recent_follow_no_reminder(db_session):
    _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS - 1))
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0
    assert _active_logs(db_session) == []


def test_scan_customer_never_followed_uses_created_at(db_session):
    c = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", c.id, _old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1


def test_scan_customer_exactly_at_threshold_not_reminded(db_session):
    """边界：COALESCE(ref) == cutoff（刚好 7 天）→ 不提醒（"超过"为严格大于）。"""
    _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS))
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0


def test_scan_customer_just_over_threshold_reminds(db_session):
    """边界：ref 比 cutoff 早 1 秒 → 提醒。"""
    c = _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS, seconds=1))
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _active_logs(db_session)[0][1] == c.id


def test_scan_customer_signed_skipped(db_session):
    _mk_customer(db_session, status="signed", last_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0


def test_scan_customer_no_owner_skipped(db_session):
    _mk_customer(db_session, owner=None, last_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0


def test_scan_customer_deleted_skipped(db_session):
    _mk_customer(db_session, is_deleted=True, last_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0


# ─── scan_stale_entities：线索 ───────────────────────────────────────────────


def test_scan_creates_log_for_stale_lead(db_session):
    lead = _mk_lead(db_session, next_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result == {"customers": 0, "leads": 1}
    rows = _active_logs(db_session)
    assert rows[0][0] == "lead"
    assert rows[0][1] == lead.id
    assert rows[0][2] == ALICE


def test_scan_lead_recent_next_follow_kept(db_session):
    _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS - 1))
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 0


def test_scan_lead_never_followed_uses_created_at(db_session):
    lead = _mk_lead(db_session)
    _set_created_at(db_session, "crm_leads", lead.id, _old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 1


def test_scan_lead_converted_or_discarded_skipped(db_session):
    _mk_lead(db_session, status="converted", next_follow_at=_old())
    _mk_lead(db_session, status="discarded", next_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 0


def test_scan_lead_no_owner_skipped(db_session):
    _mk_lead(db_session, owner=None, next_follow_at=_old())
    result = scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 0


# ─── scan_stale_entities：幂等 + 自愈 ────────────────────────────────────────


def test_scan_idempotent_no_duplicate_logs(db_session):
    _mk_customer(db_session, last_follow_at=_old())
    _mk_lead(db_session, next_follow_at=_old())
    first = scan_stale_entities(db_session, now=NOW, days=DAYS)
    second = scan_stale_entities(db_session, now=NOW + timedelta(hours=1), days=DAYS)
    assert first == {"customers": 1, "leads": 1}
    assert second == {"customers": 0, "leads": 0}
    assert len(_active_logs(db_session)) == 2


def test_scan_self_heals_resolves_followed_up_entity(db_session):
    """实体被跟进后再次 scan → 旧 active 记录 resolve（不再推送）。"""
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    c.last_follow_at = NOW
    db_session.commit()
    scan_stale_entities(db_session, now=NOW + timedelta(hours=2), days=DAYS)
    assert _active_logs(db_session) == []


def test_scan_self_heals_resolves_reclaimed_entity(db_session):
    """实体掉公海（owner 置空）后再次 scan → 旧 active 记录 resolve。"""
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    c.owner_id = None
    db_session.commit()
    scan_stale_entities(db_session, now=NOW + timedelta(hours=2), days=DAYS)
    assert _active_logs(db_session) == []


def test_scan_reactivates_after_followup_and_restale(db_session, monkeypatch):
    """闭环：跟进 resolve → 再过 7 天无跟进 → 重新提醒。"""
    from app.services.crm import follow_service

    class FrozenDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    monkeypatch.setattr(follow_service, "datetime", FrozenDatetime)
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    # 跟进 → resolve 旧记录
    create_follow(
        db_session,
        FollowCreate(
            entity_type="customer",
            entity_id=c.id,
            type="phone",
            content="回访",
            next_follow_at=None,
        ),
        user_id=ALICE,
    )
    assert _active_logs(db_session) == []
    # 又过 7 天无跟进 → 重新提醒（新一轮记录）
    later = NOW + timedelta(days=DAYS + 1)
    result = scan_stale_entities(db_session, now=later, days=DAYS)
    assert result["customers"] == 1
    assert len(_active_logs(db_session)) == 1


# ─── resolve_entity_reminders ────────────────────────────────────────────────


def test_resolve_marks_active_logs_resolved_and_returns_count(db_session):
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    resolved = resolve_entity_reminders(db_session, "customer", c.id)
    assert resolved == 1
    db_session.flush()  # autoflush=False：查询前先 flush
    rows = (
        db_session.execute(
            text(
                "select status from crm_reminder_logs "
                "where entity_type='customer' and entity_id=:i"
            ),
            {"i": c.id},
        )
        .scalars()
        .all()
    )
    assert list(rows) == [CrmReminderStatus.RESOLVED]
    assert _active_logs(db_session) == []


def test_resolve_noop_when_none(db_session):
    _mk_customer(db_session, last_follow_at=_old())
    assert resolve_entity_reminders(db_session, "customer", 999) == 0


def test_resolve_only_targets_stale_follow_up_type(db_session):
    """只 resolve stale_follow_up 类型记录，不影响其它提醒类型。"""
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    db_session.add(
        CrmReminderLog(
            entity_type="customer",
            entity_id=c.id,
            reminder_type="custom",
            owner_id=ALICE,
            status=CrmReminderStatus.ACTIVE,
            reminded_at=NOW,
        )
    )
    db_session.commit()
    resolve_entity_reminders(db_session, "customer", c.id)
    db_session.flush()  # autoflush=False：查询前先 flush
    rows = db_session.execute(
        text("select reminder_type, status from crm_reminder_logs order by id")
    ).all()
    assert rows == [
        (CrmReminderType.STALE_FOLLOW_UP, CrmReminderStatus.RESOLVED),
        ("custom", CrmReminderStatus.ACTIVE),
    ]


# ─── create_follow 联动（follow_service 钩子） ───────────────────────────────


def test_create_follow_resolves_customer_reminder(db_session):
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    create_follow(
        db_session,
        FollowCreate(
            entity_type="customer", entity_id=c.id, type="note", content="跟进"
        ),
        user_id=ALICE,
    )
    assert _active_logs(db_session) == []


def test_create_follow_resolves_lead_reminder(db_session):
    lead = _mk_lead(db_session, next_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    create_follow(
        db_session,
        FollowCreate(
            entity_type="lead", entity_id=lead.id, type="note", content="跟进"
        ),
        user_id=ALICE,
    )
    assert _active_logs(db_session) == []


# ─── list_user_stale_reminders：SSE 推送源 ───────────────────────────────────


def test_list_owner_filter_only_current_user(db_session):
    mine = _mk_customer(db_session, owner=ALICE, last_follow_at=_old())
    _mk_customer(db_session, owner=BOB, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    rows = list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS)
    assert [(r["entity_type"], r["entity_id"]) for r in rows] == [("customer", mine.id)]


def test_list_returns_name_and_days(db_session):
    c = _mk_customer(db_session, name="旺旺集团", last_follow_at=_old(days=DAYS + 3))
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    rows = list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS)
    assert rows == [
        {"entity_type": "customer", "entity_id": c.id, "name": "旺旺集团", "days": 10}
    ]


def test_list_excludes_followed_up(db_session):
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=c.id, type="note", content="跟"),
        user_id=ALICE,
    )
    assert (
        list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS) == []
    )


def test_list_excludes_entity_no_longer_stale_without_resolve(db_session):
    """自愈兜底：即使 resolve 未执行，实体已跟进 → 不再推送。"""
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    c.last_follow_at = NOW - timedelta(days=1)
    db_session.commit()
    assert (
        list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS) == []
    )


def test_list_includes_customer_and_lead(db_session):
    _mk_customer(db_session, last_follow_at=_old())
    _mk_lead(db_session, next_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    rows = list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS)
    assert {(r["entity_type"]) for r in rows} == {"customer", "lead"}


def test_list_orders_by_days_desc(db_session):
    c_old = _mk_customer(db_session, name="更久", last_follow_at=_old(days=DAYS + 20))
    c_new = _mk_customer(db_session, name="刚过", last_follow_at=_old(days=DAYS + 1))
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    rows = list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS)
    assert [r["entity_id"] for r in rows] == [c_old.id, c_new.id]


def test_list_empty_user_id(db_session):
    _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    assert list_user_stale_reminders(db_session, user_id=None, now=NOW, days=DAYS) == []


def test_list_only_active_logs(db_session):
    c = _mk_customer(db_session, last_follow_at=_old())
    scan_stale_entities(db_session, now=NOW, days=DAYS)
    resolve_entity_reminders(db_session, "customer", c.id)
    db_session.flush()  # autoflush=False：查询前先 flush
    assert (
        list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=DAYS) == []
    )
