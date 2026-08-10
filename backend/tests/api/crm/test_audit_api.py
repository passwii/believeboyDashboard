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
                "truncate crm_audit_logs, crm_follows, crm_contacts, crm_leads, crm_customers restart identity cascade"
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
        params={
            "entity_type": "customer",
            "entity_id": customer_id,
            "action": "create",
        },
        headers=admin_headers,
    ).json()
    assert cust_logs["total"] == 1, "应有 1 条 customer create 留痕（起点）"
    assert cust_logs["items"][0]["actor_id"] == admin_headers["X-User-Id"]
    assert (
        cust_logs["items"][0]["summary"] == "新建客户"
        or cust_logs["items"][0]["summary"] is None
    )

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
            _text(
                "select id from crm_contacts where customer_id = :cid and is_primary = true"
            ),
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


def test_create_customer_audit_failure_rolls_back_business(
    client, admin_headers, monkeypatch
):
    """P5-6a 强一致：审计写入失败时，业务写入应整体回滚（不能只落客户、漏审计）。

    模拟 record_log 抛错。旧实现（service 内部已 commit）→ 客户已落库 → 本测试红；
    强一致改造后（service flush + 端点统一 commit）→ 提交前抛错 → 整体回滚 → 客户不落库。
    """
    from app.services.crm import audit_service

    def _boom(*args, **kwargs):
        raise RuntimeError("audit boom")

    monkeypatch.setattr(audit_service, "record_log", _boom)

    with pytest.raises(RuntimeError, match="audit boom"):
        client.post(
            "/api/v1/crm/customers", json={"name": "回滚客户"}, headers=admin_headers
        )

    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        n = s.execute(
            text("select count(*) from crm_customers where name = '回滚客户'")
        ).scalar_one()
    finally:
        s.close()
    assert n == 0, "审计失败时客户不应落库（业务+审计原子回滚）"


def test_update_customer_audit_failure_rolls_back_business(
    client, admin_headers, monkeypatch
):
    """P5-6a 强一致：update 端点审计失败时，字段变更应回滚（rating 不被改掉）。"""
    cid = client.post(
        "/api/v1/crm/customers",
        json={"name": "客户A", "rating": "B"},
        headers=admin_headers,
    ).json()["id"]

    from app.services.crm import audit_service

    def _boom(*args, **kwargs):
        raise RuntimeError("audit boom")

    monkeypatch.setattr(audit_service, "record_log", _boom)

    with pytest.raises(RuntimeError, match="audit boom"):
        client.patch(
            f"/api/v1/crm/customers/{cid}", json={"rating": "A"}, headers=admin_headers
        )

    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        rating = s.execute(
            text("select rating from crm_customers where id = :cid"), {"cid": cid}
        ).scalar_one()
    finally:
        s.close()
    assert rating == "B", "审计失败时 rating 变更应回滚（仍为 B）"


def test_convert_lead_audit_failure_rolls_back_business(
    client, admin_headers, monkeypatch
):
    """P5-6a 强一致：convert_lead 审计失败时，整个转化（客户+联系人+线索标记）应回滚。

    convert_lead 是最复杂路径（1 次业务 flush 含 customer/contact/跟进搬迁/线索标记
    + 3 条审计）。任一审计失败 → 端点不 commit → 整体回滚 → 客户不落库、线索未转化。
    """
    lead_id = client.post(
        "/api/v1/crm/leads",
        json={"name": "张三", "phone": "13800000000", "company": "Acme"},
        headers=admin_headers,
    ).json()["id"]

    from app.services.crm import audit_service

    def _boom(*args, **kwargs):
        raise RuntimeError("audit boom")

    monkeypatch.setattr(audit_service, "record_log", _boom)

    with pytest.raises(RuntimeError, match="audit boom"):
        client.post(
            f"/api/v1/crm/leads/{lead_id}/convert",
            json={"name": "Acme 客户"},
            headers=admin_headers,
        )

    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        cust_n = s.execute(
            text("select count(*) from crm_customers where name = 'Acme 客户'")
        ).scalar_one()
        lead_status = s.execute(
            text("select status from crm_leads where id = :lid"), {"lid": lead_id}
        ).scalar_one()
    finally:
        s.close()
    assert cust_n == 0, "审计失败时转化出的客户不应落库"
    assert lead_status != "converted", "审计失败时线索不应被标记为已转化"


def test_list_audit_logs_filter_by_entity_types_and_ids(
    client, admin_headers, db_session
):
    """P5-9: list_audit_logs 支持 entity_types + entity_ids 组合过滤。
    客户抽屉「操作记录」tab 需要同时拉取 customer + 该客户下所有 contact 的审计。
    """
    from app.db.session import SessionLocal
    from app.services.crm.audit_service import record_log

    # 建 1 个 customer 审计 + 2 个 contact 审计
    record_log(
        db_session,
        entity_type="customer",
        entity_id=100,
        action="create",
        actor_id=None,
    )
    record_log(
        db_session, entity_type="contact", entity_id=201, action="create", actor_id=None
    )
    record_log(
        db_session, entity_type="contact", entity_id=202, action="update", actor_id=None
    )
    record_log(
        db_session, entity_type="lead", entity_id=999, action="create", actor_id=None
    )
    db_session.commit()

    # 通过端点查询：customer(100) + contact(201, 202)
    resp = client.get(
        "/api/v1/crm/audit-logs",
        params={
            "entity_types": ["customer", "contact"],
            "entity_ids": [100, 201, 202],
            "page_size": 50,
        },
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    types = sorted({item["entity_type"] for item in data["items"]})
    ids = sorted({item["entity_id"] for item in data["items"]})
    # 应包含 customer(100) + 2 个 contact(201, 202)，不含 lead(999)
    assert "lead" not in types
    assert set(ids) == {100, 201, 202}, f"应只含 100/201/202, 实际 {ids}"
    assert data["total"] == 3
