"""dashboard_service TDD tests — CRM 数据看板统计聚合（P3c，仅管理员）。

覆盖：线索漏斗 / 本月新增（客户/线索/转化）/ 最近7天跟进活跃度 / 每销售业绩 / 权限墙。
时间口径：Asia/Shanghai 时区算「本月」「最近7天」。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmFollow, CrmLead
from app.services.crm.dashboard_service import get_dashboard_stats

SH = ZoneInfo("Asia/Shanghai")

# 固定「现在」= 2026-07-24 10:00 上海时间
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)
MONTH_START = datetime(2026, 7, 1, 0, 0, 0, tzinfo=SH)

# 负责人用真实 UUID（user_accounts.id 是 uuid 类型，_owner_name_map 的 any(:ids) 要求合法 UUID）
U1 = "11111111-1111-1111-1111-111111111111"
U2 = "22222222-2222-2222-2222-222222222222"


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


def _mk_customer(db, **kw):
    c = CrmCustomer(**kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, **kw):
    lead = CrmLead(**kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _mk_follow(db, **kw):
    f = CrmFollow(type="note", content="x", **kw)
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


# ---------- 权限 ----------


def test_non_admin_forbidden(db_session):
    with pytest.raises(HTTPException) as exc:
        get_dashboard_stats(db_session, is_admin=False, now=NOW)
    assert exc.value.status_code == 403


# ---------- 线索漏斗 ----------


def test_lead_funnel_counts_by_status_excluding_deleted(db_session):
    _mk_lead(db_session, name="L1", status="new")
    _mk_lead(db_session, name="L2", status="new")
    _mk_lead(db_session, name="L3", status="contacting")
    _mk_lead(db_session, name="L4", status="qualified")
    _mk_lead(db_session, name="L5", status="converted")
    _mk_lead(db_session, name="L6", status="discarded")
    _mk_lead(db_session, name="L7", status="new", is_deleted=True)  # 已删除不计
    stats = get_dashboard_stats(db_session, is_admin=True, now=NOW)
    assert stats.lead_funnel == {
        "new": 2,
        "contacting": 1,
        "qualified": 1,
        "converted": 1,
        "discarded": 1,
    }


# ---------- 本月新增 ----------


def test_new_this_month_customers_leads_converted(db_session):
    _mk_customer(db_session, name="C本月", created_at=MONTH_START + timedelta(days=1))
    _mk_customer(db_session, name="C上月", created_at=MONTH_START - timedelta(days=1))
    _mk_lead(
        db_session,
        name="L本月",
        status="new",
        created_at=MONTH_START + timedelta(days=2),
    )
    _mk_lead(
        db_session,
        name="L上月",
        status="new",
        created_at=MONTH_START - timedelta(days=2),
    )
    _mk_lead(
        db_session,
        name="L转化本月",
        status="converted",
        created_at=MONTH_START
        - timedelta(days=10),  # 创建于上月，仅 converted_at 在本月
        converted_at=MONTH_START + timedelta(days=3),
    )
    _mk_lead(
        db_session,
        name="L转化上月",
        status="converted",
        created_at=MONTH_START - timedelta(days=10),
        converted_at=MONTH_START - timedelta(days=3),
    )
    stats = get_dashboard_stats(db_session, is_admin=True, now=NOW)
    assert stats.new_this_month.new_customers == 1
    assert stats.new_this_month.new_leads == 1
    assert stats.new_this_month.converted_count == 1


# ---------- 跟进活跃度 ----------


def test_follow_activity_last_7_days(db_session):
    _mk_follow(
        db_session,
        entity_type="customer",
        entity_id=1,
        created_at=NOW - timedelta(days=1),
    )
    _mk_follow(
        db_session, entity_type="lead", entity_id=1, created_at=NOW - timedelta(days=6)
    )
    _mk_follow(
        db_session,
        entity_type="customer",
        entity_id=2,
        created_at=NOW - timedelta(days=8),
    )
    stats = get_dashboard_stats(db_session, is_admin=True, now=NOW)
    assert stats.follow_activity.follow_count_7d == 2


# ---------- 每销售业绩 ----------


def test_per_owner_customer_count_and_converted(db_session):
    _mk_customer(db_session, name="C1", owner_id=U1)
    _mk_customer(db_session, name="C2", owner_id=U1)
    _mk_customer(db_session, name="C3", owner_id=U2)
    _mk_customer(db_session, name="C公海", owner_id=None)  # 公海不计入任何销售
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=U1,
        converted_at=NOW - timedelta(days=1),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="converted",
        owner_id=U2,
        converted_at=NOW - timedelta(days=40),
    )
    stats = get_dashboard_stats(db_session, is_admin=True, now=NOW)
    by_owner = {p.owner_id: p for p in stats.per_owner}
    assert by_owner[U1].customer_count == 2
    assert by_owner[U1].converted_this_month == 1
    assert by_owner[U2].customer_count == 1
    assert by_owner[U2].converted_this_month == 0
    assert None not in by_owner


# ---------- 空数据 ----------


def test_empty_db_returns_zeros(db_session):
    stats = get_dashboard_stats(db_session, is_admin=True, now=NOW)
    assert stats.lead_funnel == {
        "new": 0,
        "contacting": 0,
        "qualified": 0,
        "converted": 0,
        "discarded": 0,
    }
    assert stats.new_this_month.new_customers == 0
    assert stats.new_this_month.new_leads == 0
    assert stats.new_this_month.converted_count == 0
    assert stats.follow_activity.follow_count_7d == 0
    assert stats.per_owner == []
