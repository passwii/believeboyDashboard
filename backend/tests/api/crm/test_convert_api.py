"""转化端点集成测试 — convert_lead 全链路（建客户+联系人微信+跟进搬迁+标记）。"""
from __future__ import annotations


def _mk_lead(client, headers, **kw):
    payload = {"name": "张三", "company": "某工厂", "phone": "13800000000",
               "email": "z@x.com", "wechat": "zhang_wx", "customer_type": "工厂",
               "interested_service": "代运营"}
    payload.update(kw)
    r = client.post("/api/v1/crm/leads", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def test_convert_lead_full_flow(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    # 转化前记一条跟进
    client.post("/api/v1/crm/follows", headers=admin_headers,
                json={"entity_type": "lead", "entity_id": lead["id"], "type": "phone", "content": "售前电话"})

    r = client.post(f"/api/v1/crm/leads/{lead['id']}/convert", headers=admin_headers, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    cust = body["customer"]
    assert cust["name"] == "某工厂"
    assert cust["customer_type"] == "工厂"
    assert cust["interested_service"] == "代运营"

    # 线索标记已转化
    assert body["lead"]["status"] == "converted"
    assert body["lead"]["converted_to_customer_id"] == cust["id"]

    # 联系人含微信
    contacts = client.get(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers).json()
    assert len(contacts) == 1
    assert contacts[0]["wechat"] == "zhang_wx"
    assert contacts[0]["is_primary"] is True

    # 跟进搬到新客户
    follows = client.get(f"/api/v1/crm/follows?entity_type=customer&entity_id={cust['id']}", headers=admin_headers).json()
    assert len(follows) == 1
    assert follows[0]["content"] == "售前电话"
    # 线索下无跟进
    lead_follows = client.get(f"/api/v1/crm/follows?entity_type=lead&entity_id={lead['id']}", headers=admin_headers).json()
    assert lead_follows == []


def test_convert_lead_with_overrides(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    r = client.post(f"/api/v1/crm/leads/{lead['id']}/convert", headers=admin_headers,
                    json={"name": "自定义名", "rating": "A"})
    assert r.status_code == 200
    assert r.json()["customer"]["name"] == "自定义名"
    assert r.json()["customer"]["rating"] == "A"


def test_convert_already_converted_409(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    assert client.post(f"/api/v1/crm/leads/{lead['id']}/convert", headers=admin_headers, json={}).status_code == 200
    assert client.post(f"/api/v1/crm/leads/{lead['id']}/convert", headers=admin_headers, json={}).status_code == 409


def test_convert_missing_lead_404(client, admin_headers):
    assert client.post("/api/v1/crm/leads/999999/convert", headers=admin_headers, json={}).status_code == 404
