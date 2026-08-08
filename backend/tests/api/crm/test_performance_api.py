"""业绩看板 API 集成测试 — BLF-519。

覆盖：/crm/dashboard/performance
- scope=mine：员工/管理员均可访问，返回本人指标 + 我的排名（ranking 空）
- scope=all：管理员可访问（全局合计 + 全员排名表）；非管理员 → 403
- month / sort_by 参数 + 非法参数 400/422
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmFollow, CrmLead, CrmTask

SH = ZoneInfo("Asia/Shanghai")
MONTH_START = datetime(2026, 7, 1, 0, 0, 0, tzinfo=SH)
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)

OP1_ID = "590dffdf-0383-4731-8fca-a9d61fdb8861"  # 测试运营
OP2_ID = "8e38c945-6334-4fc5-b215-0dff89557fe0"  # 测试招商


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
    kw.setdefault("entity_type", "lead")
    kw.setdefault("entity_id", 1)
    kw.setdefault("type", "note")
    kw.setdefault("content", "x")
    f = CrmFollow(**kw)
    db.add(f)
    db.commit()
    db.refresh(f)
    return f


def _mk_task(db, **kw):
    kw.setdefault("created_at", NOW)
    kw.setdefault("status", "pending")
    kw.setdefault("title", "T")
    t = CrmTask(**kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_performance_mine_for_operator(client, db_session, operator_headers):
    _mk_customer(db_session, name="C1", owner_id=OP1_ID)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=OP1_ID,
        converted_at=MONTH_START + timedelta(days=2),
    )
    _mk_follow(db_session, created_by=OP1_ID)
    _mk_task(
        db_session,
        owner_id=OP1_ID,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(db_session, owner_id=OP1_ID, status="pending")

    r = client.get(
        "/api/v1/crm/dashboard/performance?scope=mine&month=2026-07", headers=operator_headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "mine"
    assert body["month"] == "2026-07"
    assert body["mine"]["new_customers"] == 1
    assert body["mine"]["converted_count"] == 1
    assert body["mine"]["follow_count"] == 1
    assert body["mine"]["completion_rate"] == 0.5
    assert body["my_rank"] == 1
    assert body["total_users"] == 3
    assert body["ranking"] == []


def test_performance_all_admin(client, db_session, admin_headers):
    _mk_customer(db_session, name="C1", owner_id=OP1_ID)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=OP1_ID,
        converted_at=MONTH_START + timedelta(days=2),
    )

    r = client.get("/api/v1/crm/dashboard/performance?scope=all&month=2026-07", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "all"
    assert body["global_metrics"]["new_customers"] == 1
    assert body["global_metrics"]["converted_count"] == 1
    assert len(body["ranking"]) == 3
    assert body["ranking"][0]["owner_id"] == OP1_ID
    assert body["ranking"][0]["rank"] == 1


def test_performance_all_non_admin_403(client, operator_headers):
    r = client.get(
        "/api/v1/crm/dashboard/performance?scope=all", headers=operator_headers
    )
    assert r.status_code == 403


def test_performance_mine_default_scope(client, operator_headers):
    # 缺省 scope=mine
    r = client.get("/api/v1/crm/dashboard/performance?month=2026-07", headers=operator_headers)
    assert r.status_code == 200, r.text
    assert r.json()["scope"] == "mine"


def test_performance_month_param(client, db_session, operator_headers):
    _mk_customer(
        db_session,
        name="C上月",
        owner_id=OP1_ID,
        created_at=datetime(2026, 6, 15, tzinfo=SH),
    )
    r = client.get(
        "/api/v1/crm/dashboard/performance?scope=mine&month=2026-06",
        headers=operator_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["month"] == "2026-06"
    assert r.json()["mine"]["new_customers"] == 1


def test_performance_invalid_month_400(client, operator_headers):
    r = client.get(
        "/api/v1/crm/dashboard/performance?scope=mine&month=2026-13",
        headers=operator_headers,
    )
    assert r.status_code == 400


def test_performance_bad_sort_by_422(client, admin_headers):
    r = client.get(
        "/api/v1/crm/dashboard/performance?scope=all&sort_by=bogus",
        headers=admin_headers,
    )
    assert r.status_code == 422
