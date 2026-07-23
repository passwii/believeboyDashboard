"""客户端点集成测试 — CRUD / scope / keyword / 批量转移 / 移公海 / 领取 / 鉴权。"""
from __future__ import annotations


# ── helpers ──────────────────────────────────────────────────────────────────
def _create(client, headers, name="客户A", **extra):
    resp = client.post("/api/v1/crm/customers", headers=headers, json={"name": name, **extra})
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── 鉴权 ─────────────────────────────────────────────────────────────────────
def test_list_customers_requires_auth(client):
    resp = client.get("/api/v1/crm/customers")
    assert resp.status_code in (401, 403)


# ── CRUD ─────────────────────────────────────────────────────────────────────
def test_create_customer_defaults_owner_to_creator(client, admin_headers, test_admin):
    item = _create(client, admin_headers, name="默认归属")
    assert item["name"] == "默认归属"
    assert item["owner_id"] == str(test_admin["id"])  # 默认归创建人
    assert item["created_by"] == str(test_admin["id"])
    assert item["rating"] == "C"
    assert item["status"] == "active"


def test_get_customer_and_404(client, admin_headers):
    item = _create(client, admin_headers)
    got = client.get(f"/api/v1/crm/customers/{item['id']}", headers=admin_headers)
    assert got.status_code == 200
    assert got.json()["id"] == item["id"]

    missing = client.get("/api/v1/crm/customers/999999", headers=admin_headers)
    assert missing.status_code == 404


def test_update_customer_and_404(client, admin_headers):
    item = _create(client, admin_headers, name="旧名")
    upd = client.patch(
        f"/api/v1/crm/customers/{item['id']}", headers=admin_headers,
        json={"name": "新名", "rating": "A"},
    )
    assert upd.status_code == 200
    assert upd.json()["name"] == "新名"
    assert upd.json()["rating"] == "A"

    missing = client.patch("/api/v1/crm/customers/999999", headers=admin_headers, json={"name": "x"})
    assert missing.status_code == 404


def test_delete_customer_soft_then_404(client, admin_headers):
    item = _create(client, admin_headers)
    dele = client.delete(f"/api/v1/crm/customers/{item['id']}", headers=admin_headers)
    assert dele.status_code == 204

    # 软删后列表不可见、详情 404
    lst = client.get("/api/v1/crm/customers", headers=admin_headers).json()
    assert all(c["id"] != item["id"] for c in lst["items"])
    assert client.get(f"/api/v1/crm/customers/{item['id']}", headers=admin_headers).status_code == 404
    # 重复删除 → 404
    assert client.delete(f"/api/v1/crm/customers/{item['id']}", headers=admin_headers).status_code == 404


# ── scope ────────────────────────────────────────────────────────────────────
def _to_sea(client, headers, cust_id):
    r = client.post("/api/v1/crm/customers/batch-move-sea", headers=headers, json={"ids": [cust_id]})
    assert r.status_code == 204


def test_scope_mine_all_sea(client, admin_headers, operator_headers, test_admin, test_operator):
    _create(client, admin_headers, name="admin 的客户")          # owner=admin
    _create(client, operator_headers, name="operator 的客户")    # owner=operator
    sea = _create(client, admin_headers, name="公海客户")
    _to_sea(client, admin_headers, sea["id"])                    # 移入公海（owner=None）

    all_items = client.get("/api/v1/crm/customers?scope=all", headers=admin_headers).json()
    assert all_items["total"] == 3

    mine = client.get("/api/v1/crm/customers?scope=mine", headers=admin_headers).json()
    assert mine["total"] == 1
    assert mine["items"][0]["owner_id"] == str(test_admin["id"])

    sea = client.get("/api/v1/crm/customers?scope=sea", headers=admin_headers).json()
    assert sea["total"] == 1
    assert sea["items"][0]["owner_id"] is None

    # operator 的 mine 只看到自己那条
    op_mine = client.get("/api/v1/crm/customers?scope=mine", headers=operator_headers).json()
    assert op_mine["total"] == 1
    assert op_mine["items"][0]["owner_id"] == str(test_operator["id"])


def test_keyword_filter(client, admin_headers):
    _create(client, admin_headers, name="阿里巴巴")
    _create(client, admin_headers, name="腾讯")
    resp = client.get("/api/v1/crm/customers?keyword=阿里", headers=admin_headers).json()
    assert resp["total"] == 1
    assert resp["items"][0]["name"] == "阿里巴巴"


# ── 批量操作 ─────────────────────────────────────────────────────────────────
def test_batch_transfer(client, admin_headers, test_operator):
    a = _create(client, admin_headers, name="A")
    b = _create(client, admin_headers, name="B")
    resp = client.post(
        "/api/v1/crm/customers/batch-transfer", headers=admin_headers,
        json={"ids": [a["id"], b["id"]], "to_owner_id": str(test_operator["id"])},
    )
    assert resp.status_code == 204
    got = client.get(f"/api/v1/crm/customers/{a['id']}", headers=admin_headers).json()
    assert got["owner_id"] == str(test_operator["id"])


def test_batch_move_to_sea(client, admin_headers):
    a = _create(client, admin_headers, name="A")
    resp = client.post(
        "/api/v1/crm/customers/batch-move-sea", headers=admin_headers, json={"ids": [a["id"]]}
    )
    assert resp.status_code == 204
    got = client.get(f"/api/v1/crm/customers/{a['id']}", headers=admin_headers).json()
    assert got["owner_id"] is None


def test_claim_from_sea_and_conflict(client, admin_headers, test_admin):
    sea_cust = _create(client, admin_headers, name="公海")
    _to_sea(client, admin_headers, sea_cust["id"])
    # 领取成功
    claim = client.post(f"/api/v1/crm/customers/{sea_cust['id']}/claim", headers=admin_headers)
    assert claim.status_code == 200
    assert claim.json()["owner_id"] == str(test_admin["id"])
    # 已有 owner 再领取 → 409
    again = client.post(f"/api/v1/crm/customers/{sea_cust['id']}/claim", headers=admin_headers)
    assert again.status_code == 409
