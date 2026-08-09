"""stale_email_service TDD tests — P9-2 无跟进提醒邮件（BLF-540）。

覆盖：设置读写、扫描判定（客户/线索）、去重（stale_email_sent_at）、
按负责人聚合、无邮箱跳过、开关关闭、发送失败不置位。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmLead, CrmWorkflowSetting
from app.services.crm.stale_email_service import (
    get_workflow_settings,
    send_stale_reminder_emails,
    update_workflow_settings,
)

SH = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 24, 9, 0, 0, tzinfo=SH)
DAYS = 7


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_follows, crm_opportunities, crm_contacts, "
                "crm_leads, crm_customers restart identity cascade"
            )
        )
        s.execute(
            text(
                "update crm_workflow_settings set stale_days=7, stale_email_enabled=true"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _owner_id(db) -> str:
    """取一个有邮箱的测试账号（user_accounts 种子数据）作负责人。"""
    return db.execute(
        text(
            "select id::text from public.user_accounts where email is not null limit 1"
        )
    ).scalar_one()


def _mk_customer(db, name="客户A", owner=None, **kw):
    kw.setdefault("created_at", NOW - timedelta(days=30))
    c = CrmCustomer(name=name, owner_id=owner, **kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, name="线索A", owner=None, **kw):
    kw.setdefault("created_at", NOW - timedelta(days=30))
    lead = CrmLead(name=name, owner_id=owner, **kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _sent_at(db, table, id_):
    return db.execute(
        text(f"select stale_email_sent_at from {table} where id=:i"), {"i": id_}
    ).scalar_one_or_none()


def _collect(send_calls):
    return [(c[0], c[1], c[2]) for c in send_calls]


# ---------- 设置读写 ----------


def test_get_workflow_settings_defaults(db_session):
    s = get_workflow_settings(db_session)
    assert s.stale_days == 7
    assert s.stale_email_enabled is True


def test_update_workflow_settings_partial(db_session):
    update_workflow_settings(db_session, stale_days=14)
    s = get_workflow_settings(db_session)
    assert s.stale_days == 14
    assert s.stale_email_enabled is True
    update_workflow_settings(db_session, stale_email_enabled=False)
    s = get_workflow_settings(db_session)
    assert s.stale_days == 14
    assert s.stale_email_enabled is False


# ---------- 客户 ----------


def test_customer_stale_by_last_follow_emailed(db_session):
    owner = _owner_id(db_session)
    _mk_customer(db_session, owner=owner, last_follow_at=NOW - timedelta(days=DAYS + 1))
    calls: list = []

    def fake_send(to, subject, html):
        calls.append((to, subject, html))
        return True

    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=fake_send
    )
    assert result["customers"] == 1
    assert result["emails_sent"] == 1
    assert result["owners_emailed"] == 1


def test_customer_recent_follow_not_emailed(db_session):
    owner = _owner_id(db_session)
    c = _mk_customer(db_session, owner=owner, last_follow_at=NOW - timedelta(days=1))
    calls: list = []
    result = send_stale_reminder_emails(
        db_session,
        now=NOW,
        days=DAYS,
        send_fn=lambda to, subj, html: calls.append(1) or True,
    )
    assert result["customers"] == 0
    assert calls == []
    assert _sent_at(db_session, "crm_customers", c.id) is None


def test_customer_never_followed_uses_created_at(db_session):
    owner = _owner_id(db_session)
    c = _mk_customer(db_session, owner=owner)
    db_session.execute(
        text("update crm_customers set created_at=:t where id=:i"),
        {"t": NOW - timedelta(days=DAYS + 5), "i": c.id},
    )
    db_session.commit()
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["customers"] == 1


def test_customer_signed_not_emailed(db_session):
    owner = _owner_id(db_session)
    _mk_customer(
        db_session,
        owner=owner,
        status="signed",
        last_follow_at=NOW - timedelta(days=DAYS + 10),
    )
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["customers"] == 0


def test_customer_in_sea_not_emailed(db_session):
    _mk_customer(db_session, owner=None, last_follow_at=NOW - timedelta(days=DAYS + 10))
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["customers"] == 0


# ---------- 线索 ----------


def test_lead_stale_by_next_follow_emailed(db_session):
    owner = _owner_id(db_session)
    _mk_lead(db_session, owner=owner, next_follow_at=NOW - timedelta(days=DAYS + 1))
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["leads"] == 1
    assert result["emails_sent"] == 1


def test_lead_recent_next_follow_not_emailed(db_session):
    owner = _owner_id(db_session)
    _mk_lead(db_session, owner=owner, next_follow_at=NOW - timedelta(days=DAYS - 1))
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["leads"] == 0


def test_lead_converted_discarded_not_emailed(db_session):
    owner = _owner_id(db_session)
    _mk_lead(
        db_session,
        owner=owner,
        status="converted",
        next_follow_at=NOW - timedelta(days=DAYS + 10),
    )
    _mk_lead(
        db_session,
        owner=owner,
        status="discarded",
        next_follow_at=NOW - timedelta(days=DAYS + 10),
    )
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["leads"] == 0


# ---------- 去重 ----------


def test_already_emailed_episode_skipped(db_session):
    owner = _owner_id(db_session)
    c = _mk_customer(
        db_session, owner=owner, last_follow_at=NOW - timedelta(days=DAYS + 1)
    )
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["emails_sent"] == 1
    assert _sent_at(db_session, "crm_customers", c.id) is not None

    # 同一无跟进期再扫 → 不发（去重）
    result2 = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result2["emails_sent"] == 0
    assert result2["customers"] == 0


def test_refollow_after_reminder_reattempts(db_session):
    owner = _owner_id(db_session)
    _mk_customer(db_session, owner=owner, last_follow_at=NOW - timedelta(days=DAYS + 1))
    send_stale_reminder_emails(db_session, now=NOW, days=DAYS, send_fn=lambda *a: True)

    # 负责人跟进（last_follow_at 前移到提醒之后）→ 再超期 → 新一轮提醒
    _mk_customer(db_session, owner=owner, last_follow_at=NOW + timedelta(days=1))
    result = send_stale_reminder_emails(
        db_session,
        now=NOW + timedelta(days=DAYS + 2),
        days=DAYS,
        send_fn=lambda *a: True,
    )
    assert result["customers"] == 1
    assert result["emails_sent"] == 1


# ---------- 聚合 / 无邮箱 ----------


def test_same_owner_batched_one_email(db_session):
    owner = _owner_id(db_session)
    _mk_customer(
        db_session, name="C1", owner=owner, last_follow_at=NOW - timedelta(days=8)
    )
    _mk_lead(db_session, name="L1", owner=owner, next_follow_at=NOW - timedelta(days=8))
    calls: list = []

    def fake_send(to, subject, html):
        calls.append((to, subject, html))
        return True

    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=fake_send
    )
    assert result["customers"] == 1
    assert result["leads"] == 1
    assert len(calls) == 1  # 一个负责人 → 一封邮件
    assert "C1" in calls[0][2] and "L1" in calls[0][2]
    assert f"超过 {DAYS} 天未跟进" in calls[0][1]


def test_owner_without_email_skipped_no_marker(db_session):
    # owner_id 指向不存在的 user_accounts（无邮箱）→ 不发送、不置位
    c = _mk_customer(
        db_session,
        owner="99999999-9999-9999-9999-999999999999",
        last_follow_at=NOW - timedelta(days=DAYS + 1),
    )
    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=lambda *a: True
    )
    assert result["emails_sent"] == 0
    assert result["owners_without_email"] == 1
    assert _sent_at(db_session, "crm_customers", c.id) is None


# ---------- 开关 / 失败 ----------


def test_disabled_by_settings_no_email(db_session):
    update_workflow_settings(db_session, stale_email_enabled=False)
    owner = _owner_id(db_session)
    _mk_customer(db_session, owner=owner, last_follow_at=NOW - timedelta(days=DAYS + 1))
    result = send_stale_reminder_emails(db_session, now=NOW, days=DAYS)
    assert result["disabled"] is True
    assert result["emails_sent"] == 0


def test_send_failure_no_marker(db_session):
    owner = _owner_id(db_session)
    c = _mk_customer(
        db_session, owner=owner, last_follow_at=NOW - timedelta(days=DAYS + 1)
    )

    def fail_send(to, subject, html):
        raise RuntimeError("resend down")

    result = send_stale_reminder_emails(
        db_session, now=NOW, days=DAYS, send_fn=fail_send
    )
    assert result["emails_sent"] == 0
    assert _sent_at(db_session, "crm_customers", c.id) is None  # 可下轮重试


def test_days_from_settings_used(db_session):
    update_workflow_settings(db_session, stale_days=3)
    owner = _owner_id(db_session)
    # 4 天未跟进：settings days=3 → 命中；默认 7 → 不命中
    _mk_customer(db_session, owner=owner, last_follow_at=NOW - timedelta(days=4))
    result = send_stale_reminder_emails(db_session, now=NOW, send_fn=lambda *a: True)
    assert result["customers"] == 1
