"""follow_up_service TDD tests — 待跟进视图分组（逾期/今日/本周）+ scope 过滤 + 线索排除 + 批量补字段。"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmFollow, CrmLead
from app.services.crm.follow_up_service import list_follow_ups

SH = ZoneInfo("Asia/Shanghai")
ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"

# 固定「现在」= 2026-07-22（周三）10:00 上海时间 → 本周日为 2026-07-26
NOW = datetime(2026, 7, 22, 10, 0, 0, tzinfo=SH)


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


def _mk_customer(db, name="客户A", owner=ALICE, next_follow_at=None, **kw):
    c = CrmCustomer(name=name, owner_id=owner, next_follow_at=next_follow_at, **kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, name="线索A", owner=ALICE, next_follow_at=None, **kw):
    lead = CrmLead(name=name, owner_id=owner, next_follow_at=next_follow_at, **kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def test_grouping_overdue_today_this_week_and_beyond_excluded(db_session):
    _mk_customer(db_session, name="逾期客户", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))  # 周二→逾期
    _mk_customer(db_session, name="今日客户", next_follow_at=datetime(2026, 7, 22, 15, 0, tzinfo=SH))  # 周三→今日
    _mk_lead(db_session, name="本周线索", next_follow_at=datetime(2026, 7, 24, 9, 0, tzinfo=SH))  # 周五→本周
    _mk_customer(db_session, name="下周客户", next_follow_at=datetime(2026, 7, 30, 9, 0, tzinfo=SH))  # 超出本周→不显示

    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)

    assert [i.name for i in groups.overdue] == ["逾期客户"]
    assert [i.name for i in groups.today] == ["今日客户"]
    assert [i.name for i in groups.this_week] == ["本周线索"]
    assert groups.overdue_count == 1
    assert groups.total_count == 3  # 下周客户不计入


def test_no_next_follow_at_excluded(db_session):
    _mk_customer(db_session, name="无预约客户", next_follow_at=None)
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    assert groups.total_count == 0


def test_scope_mine_filters_owner(db_session):
    _mk_customer(db_session, name="我的", owner=ALICE, next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    _mk_customer(db_session, name="别人的", owner=BOB, next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    assert [i.name for i in groups.overdue] == ["我的"]


def test_scope_all_sees_everyone(db_session):
    _mk_customer(db_session, name="我的", owner=ALICE, next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    _mk_customer(db_session, name="别人的", owner=BOB, next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    groups = list_follow_ups(db_session, user_id=ALICE, scope="all", now=NOW)
    assert sorted(i.name for i in groups.overdue) == ["别人的", "我的"]


def test_lead_excludes_converted_and_discarded(db_session):
    _mk_lead(db_session, name="活跃线索", status="contacting", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    _mk_lead(db_session, name="已转化", status="converted", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    _mk_lead(db_session, name="已弃置", status="discarded", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    assert [i.name for i in groups.overdue] == ["活跃线索"]


def test_deleted_excluded(db_session):
    _mk_customer(db_session, name="已删", is_deleted=True, next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    assert groups.total_count == 0


def test_last_follow_content_and_owner_name_populated(db_session):
    cust = _mk_customer(db_session, name="有跟进", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    db_session.add(CrmFollow(entity_type="customer", entity_id=cust.id, content="第一条", created_by=ALICE))
    db_session.commit()
    db_session.add(CrmFollow(entity_type="customer", entity_id=cust.id, content="最新一条", created_by=ALICE))
    db_session.commit()

    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    item = groups.overdue[0]
    assert item.last_follow_content == "最新一条"  # 取最新一条
    assert item.last_follow_at is not None
    assert item.entity_type == "customer"
    assert item.rating is not None  # 客户带等级


def test_subtitle_customer_industry_lead_company(db_session):
    _mk_customer(db_session, name="工厂客户", industry="五金", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    _mk_lead(db_session, name="线索", company="东莞五金厂", next_follow_at=datetime(2026, 7, 21, 9, 0, tzinfo=SH))
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    by_name = {i.name: i for i in groups.overdue}
    assert by_name["工厂客户"].subtitle == "五金"
    assert by_name["线索"].subtitle == "东莞五金厂"
    assert by_name["线索"].entity_type == "lead"


def test_empty(db_session):
    groups = list_follow_ups(db_session, user_id=ALICE, scope="mine", now=NOW)
    assert groups.overdue == [] and groups.today == [] and groups.this_week == []
    assert groups.overdue_count == 0 and groups.total_count == 0
