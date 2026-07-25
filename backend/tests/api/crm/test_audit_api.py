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


def test_convert_lead_creates_customer_and_contact_audit_logs(client, admin_headers):
    """P5-2: convert_lead 端点应补 customer create + contact create 留痕。

    调用 POST /api/v1/crm/leads/{id}/convert 后，crm_audit_logs 应至少含 3 条：
    1. lead convert (entity_type=lead, action=convert)
    2. customer create (entity_type=customer, action=create)
    3. contact create (entity_type=contact, action=create)
    """
    # 建线索
    lead_resp = client.post(
        "/api/v1/crm/leads",
        json={"name": "张三", "phone": "13800000000", "company": "Acme"},
        headers=admin_headers,
    )
    assert lead_resp.status_code == 201, lead_resp.text
    lead_id = lead_resp.json()["id"]

    # 转化
    conv = client.post(
        f"/api/v1/crm/leads/{lead_id}/convert",
        json={"name": "Acme 客户"},
        headers=admin_headers,
    )
    assert conv.status_code == 200, conv.text
    customer_id = conv.json()["customer"]["id"]

    # 1) lead convert 留痕
    lead_logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "lead", "entity_id": lead_id, "action": "convert"},
        headers=admin_headers,
    ).json()
    assert lead_logs["total"] == 1, "应有 1 条 lead convert 留痕"

    # 2) customer create 留痕（之前 P4 漏掉这一条）
    cust_logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "customer", "entity_id": customer_id, "action": "create"},
        headers=admin_headers,
    ).json()
    assert cust_logs["total"] == 1, "应有 1 条 customer create 留痕（起点）"
    assert cust_logs["items"][0]["actor_id"] == admin_headers["X-User-Id"]
    assert cust_logs["items"][0]["summary"] == "新建客户" or cust_logs["items"][0]["summary"] is None

    # 3) contact create 留痕（端点查 primary contact id 后追加）
    contact_logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "contact", "action": "create"},
        headers=admin_headers,
    ).json()
    assert contact_logs["total"] >= 1, "应有 contact create 留痕"
    # 验证 contact 的 customer_id 与新建客户一致
    from sqlalchemy import text as _text
    from app.db.session import SessionLocal
    s = SessionLocal()
    try:
        row = s.execute(
            _text("select id from crm_contacts where customer_id = :cid and is_primary = true"),
            {"cid": customer_id},
        ).first()
    finally:
        s.close()
    assert row is not None, "新客户应有主联系人"
    contact_id = row[0]
    # 二次精确查该 contact 的 create 留痕
    single = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "contact", "entity_id": contact_id, "action": "create"},
        headers=admin_headers,
    ).json()
    assert single["total"] == 1, "新主联系人应有 1 条 create 留痕"
