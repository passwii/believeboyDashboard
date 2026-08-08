"""dashboard_service P8 生命周期看板 tests — BLF-520。

覆盖 get_lifecycle_board：
- first_follow：客户创建 → 第一条跟进（无跟进不算样本；re-parent 负时长钳制 0）
- conversion：线索创建 → converted_at（未转化不算样本）
- churn：审计 move_sea ∪ 系统回收跟进（内容含「回收至公海」），多次取首次
- 分桶边界：1/3/7/14/30 天 → 6 桶；累计占比单调不减
- summary：均值 / 中位 / P90 / 最大值；空库全 0
- 权限：非管理员 → 403
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.models.crm import (
    CrmAuditLog,
    CrmCustomer,
    CrmFollow,
    CrmLead,
)
from app.services.crm.dashboard_service import get_lifecycle_board

SH = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)
DAY = timedelta(days=1)


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_follows, crm_opportunities, crm_contacts, "
                "crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def _mk_customer(db, **kw):
    kw.setdefault("created_at", NOW)
    c = CrmCustomer(**kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, **kw):
    kw.setdefault("created_at", NOW)
    lead = CrmLead(**kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _mk_follow(db, **kw):
    kw.setdefault("created_at", NOW)
    kw.setdefault("entity_type", "customer")
    kw.setdefault("type", "note")
    kw.setdefault("content", "跟进")
    f = CrmFollow(**kw)
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


def _mk_audit(db, **kw):
    kw.setdefault("created_at", NOW)
    kw.setdefault("entity_type", "customer")
    kw.setdefault("action", "move_sea")
    a = CrmAuditLog(**kw)
    db.add(a)
    db.commit()
    db.refresh(a)
    return a


def _bucket_map(dist):
    return {b.label: b.count for b in dist.buckets}


def test_first_follow_distribution_and_summary(db_session):
    """客户创建 → 首次跟进：只取最早一条跟进，无跟进不算样本。"""
    c1 = _mk_customer(db_session, name="C1", created_at=NOW)
    c2 = _mk_customer(db_session, name="C2", created_at=NOW)
    _mk_customer(db_session, name="C3", created_at=NOW)  # 无跟进

    # c1：第 0.5 天 → 「1 天内」；c2：第 5 天 → 「3-7 天」
    _mk_follow(db_session, entity_id=c1.id, created_at=NOW + timedelta(hours=12))
    _mk_follow(
        db_session, entity_id=c1.id, created_at=NOW + timedelta(days=3)
    )  # 非最早
    _mk_follow(db_session, entity_id=c2.id, created_at=NOW + timedelta(days=5))

    board = get_lifecycle_board(db_session, is_admin=True)
    ff = board.first_follow
    assert ff.summary.sample_count == 2
    assert ff.summary.total_count == 3
    assert _bucket_map(ff)["1 天内"] == 1
    assert _bucket_map(ff)["3-7 天"] == 1
    assert ff.summary.max_days == 5.0
    # 累计占比：第一桶 0.5，第二桶仍 0.5（1-3 天无人），第三桶 1.0
    assert ff.buckets[0].cumulative_pct == 0.5
    assert ff.buckets[1].cumulative_pct == 0.5
    assert ff.buckets[2].cumulative_pct == 1.0


def test_first_follow_negative_reparent_clamped_to_zero(db_session):
    """线索转化 re-parent 的跟进早于客户创建 → 时长钳制 0（「1 天内」）。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    _mk_follow(
        db_session,
        entity_id=c.id,
        created_at=NOW - timedelta(days=10),
        content="转化前跟进",
    )
    board = get_lifecycle_board(db_session, is_admin=True)
    assert board.first_follow.summary.sample_count == 1
    assert _bucket_map(board.first_follow)["1 天内"] == 1


def test_conversion_uses_converted_at_only_converted_leads(db_session):
    """转化：线索创建 → converted_at；未转化线索不算样本但计入 total。"""
    _mk_lead(
        db_session, name="L1", created_at=NOW, converted_at=NOW + timedelta(days=2)
    )
    _mk_lead(
        db_session, name="L2", created_at=NOW, converted_at=NOW + timedelta(days=20)
    )
    _mk_lead(db_session, name="L3", created_at=NOW)  # 未转化

    board = get_lifecycle_board(db_session, is_admin=True)
    conv = board.conversion
    assert conv.summary.sample_count == 2
    assert conv.summary.total_count == 3
    assert _bucket_map(conv)["1-3 天"] == 1
    assert _bucket_map(conv)["14-30 天"] == 1


def test_churn_manual_move_sea_from_audit(db_session):
    """流失：审计 action=move_sea 算一次回公海事件。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    _mk_audit(db_session, entity_id=c.id, created_at=NOW + timedelta(days=4))

    board = get_lifecycle_board(db_session, is_admin=True)
    churn = board.churn
    assert churn.summary.sample_count == 1
    assert _bucket_map(churn)["3-7 天"] == 1


def test_churn_auto_reclaim_follow(db_session):
    """流失：系统回收跟进（created_by 空 + 内容含「回收至公海」）也算。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    _mk_follow(
        db_session,
        entity_id=c.id,
        created_at=NOW + timedelta(days=8),
        content="超过 7 天未跟进，系统自动回收至公海",
        created_by=None,
    )
    board = get_lifecycle_board(db_session, is_admin=True)
    assert board.churn.summary.sample_count == 1
    assert _bucket_map(board.churn)["7-14 天"] == 1


def test_churn_uses_earliest_event(db_session):
    """流失：多次回公海取首次（最早事件）。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    # 先系统回收（第 2 天），后手动释放（第 9 天）→ 取第 2 天
    _mk_follow(
        db_session,
        entity_id=c.id,
        created_at=NOW + timedelta(days=9),
        content="超过 7 天未跟进，系统自动回收至公海",
        created_by=None,
    )
    _mk_audit(db_session, entity_id=c.id, created_at=NOW + timedelta(days=2))
    board = get_lifecycle_board(db_session, is_admin=True)
    churn = board.churn
    assert churn.summary.sample_count == 1
    assert churn.summary.max_days == 2.0
    assert _bucket_map(churn)["1-3 天"] == 1


def test_churn_ignores_normal_follows_and_other_actions(db_session):
    """流失：普通跟进与 claim/其他审计动作不算回公海。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    _mk_follow(
        db_session, entity_id=c.id, created_at=NOW + timedelta(days=1)
    )  # 普通跟进
    _mk_audit(
        db_session, entity_id=c.id, action="claim", created_at=NOW + timedelta(days=2)
    )
    board = get_lifecycle_board(db_session, is_admin=True)
    assert board.churn.summary.sample_count == 0


def test_now_in_sea_counts_ownerless_customers(db_session):
    _mk_customer(db_session, name="C1", owner_id=None)
    _mk_customer(db_session, name="C2", owner_id=None)
    _mk_customer(db_session, name="C3", owner_id="some-owner")
    board = get_lifecycle_board(db_session, is_admin=True)
    assert board.now_in_sea == 2


def test_deleted_customers_excluded(db_session):
    c = _mk_customer(db_session, name="C1", created_at=NOW, is_deleted=True)
    _mk_follow(db_session, entity_id=c.id, created_at=NOW + timedelta(days=1))
    board = get_lifecycle_board(db_session, is_admin=True)
    assert board.first_follow.summary.sample_count == 0
    assert board.first_follow.summary.total_count == 0
    assert board.churn.summary.total_count == 0


def test_empty_db_returns_empty_distributions(db_session):
    board = get_lifecycle_board(db_session, is_admin=True)
    for dist in (board.first_follow, board.conversion, board.churn):
        assert dist.summary.sample_count == 0
        assert dist.summary.total_count == 0
        assert dist.summary.avg_days is None
        assert all(b.count == 0 for b in dist.buckets)
    assert board.now_in_sea == 0


def test_bucket_boundaries(db_session):
    """分桶边界：0.5→1 天内；1.0→1-3 天；3.0→3-7 天；7.0→7-14 天；30.0→30 天以上。"""
    c = _mk_customer(db_session, name="C1", created_at=NOW)
    c2 = _mk_customer(db_session, name="C2", created_at=NOW)
    c3 = _mk_customer(db_session, name="C3", created_at=NOW)
    c4 = _mk_customer(db_session, name="C4", created_at=NOW)
    c5 = _mk_customer(db_session, name="C5", created_at=NOW)
    _mk_follow(db_session, entity_id=c.id, created_at=NOW + timedelta(hours=12))
    _mk_follow(db_session, entity_id=c2.id, created_at=NOW + timedelta(days=1))
    _mk_follow(db_session, entity_id=c3.id, created_at=NOW + timedelta(days=3))
    _mk_follow(db_session, entity_id=c4.id, created_at=NOW + timedelta(days=7))
    _mk_follow(db_session, entity_id=c5.id, created_at=NOW + timedelta(days=30))

    board = get_lifecycle_board(db_session, is_admin=True)
    assert _bucket_map(board.first_follow) == {
        "1 天内": 1,
        "1-3 天": 1,
        "3-7 天": 1,
        "7-14 天": 1,
        "14-30 天": 0,
        "30 天以上": 1,
    }
    # 六桶齐全，max_days 只有无上限桶为 None
    assert len(board.first_follow.buckets) == 6
    assert board.first_follow.buckets[-1].max_days is None
    assert board.first_follow.buckets[-2].max_days == 30.0


def test_summary_median_p90(db_session):
    """summary：均值/中位/P90。10 个客户，跟进分别在第 1..10 天。"""
    for i in range(1, 11):
        c = _mk_customer(db_session, name=f"C{i}", created_at=NOW)
        _mk_follow(db_session, entity_id=c.id, created_at=NOW + timedelta(days=i))
    board = get_lifecycle_board(db_session, is_admin=True)
    s = board.first_follow.summary
    assert s.sample_count == 10
    # 1..10 天：均值 5.5，中位 5.5，P90 = ordered[min(9, int(10*0.9))] = ordered[9] = 10
    assert s.avg_days == 5.5
    assert s.median_days == 5.5
    assert s.p90_days == 10.0
    assert s.max_days == 10.0


def test_require_admin_403(db_session):
    with pytest.raises(HTTPException) as exc:
        get_lifecycle_board(db_session, is_admin=False)
    assert exc.value.status_code == 403
