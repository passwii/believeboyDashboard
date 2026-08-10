"""P6b 产品类目端点集成测试（categories CRUD + 客户类目整体替换）。"""

import uuid

from sqlalchemy import text


def _suffix() -> str:
    return uuid.uuid4().hex[:6]


def _mk_customer(client, admin_headers, name="P6B"):
    return client.post(
        "/api/v1/crm/customers",
        json={"name": name},
        headers=admin_headers,
    ).json()["id"]


def _mk_category(client, admin_headers, name=None):
    r = client.post(
        "/api/v1/crm/categories",
        json={"name": name or f"临时-{_suffix()}"},
        headers=admin_headers,
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_list_categories_any_user(client, operator_headers):
    r = client.get("/api/v1/crm/categories", headers=operator_headers)
    assert r.status_code == 200
    body = r.json()
    assert len(body) >= 9
    assert any(c["name"] == "家居" for c in body)
    orders = [c["sort_order"] for c in body]
    assert orders == sorted(orders)


def test_create_category_admin_ok_and_audits(client, admin_headers):
    cat = _mk_category(client, admin_headers)
    assert cat["name"]
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "category", "entity_id": cat["id"], "action": "create"},
        headers=admin_headers,
    ).json()
    assert logs["total"] == 1
    assert "新建产品类目" in logs["items"][0]["summary"]


def test_create_category_operator_forbidden(client, operator_headers):
    r = client.post(
        "/api/v1/crm/categories",
        json={"name": f"越权-{_suffix()}"},
        headers=operator_headers,
    )
    assert r.status_code == 403


def test_create_category_duplicate_409(client, admin_headers):
    name = f"重名-{_suffix()}"
    _mk_category(client, admin_headers, name)
    r = client.post(
        "/api/v1/crm/categories", json={"name": name}, headers=admin_headers
    )
    assert r.status_code == 409
    assert "已存在" in r.json()["detail"]


def test_update_category_rename_ok(client, admin_headers):
    cat = _mk_category(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/categories/{cat['id']}",
        json={"name": f"改名-{_suffix()}"},
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert r.json()["name"].startswith("改名-")


def test_update_category_operator_forbidden(client, operator_headers):
    r = client.patch(
        "/api/v1/crm/categories/1", json={"name": "x"}, headers=operator_headers
    )
    assert r.status_code == 403


def test_update_category_missing_404(client, admin_headers):
    r = client.patch(
        "/api/v1/crm/categories/999999",
        json={"name": "x"},
        headers=admin_headers,
    )
    assert r.status_code == 404


def test_delete_category_ok(client, admin_headers):
    cat = _mk_category(client, admin_headers)
    r = client.delete(f"/api/v1/crm/categories/{cat['id']}", headers=admin_headers)
    assert r.status_code == 204


def test_delete_category_operator_forbidden(client, operator_headers):
    r = client.delete("/api/v1/crm/categories/1", headers=operator_headers)
    assert r.status_code == 403


def test_set_customer_categories_and_readback(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    a = _mk_category(client, admin_headers)
    b = _mk_category(client, admin_headers)

    r = client.put(
        f"/api/v1/crm/customers/{cid}/categories",
        json={"category_ids": [a["id"], b["id"]]},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert [c["id"] for c in body["categories"]] == [a["id"], b["id"]]

    # 审计摘要：+家居（新类目）
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid, "action": "update"},
        headers=admin_headers,
    ).json()
    last = logs["items"][0]["summary"]
    assert "产品类目" in last and "+" in last

    # 整体替换：移除 b
    r2 = client.put(
        f"/api/v1/crm/customers/{cid}/categories",
        json={"category_ids": [a["id"]]},
        headers=admin_headers,
    )
    assert [c["id"] for c in r2.json()["categories"]] == [a["id"]]
    logs2 = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid, "action": "update"},
        headers=admin_headers,
    ).json()
    assert "-" in logs2["items"][0]["summary"]


def test_list_customers_filter_by_category(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    cat = _mk_category(client, admin_headers)
    client.put(
        f"/api/v1/crm/customers/{cid}/categories",
        json={"category_ids": [cat["id"]]},
        headers=admin_headers,
    )
    r = client.get(
        "/api/v1/crm/customers",
        params={"category_id": cat["id"]},
        headers=admin_headers,
    )
    assert r.status_code == 200
    ids = [i["id"] for i in r.json()["items"]]
    assert cid in ids
    # 且 CustomerItem 带 categories
    mine = next(i for i in r.json()["items"] if i["id"] == cid)
    assert [c["id"] for c in mine["categories"]] == [cat["id"]]


def test_set_customer_categories_operator_own_ok(
    client, admin_headers, operator_headers
):
    # operator 建自己的客户
    cid = _mk_customer(client, operator_headers, name="P6B-op")
    cat = _mk_category(client, admin_headers)
    r = client.put(
        f"/api/v1/crm/customers/{cid}/categories",
        json={"category_ids": [cat["id"]]},
        headers=operator_headers,
    )
    assert r.status_code == 200


def test_set_customer_categories_unknown_400(client, admin_headers):
    cid = _mk_customer(client, admin_headers)
    r = client.put(
        f"/api/v1/crm/customers/{cid}/categories",
        json={"category_ids": [999999]},
        headers=admin_headers,
    )
    assert r.status_code == 400
    assert "类目不存在" in r.json()["detail"]


def test_set_customer_categories_missing_customer_404(client, admin_headers):
    r = client.put(
        "/api/v1/crm/customers/999999/categories",
        json={"category_ids": [1]},
        headers=admin_headers,
    )
    assert r.status_code == 404
