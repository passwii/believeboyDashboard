"""保存视图 API 集成测试（Stage5-3，BLF-589，CordysCRM 7.3 模式）。

覆盖 `/api/v1/crm/saved-views`：
- GET 可见性：自己的 + 共享的；他人个人视图不可见；entity_type 过滤
- POST 创建（owner_id 回填 / filters 白名单校验 400 / is_shared 非 admin 403）
- PATCH 部分更新（仅 owner；共享视图 owner/admin；403；404；400）
- DELETE（仅 owner；共享视图 owner/admin；404）
- 共享流转：admin 建共享 → 全员可见；admin 可管理共享视图
"""

from __future__ import annotations

import pytest

_BASE = "/api/v1/crm/saved-views"


def _payload(**overrides):
    payload = {
        "name": "我关注的客户",
        "entity_type": "customer",
        "scope": "mine",
        "keyword": "工业",
        "filters": [{"field": "status", "op": "eq", "value": "active"}],
        "sort_by": "updated_at",
        "sort_order": "desc",
    }
    payload.update(overrides)
    return payload


def _create(client, headers, **overrides) -> dict:
    r = client.post(_BASE, json=_payload(**overrides), headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


# ─── GET ──────────────────────────────────────────────────────────────────────


def test_list_empty(client, operator_headers):
    r = client.get(_BASE, headers=operator_headers)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_list_own_views(client, operator_headers):
    _create(client, operator_headers, name="视图A")
    _create(client, operator_headers, name="视图B", entity_type="lead")

    r = client.get(_BASE, headers=operator_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 2
    names = {v["name"] for v in body}
    assert names == {"视图A", "视图B"}
    assert all(v["owner_id"] == operator_headers["X-User-Id"] for v in body)
    assert all(v["is_shared"] is False for v in body)
    # 倒序：最新在前
    assert body[0]["name"] == "视图B"


def test_list_entity_type_filter(client, operator_headers):
    _create(client, operator_headers, name="客户视图", entity_type="customer")
    _create(client, operator_headers, name="线索视图", entity_type="lead")

    r = client.get(_BASE, params={"entity_type": "customer"}, headers=operator_headers)
    assert r.status_code == 200, r.text
    assert [v["name"] for v in r.json()] == ["客户视图"]

    r = client.get(_BASE, params={"entity_type": "lead"}, headers=operator_headers)
    assert [v["name"] for v in r.json()] == ["线索视图"]


def test_list_does_not_leak_others_personal(client, operator_headers, admin_headers):
    _create(client, operator_headers, name="销售个人视图")

    # admin 也看不到他人个人视图
    r = client.get(_BASE, headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_list_includes_shared_views(client, operator_headers, admin_headers):
    _create(client, admin_headers, name="共享视图", is_shared=True)

    r = client.get(_BASE, headers=operator_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["name"] == "共享视图"
    assert body[0]["is_shared"] is True
    assert body[0]["owner_id"] == admin_headers["X-User-Id"]


def test_list_bad_entity_type_422(client, operator_headers):
    r = client.get(_BASE, params={"entity_type": "order"}, headers=operator_headers)
    assert r.status_code == 422, r.text


# ─── POST ─────────────────────────────────────────────────────────────────────


def test_create_view_owner_id_backfilled(client, operator_headers):
    body = _create(client, operator_headers)
    assert body["name"] == "我关注的客户"
    assert body["entity_type"] == "customer"
    assert body["scope"] == "mine"
    assert body["keyword"] == "工业"
    assert body["filters"] == [{"field": "status", "op": "eq", "value": "active"}]
    assert body["sort_by"] == "updated_at"
    assert body["is_shared"] is False
    assert body["owner_id"] == operator_headers["X-User-Id"]
    assert body["owner_name"]  # user_accounts 解析回填
    assert body["created_at"] and body["updated_at"]


def test_create_lead_view(client, operator_headers):
    body = _create(client, operator_headers, entity_type="lead")
    assert body["entity_type"] == "lead"


def test_create_invalid_filter_field_400(client, operator_headers):
    r = client.post(
        _BASE,
        json=_payload(filters=[{"field": "no_such", "op": "eq", "value": "x"}]),
        headers=operator_headers,
    )
    assert r.status_code == 400, r.text
    assert "筛选字段" in r.json()["detail"]


def test_create_invalid_operator_400(client, operator_headers):
    r = client.post(
        _BASE,
        json=_payload(filters=[{"field": "status", "op": "regex", "value": "x"}]),
        headers=operator_headers,
    )
    assert r.status_code == 400, r.text


def test_create_lead_filters_customer_field_400(client, operator_headers):
    """lead 视图不允许 customer 专属字段（rating）。"""
    r = client.post(
        _BASE,
        json=_payload(
            entity_type="lead", filters=[{"field": "rating", "op": "eq", "value": "A"}]
        ),
        headers=operator_headers,
    )
    assert r.status_code == 400, r.text


def test_create_empty_name_422(client, operator_headers):
    r = client.post(_BASE, json=_payload(name=""), headers=operator_headers)
    assert r.status_code == 422, r.text


def test_create_shared_by_operator_forbidden(client, operator_headers):
    r = client.post(_BASE, json=_payload(is_shared=True), headers=operator_headers)
    assert r.status_code == 403, r.text
    assert "Admin" in r.json()["detail"]


def test_create_shared_by_admin(client, admin_headers):
    body = _create(client, admin_headers, is_shared=True)
    assert body["is_shared"] is True


# ─── PATCH ────────────────────────────────────────────────────────────────────


def test_patch_owner_updates(client, operator_headers):
    view = _create(client, operator_headers)

    r = client.patch(
        f"{_BASE}/{view['id']}",
        json={"name": "改名视图", "sort_order": "asc"},
        headers=operator_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "改名视图"
    assert body["sort_order"] == "asc"
    assert body["scope"] == "mine"  # 未传字段保持不变


def test_patch_filters_validated(client, operator_headers):
    view = _create(client, operator_headers)

    r = client.patch(
        f"{_BASE}/{view['id']}",
        json={"filters": [{"field": "no_such", "op": "eq", "value": "x"}]},
        headers=operator_headers,
    )
    assert r.status_code == 400, r.text


def test_patch_other_users_personal_404(client, operator_headers, admin_headers):
    """改他人个人视图：不可见 → 404（不泄露存在），即便 admin。"""
    view = _create(client, operator_headers)

    r = client.patch(f"{_BASE}/{view['id']}", json={"name": "x"}, headers=admin_headers)
    assert r.status_code == 404, r.text


def test_patch_operator_cannot_touch_shared_view(
    client, admin_headers, operator_headers
):
    view = _create(client, admin_headers, is_shared=True)

    r = client.patch(
        f"{_BASE}/{view['id']}", json={"name": "x"}, headers=operator_headers
    )
    assert r.status_code == 403, r.text


def test_patch_shared_view_by_admin(client, admin_headers, operator_headers):
    view = _create(client, admin_headers, is_shared=True)

    r = client.patch(
        f"{_BASE}/{view['id']}", json={"name": "改共享"}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "改共享"


def test_patch_promote_to_shared_operator_forbidden(client, operator_headers):
    view = _create(client, operator_headers)

    r = client.patch(
        f"{_BASE}/{view['id']}", json={"is_shared": True}, headers=operator_headers
    )
    assert r.status_code == 403, r.text


def test_patch_promote_to_shared_admin(client, admin_headers):
    view = _create(client, admin_headers)

    r = client.patch(
        f"{_BASE}/{view['id']}", json={"is_shared": True}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["is_shared"] is True


def test_patch_unshare_by_owner(client, admin_headers):
    view = _create(client, admin_headers, is_shared=True)

    r = client.patch(
        f"{_BASE}/{view['id']}", json={"is_shared": False}, headers=admin_headers
    )
    assert r.status_code == 200, r.text
    assert r.json()["is_shared"] is False


def test_patch_not_found_404(client, operator_headers):
    r = client.patch(f"{_BASE}/99999", json={"name": "x"}, headers=operator_headers)
    assert r.status_code == 404, r.text


# ─── DELETE ───────────────────────────────────────────────────────────────────


def test_delete_own_view(client, operator_headers):
    view = _create(client, operator_headers)

    r = client.delete(f"{_BASE}/{view['id']}", headers=operator_headers)
    assert r.status_code == 204, r.text

    r2 = client.get(_BASE, headers=operator_headers)
    assert r2.json() == []


def test_delete_other_users_personal_404(client, operator_headers, admin_headers):
    """删他人个人视图：不可见 → 404（不泄露存在），即便 admin。"""
    view = _create(client, operator_headers)

    r = client.delete(f"{_BASE}/{view['id']}", headers=admin_headers)
    assert r.status_code == 404, r.text


def test_delete_shared_view_by_admin(client, admin_headers, operator_headers):
    view = _create(client, admin_headers, is_shared=True)

    r = client.delete(f"{_BASE}/{view['id']}", headers=admin_headers)
    assert r.status_code == 204, r.text


def test_delete_not_found_404(client, operator_headers):
    r = client.delete(f"{_BASE}/99999", headers=operator_headers)
    assert r.status_code == 404, r.text
