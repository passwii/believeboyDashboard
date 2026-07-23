"""权限层集成测试 — 销售只见自己+公海 / 指派仅管理员 / 非自己名下写操作 403。

admin_headers → is_admin=True；operator_headers → is_admin=False（普通销售）。
"""
from __future__ import annotations


def _mk_customer(client, headers, name="客户"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_lead(client, headers, name="线索"):
    r = client.post("/api/v1/crm/leads", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


# ── scope=all 降级 mine ──────────────────────────────────────────────────────
def test_nonadmin_scope_all_downgraded_to_mine(client, admin_headers, operator_headers, test_operator):
    _mk_customer(client, admin_headers, name="admin 的客户")
    _mk_customer(client, operator_headers, name="operator 的客户")

    # 管理员 scope=all 看到全部
    admin_all = client.get("/api/v1/crm/customers?scope=all", headers=admin_headers).json()
    assert admin_all["total"] == 2

    # 普通销售 scope=all 被降级为 mine，只看到自己的
    op_all = client.get("/api/v1/crm/customers?scope=all", headers=operator_headers).json()
    assert op_all["total"] == 1
    assert op_all["items"][0]["owner_id"] == str(test_operator["id"])

    # 销售显式 scope=sea（公海）仍可访问
    op_sea = client.get("/api/v1/crm/customers?scope=sea", headers=operator_headers).json()
    assert op_sea["total"] == 0  # 暂无公海客户


def test_nonadmin_scope_all_leads_downgraded(client, admin_headers, operator_headers, test_operator):
    _mk_lead(client, admin_headers, name="admin 线索")
    _mk_lead(client, operator_headers, name="operator 线索")
    op_all = client.get("/api/v1/crm/leads?scope=all", headers=operator_headers).json()
    assert op_all["total"] == 1
    assert op_all["items"][0]["owner_id"] == str(test_operator["id"])


# ── 指派（batch-transfer）仅管理员 ───────────────────────────────────────────
def test_nonadmin_cannot_transfer(client, admin_headers, operator_headers, test_admin):
    cust = _mk_customer(client, operator_headers)
    # 销售指派 → 403
    r = client.post(
        "/api/v1/crm/customers/batch-transfer", headers=operator_headers,
        json={"ids": [cust["id"]], "to_owner_id": str(test_admin["id"])},
    )
    assert r.status_code == 403
    # 管理员指派 → 204
    r2 = client.post(
        "/api/v1/crm/customers/batch-transfer", headers=admin_headers,
        json={"ids": [cust["id"]], "to_owner_id": str(test_admin["id"])},
    )
    assert r2.status_code == 204


def test_nonadmin_cannot_transfer_leads(client, admin_headers, operator_headers, test_admin):
    lead = _mk_lead(client, operator_headers)
    r = client.post(
        "/api/v1/crm/leads/batch-transfer", headers=operator_headers,
        json={"ids": [lead["id"]], "to_owner_id": str(test_admin["id"])},
    )
    assert r.status_code == 403


# ── 非自己名下写操作 → 403 ───────────────────────────────────────────────────
def test_nonadmin_cannot_update_others_customer(client, admin_headers, operator_headers):
    admin_cust = _mk_customer(client, admin_headers, name="admin 的")
    # 销售改别人的客户 → 403
    r = client.patch(f"/api/v1/crm/customers/{admin_cust['id']}", headers=operator_headers, json={"name": "hack"})
    assert r.status_code == 403
    # 销售改自己的 → 200
    op_cust = _mk_customer(client, operator_headers, name="op 的")
    r2 = client.patch(f"/api/v1/crm/customers/{op_cust['id']}", headers=operator_headers, json={"name": "改自己"})
    assert r2.status_code == 200
    # 管理员改任意 → 200
    r3 = client.patch(f"/api/v1/crm/customers/{admin_cust['id']}", headers=admin_headers, json={"name": "admin 改"})
    assert r3.status_code == 200


def test_nonadmin_cannot_delete_others_customer(client, admin_headers, operator_headers):
    admin_cust = _mk_customer(client, admin_headers)
    assert client.delete(f"/api/v1/crm/customers/{admin_cust['id']}", headers=operator_headers).status_code == 403


def test_nonadmin_cannot_convert_others_lead(client, admin_headers, operator_headers):
    admin_lead = _mk_lead(client, admin_headers)
    r = client.post(f"/api/v1/crm/leads/{admin_lead['id']}/convert", headers=operator_headers, json={})
    assert r.status_code == 403
    # 销售转化自己的线索 → 200
    op_lead = _mk_lead(client, operator_headers)
    r2 = client.post(f"/api/v1/crm/leads/{op_lead['id']}/convert", headers=operator_headers, json={})
    assert r2.status_code == 200


# ── 释放回公海：销售只能释放自己的 ───────────────────────────────────────────
def test_nonadmin_batch_move_sea_only_own(client, admin_headers, operator_headers, test_admin):
    admin_cust = _mk_customer(client, admin_headers, name="admin 的")
    op_cust = _mk_customer(client, operator_headers, name="op 的")
    # 销售尝试把两条都移公海 → 只动自己的 op_cust
    r = client.post(
        "/api/v1/crm/customers/batch-move-sea", headers=operator_headers,
        json={"ids": [admin_cust["id"], op_cust["id"]]},
    )
    assert r.status_code == 204
    # admin 的客户仍有主；op 的客户进了公海
    a = client.get(f"/api/v1/crm/customers/{admin_cust['id']}", headers=admin_headers).json()
    o = client.get(f"/api/v1/crm/customers/{op_cust['id']}", headers=admin_headers).json()
    assert a["owner_id"] == str(test_admin["id"])
    assert o["owner_id"] is None
