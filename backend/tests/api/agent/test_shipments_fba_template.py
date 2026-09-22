"""Agent 货件域 R6：导出 FBA 发货模板（BLF-1178，读路由）。

对齐前端「编辑船期批次 → 导出 FBA 发货模板」的输出结构：
前 2 行 Default prep/labeling owner、第 3 行表头、第 4 行起数据；
US 走英制（in/lb），DE/UK 走公制（cm/kg）。
"""

from __future__ import annotations

import base64
import uuid
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.models.sku_info import SkuRecord
from app.schemas.shipment_schedule import ShipmentScheduleCreate
from app.services import shipment as shipment_service
from app.services.shipment.item import replace_shipment_schedule_items

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(project_id: int, shipment_no: str) -> str:
    return (
        f"/api/v1/agent/projects/{project_id}/shipments/"
        f"{shipment_no}/fba-delivery-template"
    )


def _audit_count() -> int:
    db = SessionLocal()
    try:
        return db.execute(text("select count(*) from operation_audit_logs")).scalar()
    finally:
        db.close()


def _load_workbook(data: dict):
    from openpyxl import load_workbook

    content = base64.b64decode(data["content_base64"])
    assert content[:2] == b"PK", "content_base64 必须是 xlsx（zip）字节"
    return load_workbook(BytesIO(content))


def _seed_de_schedule(project_id: int, project_name: str, shipment_no: str) -> None:
    """建一张 DE 货件 + 1 行明细（D-001×60、箱数 5），并补 DE 站点 SKU 装箱信息。"""
    db = SessionLocal()
    try:
        db.add(
            SkuRecord(
                project_id=project_id,
                project_name=project_name,
                sku="D-001",
                asin="ASIN-D-001",
                country="DE",
                fob_unit_cost=10,
                first_leg_cost_rmb=1,
                package_length_cm=10,
                package_width_cm=10,
                package_height_cm=10,
                weight_kg=0.5,
                carton_length_cm=30,
                carton_width_cm=20,
                carton_height_cm=10,
                carton_weight_kg=8,
                units_per_carton=12,
                currency="EUR",
                sort_order=0,
                is_active=True,
            )
        )
        payload = ShipmentScheduleCreate(
            project_id=project_id,
            country="DE",
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            logistics_unit_price=13.5,
        )
        row = shipment_service.create_shipment_schedule(db, payload, operator="pytest")
        replace_shipment_schedule_items(
            db,
            row,
            [
                {
                    "row_no": 1,
                    "project_name": None,
                    "shipment_no": None,
                    "item_date": None,
                    "sku": "D-001",
                    "quantity": 60,
                    "carton_count": 5,
                    "remark": None,
                }
            ],
            source_type="manual",
        )
        db.commit()
    finally:
        db.close()


def _seed_empty_schedule(project_id: int, shipment_no: str) -> None:
    """建一张没有明细的草稿货件（空模板场景）。"""
    db = SessionLocal()
    try:
        payload = ShipmentScheduleCreate(
            project_id=project_id,
            country="US",
            shipment_no=shipment_no,
            shipping_method="sea",
            shipment_status="draft",
            logistics_unit_price=0,
        )
        shipment_service.create_shipment_schedule(db, payload, operator="pytest")
        db.commit()
    finally:
        db.close()


class TestFbaDeliveryTemplate:
    def test_us_template_imperial(self, client, shipment_env):
        """US 站点：表头 in/lb、尺寸 cm→in、毛重 kg→lb，文件名带「美国站」。"""
        shipment_no = f"SH-T-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)

        resp = client.get(
            _url(shipment_env["project_id"], shipment_no),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        data = body["data"]

        assert data["shipment_no"] == shipment_no
        assert data["project_name"] == shipment_env["project_name"]
        assert data["country"] == "US"
        assert data["unit_system"] == "imperial"
        assert data["sheet_name"] == "Create workflow – template"
        assert data["row_count"] == 2
        assert data["filename"] == (
            f"{shipment_env['project_name']}_美国站-FBA发货模板-{shipment_no}.xlsx"
        )
        assert data["content_type"].endswith("spreadsheetml.sheet")

        worksheet = _load_workbook(data).active
        assert worksheet.title == "Create workflow – template"
        assert worksheet.freeze_panes == "A4"  # 前 3 行冻结

        # 第 1/2 行：亚马逊必需的 Default prep/labeling owner
        assert worksheet["A1"].value == "Default prep owner"
        assert worksheet["B1"].value == "Seller"
        assert worksheet["A2"].value == "Default labeling owner"
        assert worksheet["B2"].value == "Seller"

        # 第 3 行：英制表头
        headers = [worksheet.cell(row=3, column=c).value for c in range(1, 9)]
        assert headers == [
            "Merchant SKU",
            "Quantity",
            "Units per box",
            "Number of boxes",
            "Box length (in)",
            "Box width (in)",
            "Box height (in)",
            "Box weight (lb)",
        ]

        # 第 4 行起数据（20cm→7.87in，5kg→11.02lb）
        rows = {
            worksheet.cell(row=r, column=1).value: [
                worksheet.cell(row=r, column=c).value for c in range(1, 9)
            ]
            for r in range(4, 4 + data["row_count"])
        }
        assert rows["X-001"] == ["X-001", 100, 10, 10, 7.87, 7.87, 7.87, 11.02]
        assert rows["X-002"] == ["X-002", 50, 10, 5, 7.87, 7.87, 7.87, 11.02]

    def test_de_template_metric(self, client, shipment_env):
        """DE 站点：cm/kg 不换算，文件名带「德国站」。"""
        shipment_no = f"SH-D-{uuid.uuid4().hex[:8]}"
        _seed_de_schedule(
            shipment_env["project_id"], shipment_env["project_name"], shipment_no
        )

        resp = client.get(
            _url(shipment_env["project_id"], shipment_no),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["unit_system"] == "metric"
        assert data["filename"] == (
            f"{shipment_env['project_name']}_德国站-FBA发货模板-{shipment_no}.xlsx"
        )

        worksheet = _load_workbook(data).active
        headers = [worksheet.cell(row=3, column=c).value for c in range(1, 9)]
        assert headers[4:] == [
            "Box length (cm)",
            "Box width (cm)",
            "Box height (cm)",
            "Box weight (kg)",
        ]
        assert [
            worksheet.cell(row=4, column=c).value for c in range(1, 9)
        ] == ["D-001", 60, 12, 5, 30, 20, 10, 8]

    def test_empty_items_header_only(self, client, shipment_env):
        """无明细货件仍导出空模板（与前端按钮口径一致）。"""
        shipment_no = f"SH-E-{uuid.uuid4().hex[:8]}"
        _seed_empty_schedule(shipment_env["project_id"], shipment_no)

        resp = client.get(
            _url(shipment_env["project_id"], shipment_no),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["row_count"] == 0

        worksheet = _load_workbook(data).active
        assert worksheet["A3"].value == "Merchant SKU"
        assert worksheet.cell(row=4, column=1).value is None

    def test_read_no_audit(self, client, shipment_env):
        """读路由不落审计（对齐 shipments 域既有约定）。"""
        shipment_no = f"SH-A-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        before = _audit_count()

        resp = client.get(
            _url(shipment_env["project_id"], shipment_no),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert _audit_count() == before

    def test_unknown_shipment_404_shell(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env["project_id"], "SH-NOPE"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_business_scope_out_of_scope(self, client, shipment_env, make_api_key):
        """没有 shipments 域的凭据 → 403。"""
        key = make_api_key(
            agent_id=shipment_env["agent_id"],
            business_scope="sales",
        )
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": shipment_env["agent_id"],
        }
        resp = client.get(
            _url(shipment_env["project_id"], "SH-X"),
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
