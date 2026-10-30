"""Agent 货件审计路由（spec S7：读该货件的审计行）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models.operation_audit_log import OperationAuditLog
from app.services.audit_log_service import append_operation_audit_log

from conftest import seed_schedule

pytestmark = pytest.mark.audit_table_isolation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_audit_route_returns_rows_for_shipment(client, shipment_env):
    shipment_no = f"SH-A-{uuid.uuid4().hex[:8]}"
    schedule_id = seed_schedule(shipment_env["project_id"], shipment_no)

    # 直接注入两行该货件的审计（真实写审计由 Task 5+ 的写路由测试覆盖）
    db = SessionLocal()
    try:
        for action in ("shipment.create", "shipment.update"):
            append_operation_audit_log(
                db,
                action=action,
                target_type="shipment_schedule",
                target_id=schedule_id,
                agent_id=shipment_env["agent_id"],
                idempotency_key=f"idem-{uuid.uuid4().hex[:8]}",
                after={"shipment_no": shipment_no},
            )
        db.commit()
    finally:
        db.close()

    try:
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/audit",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["shipment_no"] == shipment_no
        actions = [item["action"] for item in data["items"]]
        assert "shipment.create" in actions and "shipment.update" in actions
        first = data["items"][0]
        assert first["agent_id"] == shipment_env["agent_id"]
        assert first["idempotency_key"]
        assert first["id"] == max(item["id"] for item in data["items"])  # 倒序
    finally:
        db = SessionLocal()
        try:
            db.query(OperationAuditLog).filter_by(
                agent_id=shipment_env["agent_id"]
            ).delete()
            db.commit()
        finally:
            db.close()


def test_audit_route_unknown_shipment_404(client, shipment_env):
    resp = client.get(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/SH-NOPE/audit",
        headers=shipment_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
