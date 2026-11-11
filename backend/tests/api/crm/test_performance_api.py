"""业绩看板 API 集成测试 — BLF-519。

覆盖：/crm/dashboard/performance
- scope=mine：员工/管理员均可访问，返回本人指标 + 我的排名（ranking 空）
- scope=all：管理员可访问（全局合计 + 全员排名表）；非管理员 → 403
- month / sort_by 参数 + 非法参数 400/422
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models.crm import CrmCustomer, CrmFollow, CrmLead, CrmTask

SH = ZoneInfo("Asia/Shanghai")
MONTH_START = datetime(2026, 7, 1, 0, 0, 0, tzinfo=SH)
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)


# ── 三个「人」的 id ──────────────────────────────────────────────────────────
# ⚠️ 这里**不能写死 UUID**：`backend-go/cmd/seedtestaccounts` 用数据库默认的
# `gen_random_uuid()` 建账号，**每个测试库的账号 id 都不一样**。
# 写死的历史 UUID 只在"当年那个库"里存在，换个库（CI 的全新库 / 新同事的机器）
# 就对不上 → 业绩指标算到"不存在的人"头上 → 全 0 / 排名错位。
#
# 改成**按 email 从库里查真实 id**（seed 脚本保证这三个账号存在）。
@pytest.fixture
def _seeded_accounts(db_session, settings):
    """按 email 取种子账号的真实 id（operator / businessdev）。"""
    wanted = {
        settings.test_operator_email.lower(): "operator",
        settings.test_businessdev_email.lower(): "businessdev",
    }
    rows = db_session.execute(
        text(
            "select email, id::text as id from public.user_accounts "
            "where is_active = true"
        )
    ).mappings().all()
    by_email = {r["email"].lower(): r["id"] for r in rows}

    out = {}
    missing = [e for e in wanted if e not in by_email]
    for email, role in wanted.items():
        if email in by_email:
            out[role] = by_email[email]
    if missing:
        pytest.fail(
            f"测试账号缺失: {missing} —— 先跑 `python backend-go/cmd/seedtestaccounts`"
        )
    return out


@pytest.fixture
def op1_id(_seeded_accounts):
    """测试运营的真实 id。"""
    return _seeded_accounts["operator"]


@pytest.fixture
def op2_id(_seeded_accounts):
    """测试招商的真实 id。"""
    return _seeded_accounts["businessdev"]


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


def test_performance_mine_for_operator(client, db_session, operator_headers, op1_id):
    _mk_customer(db_session, name="C1", owner_id=op1_id)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=op1_id,
        converted_at=MONTH_START + timedelta(days=2),
    )
    _mk_follow(db_session, created_by=op1_id)
    _mk_task(
        db_session,
        owner_id=op1_id,
        status="done",
        completed_at=MONTH_START + timedelta(days=1),
    )
    _mk_task(db_session, owner_id=op1_id, status="pending")

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


def test_performance_all_admin(client, db_session, admin_headers, op1_id):
    _mk_customer(db_session, name="C1", owner_id=op1_id)
    _mk_lead(
        db_session,
        name="L1",
        status="converted",
        owner_id=op1_id,
        converted_at=MONTH_START + timedelta(days=2),
    )

    r = client.get("/api/v1/crm/dashboard/performance?scope=all&month=2026-07", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "all"
    assert body["global_metrics"]["new_customers"] == 1
    assert body["global_metrics"]["converted_count"] == 1
    assert len(body["ranking"]) == 3
    assert body["ranking"][0]["owner_id"] == op1_id
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


def test_performance_month_param(client, db_session, operator_headers, op1_id):
    _mk_customer(
        db_session,
        name="C上月",
        owner_id=op1_id,
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
