"""Agent XLSX export for Dashboard-equivalent FBA box details."""

from __future__ import annotations

import uuid
from io import BytesIO
from urllib.parse import unquote

import pytest
from app.api.v1.lazy_router import preload_all_lazy_groups
from app.db.session import SessionLocal
from app.main import app
from app.models.sku_info import SkuRecord
from app.services.shipment import fba_box_export as export_service
from conftest import seed_schedule
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import select

XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(project_id: int) -> str:
    return f"/api/v1/agent/projects/{project_id}/shipments/fba-box-details.xlsx"


def _request(client, project_id: int, headers: dict, *shipment_nos: str):
    return client.get(
        _url(project_id),
        params=[("shipment_no", number) for number in shipment_nos],
        headers=headers,
    )


def _load(response):
    assert response.headers["content-type"] == XLSX_CONTENT_TYPE
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.content[:2] == b"PK"
    return load_workbook(BytesIO(response.content))


def _filename(response) -> str:
    value = response.headers["content-disposition"]
    return unquote(value.split("filename*=UTF-8''", 1)[1].split(";", 1)[0])


def test_openapi_declares_binary_and_query_bounds():
    preload_all_lazy_groups()
    operation = app.openapi()["paths"][
        "/api/v1/agent/projects/{project_id}/shipments/fba-box-details.xlsx"
    ]["get"]
    assert operation["responses"]["200"]["content"][XLSX_CONTENT_TYPE]["schema"] == {
        "type": "string",
        "format": "binary",
    }
    params = {param["name"]: param for param in operation["parameters"]}
    assert params["shipment_no"]["required"] is True
    assert params["shipment_no"]["schema"]["maxItems"] == 100


def test_export_matches_dashboard_columns_values_totals_merges_and_labels(client, shipment_env):
    shipment_no = f"SH-BOX-XLSX-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)

    response = _request(client, shipment_env["project_id"], shipment_env["headers"], shipment_no)

    assert response.status_code == 200, response.text
    assert _filename(response).startswith(shipment_env["project_name"])
    assert shipment_no in _filename(response)
    worksheet = _load(response).active
    assert worksheet.title == "FBA箱单明细"
    assert worksheet.freeze_panes == "A2"
    assert worksheet.sheet_view.showGridLines is False
    assert [worksheet.cell(1, column).value for column in range(1, 19)] == [
        "货件编号", "追踪 ID", "仓库 ID", "SKU", "品名", "产品图片", "ASIN", "FNSKU",
        "外箱长(cm)", "外箱宽(cm)", "外箱高(cm)", "外箱重量(kg)", "装箱率", "总箱数",
        "标签号段", "总数量", "总体积(m³)", "总重量(kg)",
    ]
    assert worksheet.cell(2, 1).value == shipment_no
    assert worksheet.cell(2, 4).value == "X-001"
    assert worksheet.cell(2, 9).value == "20"
    assert worksheet.cell(2, 12).value == "5"
    assert worksheet.cell(2, 13).value == "10 / 箱"
    assert worksheet.cell(2, 14).value == 10
    assert worksheet.cell(2, 15).value == f"{shipment_no}U000001-010"
    assert worksheet.cell(2, 16).value == 100
    assert worksheet.cell(3, 4).value == "X-002"
    assert worksheet.cell(3, 15).value == f"{shipment_no}U000011-015"
    assert worksheet.cell(4, 1).value == "合计"
    assert worksheet.cell(4, 14).value == 15
    assert worksheet.cell(4, 16).value == 150
    assert worksheet.cell(4, 17).value == pytest.approx(0.12)
    assert worksheet.cell(4, 18).value == pytest.approx(75)
    assert "A2:A3" in {str(area) for area in worksheet.merged_cells.ranges}
    assert "B2:B3" in {str(area) for area in worksheet.merged_cells.ranges}
    assert "C2:C3" in {str(area) for area in worksheet.merged_cells.ranges}


def test_multi_shipment_export_filters_only_requested_rows(client, shipment_env):
    first = f"SH-BOX-A-{uuid.uuid4().hex[:8]}"
    second = f"SH-BOX-B-{uuid.uuid4().hex[:8]}"
    not_requested = f"SH-BOX-C-{uuid.uuid4().hex[:8]}"
    for shipment_no in (first, second, not_requested):
        seed_schedule(shipment_env["project_id"], shipment_no)

    response = _request(
        client, shipment_env["project_id"], shipment_env["headers"], first, second
    )

    assert response.status_code == 200, response.text
    worksheet = _load(response).active
    exported = {
        worksheet.cell(row, 1).value
        for row in range(2, worksheet.max_row)
        if worksheet.cell(row, 1).value is not None
    }
    assert exported == {first, second}
    assert not_requested not in exported
    assert worksheet.cell(worksheet.max_row, 16).value == 300


def test_image_success_embeds_image_and_failure_does_not_break_export(
    client, shipment_env, monkeypatch
):
    shipment_no = f"SH-BOX-IMAGE-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)
    db = SessionLocal()
    try:
        product = db.scalars(
            select(SkuRecord).where(
                SkuRecord.project_id == shipment_env["project_id"],
                SkuRecord.sku == "X-001",
            )
        ).first()
        product.product_image_r2_url = "https://images.test/product.png"
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(export_service, "_allowed_image_origins", lambda: {("https", "images.test", None)})
    monkeypatch.setattr(export_service, "_fetch_product_image", lambda _url: b"not-an-image")
    response = _request(client, shipment_env["project_id"], shipment_env["headers"], shipment_no)
    assert response.status_code == 200, response.text
    assert len(_load(response).active._images) == 0

    from PIL import Image
    image = BytesIO()
    Image.new("RGB", (2, 2), color="red").save(image, format="PNG")
    monkeypatch.setattr(export_service, "_fetch_product_image", lambda _url: image.getvalue())
    response = _request(client, shipment_env["project_id"], shipment_env["headers"], shipment_no)
    assert response.status_code == 200, response.text
    assert len(_load(response).active._images) == 1


def test_project_scope_and_unknown_or_cross_project_shipment_are_not_found(
    client, shipment_env, make_api_key
):
    shipment_no = f"SH-BOX-SCOPE-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], shipment_no)

    key = make_api_key(
        agent_id=shipment_env["agent_id"],
        business_scope="shipments",
        project_scope="99999999",
    )
    scoped_headers = {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": shipment_env["agent_id"],
    }
    forbidden = _request(client, shipment_env["project_id"], scoped_headers, shipment_no)
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    unknown = _request(client, shipment_env["project_id"], shipment_env["headers"], "SH-BOX-NOPE")
    assert unknown.status_code == 404
    assert unknown.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    cross = _request(client, 99999999, shipment_env["headers"], shipment_no)
    assert cross.status_code == 404
    assert cross.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_query_required_limit_and_empty_result_errors(client, shipment_env):
    missing = client.get(_url(shipment_env["project_id"]), headers=shipment_env["headers"])
    assert missing.status_code == 400
    assert missing.json()["error"]["code"] == "VALIDATION_FAILED"

    too_many = _request(
        client,
        shipment_env["project_id"],
        shipment_env["headers"],
        *(f"SH-{index:03}" for index in range(101)),
    )
    assert too_many.status_code == 400
    assert too_many.json()["error"]["code"] == "VALIDATION_FAILED"

    empty_shipment = f"SH-BOX-EMPTY-{uuid.uuid4().hex[:8]}"
    seed_schedule(shipment_env["project_id"], empty_shipment)
    db = SessionLocal()
    try:
        from app.models.shipment_schedule import ShipmentScheduleItem
        db.query(ShipmentScheduleItem).filter(
            ShipmentScheduleItem.shipment_no == empty_shipment
        ).delete(synchronize_session=False)
        db.commit()
    finally:
        db.close()

    empty = _request(
        client, shipment_env["project_id"], shipment_env["headers"], empty_shipment
    )
    assert empty.status_code == 404
    assert empty.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
