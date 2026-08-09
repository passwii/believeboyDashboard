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


# ---------- 按价值分档（P9-3, BLF-541） ----------


def test_customer_rating_a_never_reclaimed(db_session):
    c = _mk_customer(
        db_session, rating="A", last_follow_at=NOW - timedelta(days=DAYS + 1)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 0
    assert _owner(db_session, "crm_customers", c.id) == ALICE


def test_customer_rating_a_extremely_stale_kept(db_session):
    c = _mk_customer(
        db_session, rating="A", last_follow_at=NOW - timedelta(days=DAYS + 365)
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_customers", c.id) == ALICE


def test_customer_rating_b_reclaimed(db_session):
    c = _mk_customer(
        db_session, rating="B", last_follow_at=NOW - timedelta(days=DAYS + 1)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_customer_rating_c_reclaimed(db_session):
    c = _mk_customer(
        db_session, rating="C", last_follow_at=NOW - timedelta(days=DAYS + 1)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_customer_rating_d_reclaimed(db_session):
    c = _mk_customer(
        db_session, rating="D", last_follow_at=NOW - timedelta(days=DAYS + 1)
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["customers"] == 1
    assert _owner(db_session, "crm_customers", c.id) is None


def test_rating_a_kept_no_system_follow_written(db_session):
    _mk_customer(db_session, rating="A", last_follow_at=NOW - timedelta(days=DAYS + 5))
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert (
        db_session.execute(text("select count(*) from crm_follows")).scalar_one() == 0
    )


def test_rating_a_customer_kept_while_lead_reclaimed(db_session):
    _mk_customer(db_session, rating="A", last_follow_at=NOW - timedelta(days=DAYS + 3))
    lead = _mk_lead(db_session, next_follow_at=NOW - timedelta(days=DAYS + 1))
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result == {"customers": 0, "leads": 1}
    assert _owner(db_session, "crm_leads", lead.id) is None


# ---------- P9-4 公海重置机制（BLF-542）：跟进成功 → 重置回收计时 ----------


def test_lead_recent_follow_kept_despite_old_created_at(db_session):
    """跟进成功刷新 last_follow_at → 即使创建很早（next_follow_at 也被清空）也不回收。

    P9-4 核心：修复旧口径（next_follow_at or created_at）下「刚跟进完但没约下次 →
    回退 created_at → 被误回收」的漏洞。
    """
    lead = _mk_lead(db_session, last_follow_at=NOW - timedelta(days=1))
    db_session.execute(
        text("update crm_leads set created_at=:t where id=:i"),
        {"t": NOW - timedelta(days=DAYS + 30), "i": lead.id},
    )
    db_session.commit()
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_lead_stale_last_follow_reclaimed(db_session):
    """last_follow_at 超阈值 → 回收（last_follow_at 成为新计时基准）。"""
    lead = _mk_lead(db_session, last_follow_at=NOW - timedelta(days=DAYS + 1))
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 1
    assert _owner(db_session, "crm_leads", lead.id) is None


def test_lead_last_follow_stale_with_future_next_still_reclaimed(db_session):
    """计时基准 = 最近一次实际跟进（last_follow_at），约定的下次跟进不保护。

    与客户口径一致（客户只看 last_follow_at，不看 next_follow_at）：
    8 天没真跟进，即便约了 3 天后再跟，也已超过 7 天无跟进 → 回收。
    """
    lead = _mk_lead(
        db_session,
        last_follow_at=NOW - timedelta(days=DAYS + 1),
        next_follow_at=NOW + timedelta(days=3),
    )
    result = reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert result["leads"] == 1
    assert _owner(db_session, "crm_leads", lead.id) is None


def test_lead_last_follow_recent_with_future_next_kept(db_session):
    """刚跟进 + 约了下次 → 不回收（last_follow_at 未超阈值）。"""
    lead = _mk_lead(
        db_session,
        last_follow_at=NOW - timedelta(days=1),
        next_follow_at=NOW + timedelta(days=3),
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_lead_never_followed_with_future_next_kept(db_session):
    """存量数据（从未跟过进，last_follow_at=NULL）：回退旧口径 next_follow_at → 保护。"""
    lead = _mk_lead(db_session, next_follow_at=NOW + timedelta(days=5))
    db_session.execute(
        text("update crm_leads set created_at=:t where id=:i"),
        {"t": NOW - timedelta(days=DAYS + 10), "i": lead.id},
    )
    db_session.commit()
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    assert _owner(db_session, "crm_leads", lead.id) == ALICE


def test_reclaim_resets_next_follow_but_keeps_last_follow(db_session):
    """回收动作本身不刷新 last_follow_at（系统跟进不算跟进行为），
    只清空 owner/next_follow_at；审计依赖系统跟进留痕。"""
    lead = _mk_lead(
        db_session,
        last_follow_at=NOW - timedelta(days=DAYS + 1),
        next_follow_at=NOW + timedelta(days=2),
    )
    reclaim_stale_to_sea(db_session, now=NOW, days=DAYS)
    db_session.refresh(lead)
    assert lead.owner_id is None
    assert lead.next_follow_at is None
    assert lead.last_follow_at is not None
    assert (
        abs((lead.last_follow_at - (NOW - timedelta(days=DAYS + 1))).total_seconds())
        < 2
    )


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
