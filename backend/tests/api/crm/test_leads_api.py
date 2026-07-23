"""线索端点集成测试 — CRUD / scope / keyword / 线索池 / 鉴权。"""
from __future__ import annotations


def _create(client, headers, name="线索A", **extra):
    r = client.post("/api/v1/crm/leads", headers=headers, json={"name": name, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _to_pool(client, headers, lead_id):
    r = client.post("/api/v1/crm/leads/batch-move-pool", headers=headers, json={"ids": [lead_id]})
    assert r.status_code == 204


def test_leads_require_auth(client):
    assert client.get("/api/v1/crm/leads").status_code in (401, 403)


def test_create_lead_defaults_and_new_fields(client, admin_headers, test_admin):
    item = _create(client, admin_headers, name="张三", company="某工厂",
                   customer_type="工厂", interested_service="代运营")
    assert item["owner_id"] == str(test_admin["id"])
    assert item["customer_type"] == "工厂"
    assert item["interested_service"] == "代运营"
    assert item["status"] == "new"
    assert item["intent"] == "medium"


def test_get_lead_and_404(client, admin_headers):
    item = _create(client, admin_headers)
    assert client.get(f"/api/v1/crm/leads/{item['id']}", headers=admin_headers).json()["id"] == item["id"]
    assert client.get("/api/v1/crm/leads/999999", headers=admin_headers).status_code == 404


def test_update_lead_and_404(client, admin_headers):
    item = _create(client, admin_headers, name="旧")
    upd = client.patch(f"/api/v1/crm/leads/{item['id']}", headers=admin_headers,
                       json={"status": "qualified", "intent": "high"})
    assert upd.status_code == 200
    assert upd.json()["status"] == "qualified"
    assert upd.json()["intent"] == "high"
    assert client.patch("/api/v1/crm/leads/999999", headers=admin_headers, json={"name": "x"}).status_code == 404


def test_lead_scope_mine_all_sea(client, admin_headers, operator_headers, test_operator):
    _create(client, admin_headers, name="admin 线索")
    _create(client, operator_headers, name="op 线索")
    sea = _create(client, admin_headers, name="池线索")
    _to_pool(client, admin_headers, sea["id"])

    assert client.get("/api/v1/crm/leads?scope=all", headers=admin_headers).json()["total"] == 3
    op_mine = client.get("/api/v1/crm/leads?scope=mine", headers=operator_headers).json()
    assert op_mine["total"] == 1
    assert op_mine["items"][0]["owner_id"] == str(test_operator["id"])
    pool = client.get("/api/v1/crm/leads?scope=sea", headers=admin_headers).json()
    assert pool["total"] == 1
    assert pool["items"][0]["owner_id"] is None


def test_lead_keyword_filter(client, admin_headers):
    _create(client, admin_headers, name="张三", company="阿里巴巴")
    _create(client, admin_headers, name="李四", company="腾讯")
    assert client.get("/api/v1/crm/leads?keyword=阿里", headers=admin_headers).json()["total"] == 1
    assert client.get("/api/v1/crm/leads?keyword=李四", headers=admin_headers).json()["total"] == 1


def test_lead_batch_transfer(client, admin_headers, test_operator):
    lead = _create(client, admin_headers)
    r = client.post("/api/v1/crm/leads/batch-transfer", headers=admin_headers,
                    json={"ids": [lead["id"]], "to_owner_id": str(test_operator["id"])})
    assert r.status_code == 204
    assert client.get(f"/api/v1/crm/leads/{lead['id']}", headers=admin_headers).json()["owner_id"] == str(test_operator["id"])


def test_lead_claim_from_pool_and_conflict(client, admin_headers, test_admin):
    lead = _create(client, admin_headers)
    _to_pool(client, admin_headers, lead["id"])
    claim = client.post(f"/api/v1/crm/leads/{lead['id']}/claim", headers=admin_headers)
    assert claim.status_code == 200
    assert claim.json()["owner_id"] == str(test_admin["id"])
    assert client.post(f"/api/v1/crm/leads/{lead['id']}/claim", headers=admin_headers).status_code == 409
