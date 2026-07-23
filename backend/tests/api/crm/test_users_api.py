"""用户端点集成测试 — crm-user-select 数据源（活跃 user_accounts）。"""
from __future__ import annotations


def test_list_users_includes_seeded_accounts(client, admin_headers, test_admin):
    r = client.get("/api/v1/crm/users", headers=admin_headers)
    assert r.status_code == 200, r.text
    users = r.json()
    assert isinstance(users, list) and len(users) >= 1
    ids = {u["id"] for u in users}
    assert str(test_admin["id"]) in ids
    # 字段齐全
    sample = next(u for u in users if u["id"] == str(test_admin["id"]))
    assert sample["name"]
    assert sample["email"]
    assert sample["is_active"] is True


def test_get_user_by_id_and_404(client, admin_headers, test_admin):
    r = client.get(f"/api/v1/crm/users/{test_admin['id']}", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["id"] == str(test_admin["id"])

    missing = client.get("/api/v1/crm/users/00000000-0000-0000-0000-000000000000", headers=admin_headers)
    assert missing.status_code == 404


def test_users_require_auth(client):
    assert client.get("/api/v1/crm/users").status_code in (401, 403)
