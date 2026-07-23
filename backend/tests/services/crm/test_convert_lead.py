"""convert_lead TDD tests — 线索转客户事务（建客户+主联系人+跟进搬迁+标记转化）。"""
from __future__ import annotations

import pytest
from sqlalchemy import func, select, text

from app.models.crm import CrmContact, CrmCustomer, CrmFollow, CrmLead
from app.schemas.crm import ConvertLeadRequest, FollowCreate, LeadCreate
from app.services.crm.follow_service import create_follow
from app.services.crm.lead_service import (
    LeadAlreadyConverted,
    convert_lead,
    create_lead,
    get_lead,
)

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"


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
        s.commit()
    finally:
        s.close()
    yield


def _mk_lead(db, **kw):
    defaults = dict(
        name="张三",
        company="某工厂",
        phone="13800000000",
        email="z@x.com",
        wechat="zhang_wx",
        source="referral",
        customer_type="工厂",
        interested_service="代运营",
    )
    defaults.update(kw)
    return create_lead(db, LeadCreate(**defaults), user_id=ALICE)


def test_convert_basic_carries_fields(db_session):
    lead = _mk_lead(db_session)
    resp = convert_lead(db_session, lead.id, None, user_id=ALICE)
    assert resp is not None
    cust = resp.customer
    assert cust.name == "某工厂"                 # 取 company
    assert cust.customer_type == "工厂"          # 带过去
    assert cust.interested_service == "代运营"   # 带过去
    assert cust.source == "referral"             # 带过去
    assert cust.rating == "C"                    # 默认 C
    assert cust.status == "active"
    assert cust.owner_id == ALICE                # 保持原负责人


def test_convert_name_fallback_to_lead_name(db_session):
    lead = _mk_lead(db_session, company=None)
    resp = convert_lead(db_session, lead.id, None, user_id=ALICE)
    assert resp.customer.name == "张三"          # 无 company 用 lead.name


def test_convert_with_overrides(db_session):
    lead = _mk_lead(db_session)
    resp = convert_lead(
        db_session, lead.id,
        ConvertLeadRequest(name="自定义客户名", rating="A", source="exhibition"),
        user_id=BOB,
    )
    assert resp.customer.name == "自定义客户名"
    assert resp.customer.rating == "A"
    assert resp.customer.source == "exhibition"
    assert resp.customer.created_by == BOB


def test_convert_creates_primary_contact_with_wechat(db_session):
    lead = _mk_lead(db_session)
    resp = convert_lead(db_session, lead.id, None, user_id=ALICE)
    contacts = db_session.execute(
        select(CrmContact).where(CrmContact.customer_id == resp.customer.id)
    ).scalars().all()
    assert len(contacts) == 1
    c = contacts[0]
    assert c.name == "张三"
    assert c.phone == "13800000000"
    assert c.email == "z@x.com"
    assert c.wechat == "zhang_wx"               # 微信带过去
    assert c.is_primary is True


def test_convert_reparents_follows(db_session):
    lead = _mk_lead(db_session)
    # 转化前在线索上记两条跟进
    create_follow(db_session, FollowCreate(entity_type="lead", entity_id=lead.id, type="phone", content="电话1"), user_id=ALICE)
    create_follow(db_session, FollowCreate(entity_type="lead", entity_id=lead.id, type="wechat", content="微信2"), user_id=ALICE)

    resp = convert_lead(db_session, lead.id, None, user_id=ALICE)
    cid = resp.customer.id

    # 线索下不再有跟进
    lead_follows = db_session.execute(
        select(func.count()).where(CrmFollow.entity_type == "lead", CrmFollow.entity_id == lead.id)
    ).scalar_one()
    assert lead_follows == 0
    # 两条都搬到新客户
    cust_follows = db_session.execute(
        select(CrmFollow).where(CrmFollow.entity_type == "customer", CrmFollow.entity_id == cid)
    ).scalars().all()
    assert len(cust_follows) == 2
    assert {f.content for f in cust_follows} == {"电话1", "微信2"}


def test_convert_marks_lead_converted(db_session):
    lead = _mk_lead(db_session)
    resp = convert_lead(db_session, lead.id, None, user_id=ALICE)
    refreshed = get_lead(db_session, lead.id)
    assert refreshed.status == "converted"
    assert refreshed.converted_to_customer_id == resp.customer.id
    assert refreshed.converted_at is not None
    assert resp.lead.status == "converted"


def test_convert_already_converted_raises_and_no_dup(db_session):
    lead = _mk_lead(db_session)
    convert_lead(db_session, lead.id, None, user_id=ALICE)
    before = db_session.execute(select(func.count()).select_from(CrmCustomer)).scalar_one()
    with pytest.raises(LeadAlreadyConverted):
        convert_lead(db_session, lead.id, None, user_id=ALICE)
    after = db_session.execute(select(func.count()).select_from(CrmCustomer)).scalar_one()
    assert after == before  # 未多建客户


def test_convert_missing_lead_returns_none(db_session):
    assert convert_lead(db_session, 999999, None, user_id=ALICE) is None
