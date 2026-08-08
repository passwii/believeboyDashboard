"""漏斗指标 API 集成测试 — BLF-517。

覆盖：/crm/dashboard/funnel（owner/source/time 维度 + 过滤 + 权限墙）
     + /crm/dashboard/funnel/stage/{stage}（明细 + 排序 + 权限墙 + 非法参数）。
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.models.crm import CrmLead

SH = ZoneInfo("Asia/Shanghai")
NOW = datetime(2026, 7, 24, 10, 0, 0, tzinfo=SH)

U1 = "11111111-1111-1111-1111-111111111111"


def _mk_lead(db, **kw):
    kw.setdefault("updated_at", NOW)
    lead = CrmLead(**kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def test_funnel_api_owner_dimension(client, db_session, admin_headers):
    _mk_lead(db_session, name="L1", status="new", owner_id=U1, entered_stage_at=NOW)
    _mk_lead(
        db_session, name="L2", status="contacting", owner_id=None, entered_stage_at=NOW
    )
    r = client.get(
        "/api/v1/crm/dashboard/funnel?dimension=owner", headers=admin_headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dimension"] == "owner"
    assert body["total"]["new"] == 1 and body["total"]["contacting"] == 1
    keys = {i["key"] for i in body["items"]}
    assert U1 in keys and "" in keys


def test_funnel_api_time_filter(client, db_session, admin_headers):
    _mk_lead(
        db_session,
        name="L1",
        status="qualified",
        entered_stage_at=datetime(2026, 7, 10, 10, 0, tzinfo=SH),
    )
    r = client.get(
        "/api/v1/crm/dashboard/funnel?dimension=source&start_at=2026-07-01T00:00:00%2B08:00&end_at=2026-08-01T00:00:00%2B08:00",
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert r.json()["total"]["qualified"] == 1


def test_funnel_api_bad_dimension_422(client, admin_headers):
    # FastAPI 在参数层就用 Literal 校验 → 422（服务层 ValueError 是防御兜底）
    r = client.get("/api/v1/crm/dashboard/funnel?dimension=xxx", headers=admin_headers)
    assert r.status_code == 422


def test_funnel_api_non_admin_403(client, operator_headers):
    r = client.get(
        "/api/v1/crm/dashboard/funnel?dimension=owner", headers=operator_headers
    )
    assert r.status_code == 403


def test_stage_detail_api(client, db_session, admin_headers):
    # API 走真实时钟：用相对真实 now 的进入时间构造卡点/未卡点
    real_now = datetime.now(SH)
    _mk_lead(
        db_session,
        name="L1",
        status="contacting",
        owner_id=U1,
        entered_stage_at=real_now - timedelta(days=14),
        updated_at=real_now - timedelta(days=14),
    )
    _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        owner_id=None,
        entered_stage_at=real_now - timedelta(days=4),
        updated_at=real_now - timedelta(days=4),
    )
    r = client.get(
        "/api/v1/crm/dashboard/funnel/stage/contacting", headers=admin_headers
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["stage"] == "contacting"
    assert body["count"] == 2
    assert body["stuck_count"] == 1
    assert [x["name"] for x in body["leads"]] == ["L1", "L2"]  # 停留时长降序
    assert body["leads"][0]["is_stuck"] is True
    assert body["leads"][1]["is_stuck"] is False


def test_stage_detail_api_recent_sort(client, db_session, admin_headers):
    from app.models.crm import CrmFollow

    _mk_lead(
        db_session,
        name="L1",
        status="contacting",
        entered_stage_at=NOW - timedelta(days=14),
    )
    l2 = _mk_lead(
        db_session,
        name="L2",
        status="contacting",
        entered_stage_at=NOW - timedelta(days=4),
    )
    db_session.add(
        CrmFollow(
            entity_type="lead",
            entity_id=l2.id,
            type="phone",
            content="跟进",
            created_at=NOW - timedelta(days=1),
        )
    )
    db_session.commit()
    r = client.get(
        "/api/v1/crm/dashboard/funnel/stage/contacting?sort_by=recent",
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    assert [x["name"] for x in r.json()["leads"]] == ["L2", "L1"]


def test_stage_detail_api_bad_stage_400(client, admin_headers):
    r = client.get("/api/v1/crm/dashboard/funnel/stage/nope", headers=admin_headers)
    assert r.status_code == 400


def test_stage_detail_api_non_admin_403(client, operator_headers):
    r = client.get(
        "/api/v1/crm/dashboard/funnel/stage/contacting", headers=operator_headers
    )
    assert r.status_code == 403
