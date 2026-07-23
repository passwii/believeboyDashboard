"""联系人端点集成测试 — CRUD + 主联系人唯一 + 删主递补 + 微信字段。"""
from __future__ import annotations


def _mk_customer(client, headers, name="客户A"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_create_first_contact_becomes_primary(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    r = client.post(
        f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
        json={"name": "张三", "phone": "13800000000"},
    )
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["is_primary"] is True          # 首个联系人自动为主

    # 主联系人 join 进客户列表
    got = client.get(f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers).json()
    assert got["contact_name"] == "张三"
    assert got["contact_phone"] == "13800000000"


def test_create_contact_missing_customer_404(client, admin_headers):
    r = client.post("/api/v1/crm/customers/999999/contacts", headers=admin_headers, json={"name": "x"})
    assert r.status_code == 404


def test_second_primary_demotes_first(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    c1 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "主1", "is_primary": True}).json()
    c2 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "主2", "is_primary": True}).json()
    assert c2["is_primary"] is True
    # 列表里 c1 已被降为非主
    contacts = client.get(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers).json()
    by_id = {c["id"]: c for c in contacts}
    assert by_id[c1["id"]]["is_primary"] is False
    assert by_id[c2["id"]]["is_primary"] is True
    # 列表主联系人排在前
    assert contacts[0]["id"] == c2["id"]


def test_update_contact_set_primary_enforces_single(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    c1 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "主1"}).json()
    c2 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "次2"}).json()
    # 把 c2 设为主
    upd = client.patch(f"/api/v1/crm/contacts/{c2['id']}", headers=admin_headers, json={"is_primary": True})
    assert upd.status_code == 200
    contacts = client.get(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers).json()
    by_id = {c["id"]: c for c in contacts}
    assert by_id[c2["id"]]["is_primary"] is True
    assert by_id[c1["id"]]["is_primary"] is False


def test_delete_primary_promotes_next(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    c1 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "主1"}).json()
    c2 = client.post(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers,
                     json={"name": "次2"}).json()
    # 删主 c1 → c2 递补为主
    dele = client.delete(f"/api/v1/crm/contacts/{c1['id']}", headers=admin_headers)
    assert dele.status_code == 204
    contacts = client.get(f"/api/v1/crm/customers/{cust['id']}/contacts", headers=admin_headers).json()
    assert len(contacts) == 1
    assert contacts[0]["id"] == c2["id"]
    assert contacts[0]["is_primary"] is True


def test_update_and_delete_contact_404(client, admin_headers):
    assert client.patch("/api/v1/crm/contacts/999999", headers=admin_headers, json={"name": "x"}).status_code == 404
    assert client.delete("/api/v1/crm/contacts/999999", headers=admin_headers).status_code == 404
