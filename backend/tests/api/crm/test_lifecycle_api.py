"""生命周期看板 API 集成测试 — BLF-520。

覆盖：GET /api/v1/crm/dashboard/lifecycle
- 管理员可访问：三种分布 + now_in_sea 结构齐全
- 非管理员 → 403
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.models.crm import CrmAuditLog, CrmCustomer, CrmFollow, CrmLead

SH = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)


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


def test_lifecycle_board_admin(client, db_session, admin_headers):
    c = _mk_customer(db_session, name="C1", created_at=NOW, owner_id=None)
    _mk_follow(db_session, entity_id=c.id, created_at=NOW + timedelta(hours=12))
    _mk_lead(
        db_session,
        name="L1",
        created_at=NOW,
        converted_at=NOW + timedelta(days=2),
    )
    _mk_audit = CrmAuditLog(
        entity_type="customer",
        entity_id=c.id,
        action="move_sea",
        created_at=NOW + timedelta(days=4),
    )
    db_session.add(_mk_audit)
    db_session.commit()

    r = client.get("/api/v1/crm/dashboard/lifecycle", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()

    assert set(body) == {"first_follow", "conversion", "churn", "now_in_sea"}
    assert body["now_in_sea"] == 1
    assert body["first_follow"]["summary"]["sample_count"] == 1
    assert body["first_follow"]["buckets"][0]["count"] == 1
    assert body["first_follow"]["buckets"][0]["cumulative_pct"] == 1.0
    assert body["conversion"]["summary"]["sample_count"] == 1
    assert body["conversion"]["buckets"][1]["count"] == 1  # 1-3 天
    assert body["churn"]["summary"]["sample_count"] == 1
    assert body["churn"]["buckets"][2]["count"] == 1  # 3-7 天
    # 六桶固定
    for key in ("first_follow", "conversion", "churn"):
        assert len(body[key]["buckets"]) == 6
        assert body[key]["summary"]["total_count"] >= 1


def test_lifecycle_board_forbidden_for_operator(client, db_session, operator_headers):
    _mk_customer(db_session, name="C1")
    r = client.get("/api/v1/crm/dashboard/lifecycle", headers=operator_headers)
    assert r.status_code == 403, r.text


def test_lifecycle_board_empty(client, admin_headers):
    r = client.get("/api/v1/crm/dashboard/lifecycle", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["now_in_sea"] == 0
    for key in ("first_follow", "conversion", "churn"):
        assert body[key]["summary"]["sample_count"] == 0
        assert all(b["count"] == 0 for b in body[key]["buckets"])
