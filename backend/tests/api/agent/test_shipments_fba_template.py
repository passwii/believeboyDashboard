"""Agent 货件 R6：导出 FBA 发货模板。"""

from __future__ import annotations

import base64
import uuid
from io import BytesIO

import pytest
from conftest import seed_schedule
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ShipmentScheduleItem
from app.models.sku_info import SkuRecord
from app.schemas.shipment_schedule import ShipmentScheduleCreate
from app.services import shipment as shipment_service
from app.services.shipment.item import replace_shipment_schedule_items


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
        return int(
            db.execute(text("select count(*) from operation_audit_logs")).scalar()
        )
    finally:
        db.close()


def _load_workbook(data: dict):
    from openpyxl import load_workbook

    content = base64.b64decode(data["content_base64"])
    assert content[:2] == b"PK"
    return load_workbook(BytesIO(content))


def _seed_custom_schedule(
    project_id: int,
    shipment_no: str,
    *,
    country: str,
    sku: str,
    quantity: int,
    carton_count: int,
    add_sku: bool = True,
    add_item: bool = True,
) -> None:
    db = SessionLocal()
    try:
        project = db.get(Project, project_id)
        if add_sku:
            db.add(
                SkuRecord(
                    project_id=project_id,
                    project_name=project.project_name,
                    sku=sku,
                    asin=f"ASIN-{sku}",
                    country=country,
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
                    currency="EUR" if country == "DE" else "USD",
                    sort_order=0,
                    is_active=True,
                )
            )
            db.flush()

        row = shipment_service.create_shipment_schedule(
            db,
            ShipmentScheduleCreate(
                project_id=project_id,
                country=country,
                shipment_no=shipment_no,
                shipping_method="sea",
                shipment_status="draft",
                logistics_unit_price=0,
            ),
            operator="pytest",
        )
        if add_item:
            if add_sku:
                replace_shipment_schedule_items(
                    db,
                    row,
                    [
                        {
                            "row_no": 1,
                            "project_name": None,
                            "shipment_no": None,
                            "item_date": None,
                            "sku": sku,
                            "quantity": quantity,
                            "carton_count": carton_count,
                            "remark": None,
                        }
                    ],
                    source_type="manual",
                )
            else:
                db.add(
                    ShipmentScheduleItem(
                        shipment_schedule_id=row.id,
                        project_id=project_id,
                        shipment_no=shipment_no,
                        sku=sku,
                        quantity=quantity,
                        carton_count=carton_count,
                        source_type="manual",
                    )
                )
        db.commit()
    finally:
        db.close()


def test_us_template_returns_imperial_xlsx_and_persisted_carton_counts(
    client, shipment_env
):
    shipment_no = f"SH-FBA-US-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["shipment_no"] == shipment_no
    assert data["country"] == "US"
    assert data["unit_system"] == "imperial"
    assert data["row_count"] == 2
    assert data["content_type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert data["filename"].endswith(f"-FBA发货模板-{shipment_no}.xlsx")

    worksheet = _load_workbook(data).active
    assert worksheet.title == "Create workflow – template"
    assert worksheet.freeze_panes == "A4"
    assert worksheet.sheet_view.showGridLines is False
    assert [worksheet.cell(row=1, column=column).value for column in range(1, 3)] == [
        "Default prep owner",
        "Seller",
    ]
    assert [worksheet.cell(row=2, column=column).value for column in range(1, 3)] == [
        "Default labeling owner",
        "Seller",
    ]
    assert [worksheet.cell(row=3, column=column).value for column in range(1, 9)] == [
        "Merchant SKU",
        "Quantity",
        "Units per box",
        "Number of boxes",
        "Box length (in)",
        "Box width (in)",
        "Box height (in)",
        "Box weight (lb)",
    ]
    rows = {
        worksheet.cell(row=row, column=1).value: [
            worksheet.cell(row=row, column=column).value for column in range(1, 9)
        ]
        for row in range(4, 6)
    }
    assert rows["X-001"] == ["X-001", 100, 10, 10, 7.87, 7.87, 7.87, 11.02]
    assert rows["X-002"] == ["X-002", 50, 10, 5, 7.87, 7.87, 7.87, 11.02]


def test_de_template_uses_metric_units(client, shipment_env):
    shipment_no = f"SH-FBA-DE-{uuid.uuid4().hex[:8]}"
    _seed_custom_schedule(
        shipment_env["project_id"],
        shipment_no,
        country="DE",
        sku="D-001",
        quantity=60,
        carton_count=5,
    )

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["unit_system"] == "metric"
    assert data["filename"].endswith(f"德国站-FBA发货模板-{shipment_no}.xlsx")
    worksheet = _load_workbook(data).active
    assert [worksheet.cell(row=3, column=column).value for column in range(5, 9)] == [
        "Box length (cm)",
        "Box width (cm)",
        "Box height (cm)",
        "Box weight (kg)",
    ]
    assert [worksheet.cell(row=4, column=column).value for column in range(1, 9)] == [
        "D-001",
        60,
        12,
        5,
        30,
        20,
        10,
        8,
    ]


def test_uk_template_uses_metric_units(client, shipment_env):
    shipment_no = f"SH-FBA-UK-{uuid.uuid4().hex[:8]}"
    _seed_custom_schedule(
        shipment_env["project_id"],
        shipment_no,
        country="UK",
        sku="U-001",
        quantity=36,
        carton_count=3,
    )

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["unit_system"] == "metric"
    worksheet = _load_workbook(data).active
    assert [worksheet.cell(row=3, column=column).value for column in range(5, 9)] == [
        "Box length (cm)",
        "Box width (cm)",
        "Box height (cm)",
        "Box weight (kg)",
    ]


def test_empty_shipment_returns_header_only_template(client, shipment_env):
    shipment_no = f"SH-FBA-EMPTY-{uuid.uuid4().hex[:8]}"
    _seed_custom_schedule(
        shipment_env["project_id"],
        shipment_no,
        country="US",
        sku="UNUSED",
        quantity=1,
        carton_count=1,
        add_sku=False,
        add_item=False,
    )
    db = SessionLocal()
    try:
        db.execute(
            text(
                "delete from shipment_schedule_items where shipment_no = :shipment_no"
            ),
            {"shipment_no": shipment_no},
        )
        db.commit()
    finally:
        db.close()

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["row_count"] == 0
    worksheet = _load_workbook(data).active
    assert worksheet["A3"].value == "Merchant SKU"
    assert worksheet["A4"].value is None


def test_missing_sku_data_leaves_optional_cells_blank(client, shipment_env):
    shipment_no = f"SH-FBA-MISSING-{uuid.uuid4().hex[:8]}"
    _seed_custom_schedule(
        shipment_env["project_id"],
        shipment_no,
        country="US",
        sku="MISSING-SKU",
        quantity=24,
        carton_count=2,
        add_sku=False,
    )

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    worksheet = _load_workbook(response.json()["data"]).active
    assert [worksheet.cell(row=4, column=column).value for column in range(1, 9)] == [
        "MISSING-SKU",
        24,
        None,
        2,
        None,
        None,
        None,
        None,
    ]


def test_template_read_does_not_add_audit(client, shipment_env):
    shipment_no = f"SH-FBA-AUDIT-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)
    before = _audit_count()

    response = client.get(
        _url(shipment_env["project_id"], shipment_no),
        headers=shipment_env["headers"],
    )

    assert response.status_code == 200, response.text
    assert _audit_count() == before


def test_unknown_or_cross_project_shipment_returns_resource_not_found(
    client, shipment_env
):
    unknown = client.get(
        _url(shipment_env["project_id"], "SH-FBA-NOPE"),
        headers=shipment_env["headers"],
    )
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    shipment_no = f"SH-FBA-CROSS-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)
    cross_project = client.get(
        _url(99999999, shipment_no),
        headers=shipment_env["headers"],
    )
    assert cross_project.status_code == 404
    assert cross_project.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_template_requires_shipments_business_scope(client, shipment_env, make_api_key):
    agent_id = shipment_env["agent_id"]
    key = make_api_key(agent_id=agent_id, business_scope="sales")
    headers = {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }
    response = client.get(
        _url(shipment_env["project_id"], "SH-FBA-SCOPE"),
        headers=headers,
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
