"""待跟进视图端点集成测试 — 分组/scope 过滤/线索/鉴权。

today 条目用「上海时区今日正午」保证确定性（避免 UTC 偏移跨日导致 today/this_week 漂移）；
逾期/超出本周用固定极值日期。日/周边界数学已在 service 层（注入 now）覆盖。
"""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

SH = ZoneInfo("Asia/Shanghai")
OVERDUE = "2020-01-01T10:00:00+00:00"
BEYOND = "2099-01-01T10:00:00+00:00"


def _today_shanghai_iso() -> str:
    return datetime.now(SH).replace(hour=12, minute=0, second=0, microsecond=0).isoformat()


def _mk_customer(client, headers, name="客户"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_lead(client, headers, name="线索"):
    r = client.post("/api/v1/crm/leads", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _follow(client, headers, entity_type, entity_id, next_follow_at):
    body = {"entity_type": entity_type, "entity_id": entity_id, "content": "跟进", "next_follow_at": next_follow_at}
    r = client.post("/api/v1/crm/follows", headers=headers, json=body)
    assert r.status_code == 201, r.text


def test_follow_ups_requires_auth(client):
    assert client.get("/api/v1/crm/follow-ups").status_code in (401, 403)


def test_follow_ups_grouping_overdue_today_beyond_excluded(client, admin_headers):
    c_over = _mk_customer(client, admin_headers, name="逾期客户")
    _follow(client, admin_headers, "customer", c_over["id"], OVERDUE)
    c_today = _mk_customer(client, admin_headers, name="今日客户")
    _follow(client, admin_headers, "customer", c_today["id"], _today_shanghai_iso())
    c_beyond = _mk_customer(client, admin_headers, name="明年客户")
    _follow(client, admin_headers, "customer", c_beyond["id"], BEYOND)

    g = client.get("/api/v1/crm/follow-ups", headers=admin_headers).json()
    assert [i["name"] for i in g["overdue"]] == ["逾期客户"]
    assert [i["name"] for i in g["today"]] == ["今日客户"]
    assert g["overdue_count"] == 1
    assert g["total_count"] == 2  # 明年客户不计入


def test_follow_ups_lead_included(client, admin_headers):
    lead = _mk_lead(client, admin_headers, name="逾期线索")
    _follow(client, admin_headers, "lead", lead["id"], OVERDUE)
    g = client.get("/api/v1/crm/follow-ups", headers=admin_headers).json()
    assert [i["name"] for i in g["overdue"]] == ["逾期线索"]
    assert g["overdue"][0]["entity_type"] == "lead"


def test_follow_ups_sales_sees_own_only(client, admin_headers, operator_headers):
    a = _mk_customer(client, admin_headers, name="admin 的")
    _follow(client, admin_headers, "customer", a["id"], OVERDUE)
    o = _mk_customer(client, operator_headers, name="operator 的")
    _follow(client, operator_headers, "customer", o["id"], OVERDUE)

    # 销售默认 scope=mine 只见自己
    op = client.get("/api/v1/crm/follow-ups", headers=operator_headers).json()
    assert [i["name"] for i in op["overdue"]] == ["operator 的"]
    # 销售 scope=all 被降级 mine
    op_all = client.get("/api/v1/crm/follow-ups?scope=all", headers=operator_headers).json()
    assert [i["name"] for i in op_all["overdue"]] == ["operator 的"]
    # 管理员 scope=all 见全部
    admin_all = client.get("/api/v1/crm/follow-ups?scope=all", headers=admin_headers).json()
    assert sorted(i["name"] for i in admin_all["overdue"]) == ["admin 的", "operator 的"]


def test_follow_ups_empty(client, admin_headers):
    g = client.get("/api/v1/crm/follow-ups", headers=admin_headers).json()
    assert g["overdue"] == [] and g["today"] == [] and g["this_week"] == []
    assert g["overdue_count"] == 0 and g["total_count"] == 0
