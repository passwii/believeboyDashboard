"""审计日志端点集成测试（P4）：写操作留痕 + 查询 + 权限墙。

鉴权复用根 conftest 的 admin_headers / operator_headers（含 X-API-Key + X-User-Id UUID）。
"""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.fixture(autouse=True)
def _clean(db_session):
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_audit_logs, crm_follows, crm_opportunities, crm_contacts, crm_leads, crm_customers restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield


def test_create_customer_writes_audit(client, admin_headers):
    cid = client.post(
        "/api/v1/crm/customers", json={"name": "客户A"}, headers=admin_headers
    ).json()["id"]
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid},
        headers=admin_headers,
    ).json()
    assert logs["total"] == 1 and logs["items"][0]["action"] == "create"


def test_update_customer_writes_change_summary(client, admin_headers):
    cid = client.post(
        "/api/v1/crm/customers",
        json={"name": "客户A", "rating": "B"},
        headers=admin_headers,
    ).json()["id"]
    client.patch(
        f"/api/v1/crm/customers/{cid}", json={"rating": "A"}, headers=admin_headers
    )
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": cid, "action": "update"},
        headers=admin_headers,
    ).json()
    assert logs["total"] == 1
    assert (
        "等级" in logs["items"][0]["summary"] and "B→A" in logs["items"][0]["summary"]
    )


def test_batch_transfer_writes_audit_per_id(client, admin_headers):
    c1 = client.post(
        "/api/v1/crm/customers", json={"name": "C1"}, headers=admin_headers
    ).json()["id"]
    c2 = client.post(
        "/api/v1/crm/customers", json={"name": "C2"}, headers=admin_headers
    ).json()["id"]
    admin_id = admin_headers["X-User-Id"]
    resp = client.post(
        "/api/v1/crm/customers/batch-transfer",
        json={"ids": [c1, c2], "to_owner_id": admin_id},
        headers=admin_headers,
    )
    assert resp.status_code == 204
    logs = client.get(
        "/api/v1/crm/audit-logs", params={"action": "transfer"}, headers=admin_headers
    ).json()
    assert logs["total"] == 2


def test_audit_logs_requires_admin(client, operator_headers):
    resp = client.get("/api/v1/crm/audit-logs", headers=operator_headers)
    assert resp.status_code == 403
