"""Agent 货件读路由（spec S1 + E6 完整版 + 读不落审计）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _audit_count() -> int:
    db = SessionLocal()
    try:
        return db.execute(text("select count(*) from operation_audit_logs")).scalar()
    finally:
        db.close()


class TestShipmentReads:
    def test_list_ok_and_no_audit(self, client, shipment_env):
        shipment_no = f"SH-R-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        before = _audit_count()

        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        nos = [item["shipment_no"] for item in body["data"]["items"]]
        assert shipment_no in nos
        assert _audit_count() == before  # 读不落审计

    def test_list_filters_by_status(self, client, shipment_env):
        shipment_no = f"SH-F-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments",
            params={"shipment_status": "draft", "shipment_no": shipment_no},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200
        items = resp.json()["data"]["items"]
        assert len(items) == 1 and items[0]["shipment_no"] == shipment_no

    def test_detail_ok(self, client, shipment_env):
        shipment_no = f"SH-D-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["shipment_no"] == shipment_no
        assert data["sku_count"] == 2
        assert data["total_quantity"] == 150
        assert {item["sku"] for item in data["items"]} == {"X-001", "X-002"}

    def test_sku_summary_ok(self, client, shipment_env):
        shipment_no = f"SH-S-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/sku-summary",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert {item["sku"] for item in items} == {"X-001", "X-002"}

    def test_fba_box_detail_ok(self, client, shipment_env):
        shipment_no = f"SH-B-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}/fba-box-detail",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert shipment_no in data["shipment_nos"]
        assert len(data["items"]) > 0

    def test_unknown_project_404_shell(self, client, shipment_env):
        """spec E6 完整版。"""
        resp = client.get(
            "/api/v1/agent/projects/99999999/shipments",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_unknown_shipment_404_shell(self, client, shipment_env):
        resp = client.get(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/SH-NOPE",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_shipment_of_other_project_404(self, client, shipment_env):
        """跨项目越权读取 = 资源不存在（不泄漏存在性）。"""
        shipment_no = f"SH-X-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = client.get(
            f"/api/v1/agent/projects/99999999/shipments/{shipment_no}",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
