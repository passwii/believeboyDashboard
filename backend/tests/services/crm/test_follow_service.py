"""follow_service TDD tests — 列表/创建/回写客户 last_follow_at/created_by_name join。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmLead
from app.schemas.crm import FollowCreate
from app.services.crm.follow_service import create_follow, list_follows

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（独立 session + commit）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_follows, crm_contacts, "
                "crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_customer(db, name="客户A", owner=ALICE):
    c = CrmCustomer(name=name, owner_id=owner)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, name="线索A", owner=ALICE):
    lead = CrmLead(name=name, owner_id=owner)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _real_user(db):
    row = db.execute(
        text(
            "select id::text, name from public.user_accounts where is_active = true order by name limit 1"
        )
    ).first()
    return (row[0], row[1]) if row else None


def test_create_follow_basic(db_session):
    cust = _mk_customer(db_session)
    item = create_follow(
        db_session,
        FollowCreate(
            entity_type="customer", entity_id=cust.id, type="phone", content="首次电话"
        ),
        user_id=ALICE,
    )
    assert item.entity_type == "customer"
    assert item.entity_id == cust.id
    assert item.type == "phone"
    assert item.content == "首次电话"
    assert item.created_by == ALICE


def test_create_follow_defaults_and_optional_next(db_session):
    cust = _mk_customer(db_session)
    item = create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="备注"),
        user_id=ALICE,
    )
    assert item.type == "note"  # 默认 note
    assert item.next_follow_at is None  # 下次跟进可空


def test_create_follow_updates_customer_last_follow_at(db_session):
    cust = _mk_customer(db_session)
    assert cust.last_follow_at is None
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="跟进了"),
        user_id=ALICE,
    )
    db_session.refresh(cust)
    assert cust.last_follow_at is not None


def test_create_follow_on_lead_no_error(db_session):
    lead = _mk_lead(db_session)
    item = create_follow(
        db_session,
        FollowCreate(
            entity_type="lead", entity_id=lead.id, type="wechat", content="微信沟通"
        ),
        user_id=BOB,
    )
    assert item.entity_type == "lead"
    assert item.created_by == BOB  # lead 无 last_follow_at，正常创建不报错


def test_list_follows_order_desc_and_isolated(db_session):
    cust = _mk_customer(db_session)
    other = _mk_customer(db_session, name="客户B")
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="第一条"),
        user_id=ALICE,
    )
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="第二条"),
        user_id=ALICE,
    )
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=other.id, content="别的客户"),
        user_id=ALICE,
    )

    items = list_follows(db_session, "customer", cust.id)
    assert len(items) == 2
    assert items[0].content == "第二条"  # desc：后建的在前
    assert items[1].content == "第一条"
    assert all(i.entity_id == cust.id for i in items)  # 不串到别的客户


def test_list_follows_empty(db_session):
    cust = _mk_customer(db_session)
    assert list_follows(db_session, "customer", cust.id) == []


def test_create_follow_created_by_name_join(db_session):
    u = _real_user(db_session)
    if u is None:
        pytest.skip("no seeded active user in test DB")
    uid, uname = u
    cust = _mk_customer(db_session)
    item = create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="x"),
        user_id=uid,
    )
    assert item.created_by == uid
    assert item.created_by_name == uname


# ---------- P2b: 回写实体 next_follow_at（客户 + 线索） ----------


def test_create_follow_sets_customer_next_follow_at(db_session):
    cust = _mk_customer(db_session)
    nxt = datetime.now(timezone.utc) + timedelta(days=3)
    create_follow(
        db_session,
        FollowCreate(
            entity_type="customer",
            entity_id=cust.id,
            content="约下次",
            next_follow_at=nxt,
        ),
        user_id=ALICE,
    )
    db_session.refresh(cust)
    assert cust.next_follow_at is not None
    assert abs((cust.next_follow_at - nxt).total_seconds()) < 2


def test_create_follow_clears_customer_next_follow_at_when_absent(db_session):
    cust = _mk_customer(db_session)
    cust.next_follow_at = datetime.now(timezone.utc) + timedelta(days=1)
    db_session.commit()
    # 再记一条不带 next_follow_at 的跟进 → 清空（没约下次）
    create_follow(
        db_session,
        FollowCreate(
            entity_type="customer", entity_id=cust.id, content="跟进了没约下次"
        ),
        user_id=ALICE,
    )
    db_session.refresh(cust)
    assert cust.next_follow_at is None


def test_create_follow_sets_lead_last_follow_at(db_session):
    """P9-4 (BLF-542): 线索跟进成功 → 刷新 last_follow_at → 回收计时重置（与客户一致）。"""
    lead = _mk_lead(db_session)
    assert lead.last_follow_at is None
    create_follow(
        db_session,
        FollowCreate(entity_type="lead", entity_id=lead.id, content="跟进了"),
        user_id=BOB,
    )
    db_session.refresh(lead)
    assert lead.last_follow_at is not None


def test_create_follow_sets_lead_next_follow_at(db_session):
    lead = _mk_lead(db_session)
    nxt = datetime.now(timezone.utc) + timedelta(days=2)
    create_follow(
        db_session,
        FollowCreate(
            entity_type="lead", entity_id=lead.id, content="约下次", next_follow_at=nxt
        ),
        user_id=BOB,
    )
    db_session.refresh(lead)
    assert lead.next_follow_at is not None
    assert abs((lead.next_follow_at - nxt).total_seconds()) < 2


def test_create_follow_clears_lead_next_follow_at_when_absent(db_session):
    lead = _mk_lead(db_session)
    lead.next_follow_at = datetime.now(timezone.utc) + timedelta(days=1)
    db_session.commit()
    create_follow(
        db_session,
        FollowCreate(entity_type="lead", entity_id=lead.id, content="没约下次"),
        user_id=BOB,
    )
    db_session.refresh(lead)
    assert lead.next_follow_at is None


def test_create_follow_commit_false_uncommitted_until_commit(db_session):
    """P7-6 (BLF-515): commit=False 仅 flush（端点统一 commit）；回滚则 follow + 回写全消失。"""
    cust = _mk_customer(db_session)
    create_follow(
        db_session,
        FollowCreate(entity_type="customer", entity_id=cust.id, content="联动场景"),
        user_id=ALICE,
        commit=False,
    )
    # 会话内已 flush：follow 可见、客户已回写
    assert (
        db_session.execute(text("select count(*) from crm_follows")).scalar_one() == 1
    )
    db_session.refresh(cust)
    assert cust.last_follow_at is not None
    # 回滚 → 全部消失（task + follow + 回写 + 审计同事务的前提）
    db_session.rollback()
    db_session.expire_all()
    assert (
        db_session.execute(text("select count(*) from crm_follows")).scalar_one() == 0
    )
    db_session.refresh(cust)
    assert cust.last_follow_at is None
