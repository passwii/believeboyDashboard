"""sea_reclaim_service TDD tests — 公海自动回收（N 天未跟进掉公海）。"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmLead
from app.services.crm.sea_reclaim_service import reclaim_stale_to_sea

SH = ZoneInfo("Asia/Shanghai")
ALICE = "11111111-1111-1111-1111-111111111111"

NOW = datetime(2026, 7, 24, 3, 0, 0, tzinfo=SH)
DAYS = 15


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


def _owner(db, table, id_):
    return db.execute(
        text(f"select owner_id from {table} where id=:i"), {"i": id_}
    ).scalar_one()


# ---------- 客户 ----------


def test_customer_stale_by_last_follow_reclaimed(db_session):
    c = _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS + 1))
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_customer_recent_follow_kept(db_session):
    c = _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS - 1))
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_customers", c.id) == ALICE


def test_customer_never_followed_uses_created_at(db_session):
    c = _mk_customer(db_session)
    db_session.execute(
        text("update crm_customers set created_at=:t where id=:i"),
        {"t": NOW - timedelta(days=DAYS + 5), "i": c.id},
    )
    db_session.commit()
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_customers", c.id) is None


def test_customer_signed_not_reclaimed(db_session):
    c = _mk_customer(
        db_session, status="signed", last_follow_at=NOW - timedelta(days=DAYS + 10)
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_customers", c.id) == ALICE


def test_customer_already_in_sea_untouched(db_session):
    c = _mk_customer(
        db_session, owner=None, last_follow_at=NOW - timedelta(days=DAYS + 10)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0
    assert _owner(db_session, "crm_customers", c.id) is None


def test_customer_deleted_not_reclaimed(db_session):
    _mk_customer(
        db_session, is_deleted=True, last_follow_at=NOW - timedelta(days=DAYS + 10)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0


# ---------- 线索 ----------


def test_lead_stale_by_next_follow_reclaimed(db_session):
    lead = _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS + 1))
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 1
    assert _owner(db_session, "crm_leads", lead.id) is None


def test_lead_recent_next_follow_kept(db_session):
    lead = _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS - 1))
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_lead_converted_not_reclaimed(db_session):
    lead = _mk_lead(
        db_session, status="converted", next_follow_at=NOW - timedelta(days=DAYS + 10)
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_lead_discarded_not_reclaimed(db_session):
    lead = _mk_lead(
        db_session, status="discarded", next_follow_at=NOW - timedelta(days=DAYS + 10)
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_lead_never_followed_uses_created_at(db_session):
    lead = _mk_lead(db_session)
    db_session.execute(
        text("update crm_leads set created_at=:t where id=:i"),
        {"t": NOW - timedelta(days=DAYS + 5), "i": lead.id},
    )
    db_session.commit()
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) is None


# ---------- 审计跟进 ----------


def test_reclaim_writes_system_follow_note(db_session):
    c = _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS + 1))
    lead = _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS + 1))
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    rows = db_session.execute(
        text(
            "select entity_type, entity_id, type, created_by, content from crm_follows order by id"
        )
    ).all()
    assert len(rows) == 2
    assert {(r[0], r[1]) for r in rows} == {("customer", c.id), ("lead", lead.id)}
    for r in rows:
        assert r[2] == "note"
        assert r[3] is None
        assert "自动回收" in r[4]


def test_no_reclaim_no_follow_written(db_session):
    _mk_customer(db_session, last_follow_at=NOW - timedelta(days=1))
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert (
        db_session.execute(text("select count(*) from crm_follows")).scalar_one() == 0
    )


def test_result_counts_both(db_session):
    _mk_customer(db_session, last_follow_at=NOW - timedelta(days=DAYS + 1))
    _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS + 1))
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result == {"customers": 1, "leads": 1}


# ---------- P9-3 价值差异化（BLF-541） ----------


def test_rating_a_exempt_never_reclaimed(db_session):
    """A 档（最高价值）永不回收，即使远超阈值。"""
    c = _mk_customer(
        db_session,
        rating="A",
        last_follow_at=NOW - timedelta(days=DAYS + 30),
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS, exempt_ratings={"A"})
    assert result["customers"] == 0
    assert _owner(db_session, "crm_customers", c.id) == ALICE


def test_rating_b_reclaimed_after_7_days(db_session):
    """B 档按 rating_days 覆盖：7 天后回收，7 天内保留。"""
    c_stale = _mk_customer(
        db_session,
        rating="B",
        last_follow_at=NOW - timedelta(days=8),
    )
    c_fresh = _mk_customer(
        db_session,
        rating="B",
        last_follow_at=NOW - timedelta(days=6),
    )
    result = reclaim_stale_to_sea(
        db_session,
        now=NOW,
        days=DAYS,
        exempt_ratings={"A"},
        rating_days={"B": 7, "C": 7},
    )
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c_stale.id) is None
    assert _owner(db_session, "crm_customers", c_fresh.id) == ALICE


def test_rating_c_reclaimed_after_7_days(db_session):
    c_stale = _mk_customer(
        db_session,
        rating="C",
        last_follow_at=NOW - timedelta(days=DAYS + 1),
    )
    result = reclaim_stale_to_sea(
        db_session,
        now=NOW,
        days=DAYS,
        exempt_ratings={"A"},
        rating_days={"B": 7, "C": 7},
    )
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c_stale.id) is None


def test_rating_d_falls_back_to_global_days(db_session):
    """D 档未配置 → 回落全局 days（P3a 现状）。"""
    c = _mk_customer(
        db_session,
        rating="D",
        last_follow_at=NOW - timedelta(days=DAYS + 1),
    )
    result = reclaim_stale_to_sea(
        db_session,
        now=NOW,
        days=DAYS,
        exempt_ratings={"A"},
        rating_days={"B": 7, "C": 7},
    )
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_rating_a_not_exempt_when_exempt_ratings_omitted(db_session):
    """缺省 exempt_ratings → 与 P3a 一致（无豁免）。"""
    c = _mk_customer(
        db_session,
        rating="A",
        last_follow_at=NOW - timedelta(days=DAYS + 1),
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_reclaim_settings_defaults_created_idempotent(db_session):
    """get_reclaim_settings：首次调用补默认行（A 豁免 / B C 7 天），重复调用幂等。"""
    from app.services.crm.sea_reclaim_service import get_reclaim_settings

    row = get_reclaim_settings(db_session)
    assert row.id == 1
    assert row.exempt_ratings == "A"
    assert row.rating_b_days == 7
    assert row.rating_c_days == 7
    assert row.rating_d_days is None

    rows = db_session.execute(
        text("select count(*) from crm_reclaim_settings")
    ).scalar_one()
    assert rows == 1

    again = get_reclaim_settings(db_session)
    assert again.id == row.id
    assert (
        db_session.execute(
            text("select count(*) from crm_reclaim_settings")
        ).scalar_one()
        == 1
    )
