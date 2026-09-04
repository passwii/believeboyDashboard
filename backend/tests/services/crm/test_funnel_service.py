"""dashboard_service P8 漏斗指标 tests — BLF-517。

覆盖：
- entered_stage_at 写路径（create_lead / update_lead 状态变化 / convert_lead）
- get_funnel_metrics：owner / source / time 三维度 + 时间/owner/source 过滤 + 权限墙
- get_stage_detail：停留时长(dwell) / 卡点阈值 / 最后动作推导 / 排序 / 流入流出 / 权限墙
时间口径：Asia/Shanghai（与现有 dashboard 约定一致）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text

from app.models.crm import CrmFollow, CrmLead
from app.schemas.crm import ConvertLeadRequest, LeadCreate, LeadUpdate
from app.services.crm import dashboard_service, lead_service

SH = ZoneInfo("Asia/Shanghai")

# 固定「现在」= 2026-07-24 10:00 上海时间
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)

# 负责人用真实 UUID（user_accounts.id 是 uuid 类型）
U1 = "11111111-1111-1111-1111-111111111111"
U2 = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
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


def _mk_lead(db, **kw):
    kw.setdefault("updated_at", NOW)  # 显式 updated_at，避免依赖真实时钟
    lead = CrmLead(**kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _mk_follow(db, **kw):
    kw.setdefault("type", "note")
    kw.setdefault("content", "x")
    f = CrmFollow(**kw)
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


# =====================================================================
# entered_stage_at 写路径（lead_service）
# =====================================================================


def test_create_lead_sets_entered_stage_at(db_session):
    lead = lead_service.create_lead(db_session, LeadCreate(name="L1"), user_id=U1)
    assert lead.entered_stage_at is not None


def test_update_lead_status_change_resets_entered_stage_at(db_session):
    lead = lead_service.create_lead(db_session, LeadCreate(name="L1"), user_id=U1)
    # 回拨进入时间，模拟已在 new 阶段停留
    orm = db_session.execute(select(CrmLead).where(CrmLead.id == lead.id)).scalar_one()
    orm.entered_stage_at = NOW - timedelta(days=10)
    db_session.commit()

    updated = lead_service.update_lead(
        db_session, lead.id, LeadUpdate(status="contacting")
    )
    assert updated.status == "contacting"
    assert updated.entered_stage_at is not None
    assert updated.entered_stage_at != NOW - timedelta(days=10)
    assert updated.entered_stage_at > NOW - timedelta(days=1)


def test_update_lead_non_status_change_keeps_entered_stage_at(db_session):
    lead = lead_service.create_lead(db_session, LeadCreate(name="L1"), user_id=U1)
    orm = db_session.execute(select(CrmLead).where(CrmLead.id == lead.id)).scalar_one()
    orm.entered_stage_at = NOW - timedelta(days=10)
    db_session.commit()

    updated = lead_service.update_lead(
        db_session, lead.id, LeadUpdate(remark="改备注，不动状态")
    )
    assert updated.status == "new"
    assert updated.entered_stage_at == NOW - timedelta(days=10)


def test_convert_lead_sets_entered_stage_at(db_session):
    lead = lead_service.create_lead(db_session, LeadCreate(name="L1"), user_id=U1)
    resp = lead_service.convert_lead(
        db_session, lead.id, ConvertLeadRequest(), user_id=U1
    )
    assert resp is not None
    assert resp.lead.status == "converted"
    assert resp.lead.entered_stage_at is not None


# =====================================================================
# get_funnel_metrics — 权限
# =====================================================================


def test_funnel_non_admin_forbidden(db_session):
    with pytest.raises(HTTPException) as exc:
        dashboard_service.get_funnel_metrics(
            db_session, is_admin=False, dimension="owner"
        )
    assert exc.value.status_code == 403


def test_funnel_unknown_dimension(db_session):
    with pytest.raises(ValueError):
        dashboard_service.get_funnel_metrics(db_session, is_admin=True, dimension="xxx")


# =====================================================================
# get_funnel_metrics — dimension=owner
# =====================================================================


def test_funnel_by_owner_groups_and_total(db_session):
    _mk_lead(
        db_session,
        name="L1",
        status="new",
        owner_id=U1,
        entered_stage_at=NOW - timedelta(days=1),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        owner_id=U1,
        entered_stage_at=NOW - timedelta(days=2),
    )
    _mk_lead(
        db_session,
        name="L3",
        status="new",
        owner_id=U2,
        entered_stage_at=NOW - timedelta(days=3),
    )
    _mk_lead(
        db_session,
        name="L4",
        status="new",
        owner_id=None,
        entered_stage_at=NOW - timedelta(days=4),
    )  # 线索池
    _mk_lead(
        db_session,
        name="L5",
        status="new",
        owner_id=U1,
        entered_stage_at=NOW - timedelta(days=5),
        is_deleted=True,
    )

    m = dashboard_service.get_funnel_metrics(
        db_session, is_admin=True, dimension="owner"
    )
    assert m.dimension == "owner"
    assert m.total == {
        "new": 3,
        "contacting": 1,
        "qualified": 0,
        "converted": 0,
        "discarded": 0,
    }
    by_key = {i.key: i for i in m.items}
    assert by_key[U1].funnel == {
        "new": 1,
        "contacting": 1,
        "qualified": 0,
        "converted": 0,
        "discarded": 0,
    }
    assert by_key[U2].funnel["new"] == 1
    assert "" in by_key  # 线索池（owner_id=None）
    assert by_key[""].label is None


# =====================================================================
# get_funnel_metrics — dimension=source
# =====================================================================


def test_funnel_by_source_groups_and_unknown_key(db_session):
    _mk_lead(
        db_session, name="L1", status="new", source="exhibition", entered_stage_at=NOW
    )
    _mk_lead(
        db_session,
        name="L2",
        status="qualified",
        source="exhibition",
        entered_stage_at=NOW,
    )
    _mk_lead(
        db_session, name="L3", status="contacting", source=None, entered_stage_at=NOW
    )

    m = dashboard_service.get_funnel_metrics(
        db_session, is_admin=True, dimension="source"
    )
    by_key = {i.key: i for i in m.items}
    assert by_key["exhibition"].funnel["new"] == 1
    assert by_key["exhibition"].funnel["qualified"] == 1
    assert by_key[""].funnel["contacting"] == 1  # 来源未知
    assert (
        m.total["new"] == 1 and m.total["contacting"] == 1 and m.total["qualified"] == 1
    )


# =====================================================================
# get_funnel_metrics — dimension=time + 时间过滤
# =====================================================================


def test_funnel_by_time_month_buckets_by_entered_stage_at(db_session):
    _mk_lead(
        db_session,
        name="L1",
        status="new",
        entered_stage_at=datetime(2026, 7, 5, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        entered_stage_at=datetime(2026, 6, 20, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session,
        name="L3",
        status="qualified",
        entered_stage_at=datetime(2026, 6, 15, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session, name="L4", status="new", entered_stage_at=None
    )  # 历史数据不计入分桶

    m = dashboard_service.get_funnel_metrics(
        db_session, is_admin=True, dimension="time"
    )
    by_key = {i.key: i for i in m.items}
    assert set(by_key) == {"2026-07", "2026-06"}
    assert by_key["2026-07"].funnel["new"] == 1
    assert by_key["2026-06"].funnel["contacting"] == 1
    assert by_key["2026-06"].funnel["qualified"] == 1
    # total 含历史数据（当前状态快照）
    assert m.total == {
        "new": 2,
        "contacting": 1,
        "qualified": 1,
        "converted": 0,
        "discarded": 0,
    }


def test_funnel_time_filter_uses_entered_stage_at(db_session):
    _mk_lead(
        db_session,
        name="L1",
        status="new",
        entered_stage_at=datetime(2026, 7, 5, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        entered_stage_at=datetime(2026, 6, 20, 10, 0, tzinfo=SH),
    )
    _mk_lead(db_session, name="L3", status="new", entered_stage_at=None)

    m = dashboard_service.get_funnel_metrics(
        db_session,
        is_admin=True,
        dimension="owner",
        start_at=datetime(2026, 7, 1, 0, 0, tzinfo=SH),
        end_at=datetime(2026, 8, 1, 0, 0, tzinfo=SH),
    )
    assert m.start_at == datetime(2026, 7, 1, 0, 0, tzinfo=SH)
    assert m.total == {
        "new": 1,
        "contacting": 0,
        "qualified": 0,
        "converted": 0,
        "discarded": 0,
    }


def test_funnel_owner_and_source_filters(db_session):
    _mk_lead(
        db_session,
        name="L1",
        status="new",
        owner_id=U1,
        source="exhibition",
        entered_stage_at=NOW,
    )
    _mk_lead(
        db_session,
        name="L2",
        status="new",
        owner_id=U2,
        source="exhibition",
        entered_stage_at=NOW,
    )
    _mk_lead(
        db_session,
        name="L3",
        status="contacting",
        owner_id=U1,
        source="referral",
        entered_stage_at=NOW,
    )

    m = dashboard_service.get_funnel_metrics(
        db_session, is_admin=True, dimension="owner", owner_id=U1, source="exhibition"
    )
    assert m.total == {
        "new": 1,
        "contacting": 0,
        "qualified": 0,
        "converted": 0,
        "discarded": 0,
    }


# =====================================================================
# get_stage_detail — 权限 / 参数
# =====================================================================


def test_stage_detail_non_admin_forbidden(db_session):
    with pytest.raises(HTTPException) as exc:
        dashboard_service.get_stage_detail(
            db_session, is_admin=False, stage="contacting"
        )
    assert exc.value.status_code == 403


def test_stage_detail_unknown_stage(db_session):
    with pytest.raises(ValueError):
        dashboard_service.get_stage_detail(db_session, is_admin=True, stage="nope")


# =====================================================================
# get_stage_detail — dwell / stuck / last_action / 排序
# =====================================================================


def test_stage_detail_dwell_sorted_stuck_and_last_action(db_session):
    # contacting 阶段 3 条：L1 进阶段 14 天前（卡），L2 4 天前（未卡），L3 历史数据（无 entered_stage_at，回退 updated_at=23 天前）
    l1 = _mk_lead(
        db_session,
        name="L1",
        status="contacting",
        owner_id=U1,
        entered_stage_at=NOW - timedelta(days=14),
        updated_at=NOW - timedelta(days=14),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        owner_id=U1,
        entered_stage_at=NOW - timedelta(days=4),
        updated_at=NOW - timedelta(days=4),
    )
    _mk_lead(
        db_session,
        name="L3",
        status="contacting",
        owner_id=U2,
        entered_stage_at=None,
        updated_at=NOW - timedelta(days=23),
    )
    _mk_lead(db_session, name="L4", status="new", entered_stage_at=NOW)  # 别的阶段不计
    _mk_follow(
        db_session,
        entity_type="lead",
        entity_id=l1.id,
        created_at=NOW - timedelta(days=2),
        content="电话沟通中",
    )

    d = dashboard_service.get_stage_detail(
        db_session, is_admin=True, stage="contacting", now=NOW
    )
    assert d.stage == "contacting"
    assert d.count == 3
    assert d.total == 3
    assert d.stuck_days == 7
    # 默认按停留时长降序：L3(23d) → L1(14d) → L2(4d)
    assert [x.name for x in d.leads] == ["L3", "L1", "L2"]
    assert d.leads[0].dwell_days == 23.0
    assert d.leads[0].is_stuck is True
    assert d.leads[1].dwell_days == 14.0
    assert d.leads[1].is_stuck is True
    assert d.leads[2].dwell_days == 4.0
    assert d.leads[2].is_stuck is False
    # last_action_at = max(CrmFollow.created_at)
    assert d.leads[1].last_action_at == NOW - timedelta(days=2)
    assert d.leads[1].last_action_content == "电话沟通中"
    assert d.leads[0].last_action_at is None  # 无跟进
    # 摘要：avg = (23+14+4)/3 = 13.666.. → 13.7；卡点 2 条
    assert d.avg_dwell_days == 13.7
    assert d.stuck_count == 2


def test_stage_detail_sort_recent(db_session):
    _mk_lead(
        db_session,
        name="L1",
        status="contacting",
        entered_stage_at=NOW - timedelta(days=14),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        entered_stage_at=NOW - timedelta(days=4),
    )
    l2 = db_session.execute(select(CrmLead).where(CrmLead.name == "L2")).scalar_one()
    _mk_follow(
        db_session,
        entity_type="lead",
        entity_id=l2.id,
        created_at=NOW - timedelta(days=1),
    )

    d = dashboard_service.get_stage_detail(
        db_session, is_admin=True, stage="contacting", sort_by="recent", now=NOW
    )
    # 有最后动作的排前面（L2），其余 NULLS LAST（L1 无跟进）
    assert [x.name for x in d.leads] == ["L2", "L1"]


def test_stage_detail_inflow_outflow_and_filters(db_session):
    # contacting 阶段当前成员：2 条在 7 月进入
    _mk_lead(
        db_session,
        name="L1",
        status="contacting",
        owner_id=U1,
        entered_stage_at=datetime(2026, 7, 10, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        owner_id=U2,
        entered_stage_at=datetime(2026, 6, 20, 10, 0, tzinfo=SH),
    )
    _mk_lead(
        db_session, name="L3", status="contacting", owner_id=U1, entered_stage_at=None
    )  # 历史
    # 后续阶段：qualified 1 条 7 月进入 → 流出 contacting
    _mk_lead(
        db_session,
        name="Q1",
        status="qualified",
        owner_id=U1,
        entered_stage_at=datetime(2026, 7, 15, 10, 0, tzinfo=SH),
    )
    # 弃置不参与阶段流失（右上角单独展示）
    _mk_lead(
        db_session,
        name="D1",
        status="discarded",
        owner_id=U1,
        entered_stage_at=datetime(2026, 7, 1, 10, 0, tzinfo=SH),
    )

    start = datetime(2026, 7, 1, 0, 0, tzinfo=SH)
    end = datetime(2026, 8, 1, 0, 0, tzinfo=SH)
    d = dashboard_service.get_stage_detail(
        db_session,
        is_admin=True,
        stage="contacting",
        start_at=start,
        end_at=end,
        now=NOW,
    )
    assert d.count == 3
    assert d.inflow == 1  # 7 月进入且仍在 contacting 的只有 L1
    assert d.outflow == 1  # Q1 在 7 月进入后续阶段（qualified）

    # 无 period → inflow = 全部成员，outflow = None
    d2 = dashboard_service.get_stage_detail(
        db_session, is_admin=True, stage="contacting", now=NOW
    )
    assert d2.inflow == 3
    assert d2.outflow is None

    # owner 过滤
    d3 = dashboard_service.get_stage_detail(
        db_session, is_admin=True, stage="contacting", owner_id=U1, now=NOW
    )
    assert d3.count == 2
    assert {x.name for x in d3.leads} == {"L1", "L3"}


def test_stage_detail_empty_stage(db_session):
    d = dashboard_service.get_stage_detail(
        db_session, is_admin=True, stage="converted", now=NOW
    )
    assert d.count == 0
    assert d.avg_dwell_days is None
    assert d.stuck_count == 0
    assert d.inflow == 0
    assert d.leads == []
