"""跟进端点集成测试 — 创建/列表/回写客户最后跟进/下次提醒。"""
from __future__ import annotations


def _mk_customer(client, headers, name="客户A"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_lead(client, headers, name="线索A"):
    r = client.post("/api/v1/crm/leads", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_create_follow_on_customer_and_list(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    r = client.post("/api/v1/crm/follows", headers=admin_headers,
                    json={"entity_type": "customer", "entity_id": cust["id"], "type": "phone", "content": "首次电话"})
    assert r.status_code == 201, r.text
    f = r.json()
    assert f["type"] == "phone"
    assert f["content"] == "首次电话"

    lst = client.get(f"/api/v1/crm/follows?entity_type=customer&entity_id={cust['id']}", headers=admin_headers).json()
    assert len(lst) == 1
    assert lst[0]["content"] == "首次电话"


def test_create_follow_with_next_follow_at(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    r = client.post("/api/v1/crm/follows", headers=admin_headers,
                    json={"entity_type": "customer", "entity_id": cust["id"], "type": "visit",
                          "content": "拜访", "next_follow_at": "2026-08-01T10:00:00+00:00"})
    assert r.status_code == 201
    assert r.json()["next_follow_at"] is not None


def test_create_follow_updates_customer_last_follow_at(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    assert cust["last_follow_at"] is None
    client.post("/api/v1/crm/follows", headers=admin_headers,
                json={"entity_type": "customer", "entity_id": cust["id"], "content": "跟进"})
    got = client.get(f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers).json()
    assert got["last_follow_at"] is not None


def test_create_follow_on_lead(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    r = client.post("/api/v1/crm/follows", headers=admin_headers,
                    json={"entity_type": "lead", "entity_id": lead["id"], "type": "wechat", "content": "微信"})
    assert r.status_code == 201
    lst = client.get(f"/api/v1/crm/follows?entity_type=lead&entity_id={lead['id']}", headers=admin_headers).json()
    assert len(lst) == 1


def test_follows_require_auth(client):
    assert client.get("/api/v1/crm/follows?entity_type=customer&entity_id=1").status_code in (401, 403)
