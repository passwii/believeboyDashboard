"""Agent 新品测算读路由测试（BLF-451 spec §10：R1/R2 + 读不落审计 + 跨项目 404）。"""

from __future__ import annotations

import uuid
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.db.session import SessionLocal
from app.main import app
from app.models.new_product_calculation import NewProductCalculation
from app.services.audit_log_service import query_operation_audit_log_for_targets

from conftest import seed_new_product_calculation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(env, suffix: str = "") -> str:
    return (
        f"/api/v1/agent/projects/{env['project_id']}/new-product-calculations{suffix}"
    )


def _export_url(env, ids: list[int]) -> str:
    query = "&".join(f"snapshot_ids={snapshot_id}" for snapshot_id in ids)
    return _url(env, f"/export.xlsx?{query}")


class TestR1List:
    def test_list_snapshots(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=10.0,
        )
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-002",
            sale_price_usd=20.0,
        )

        resp = client.get(_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 2
        by_sku = {item["sku"]: item for item in data["items"]}
        assert by_sku["X-001"]["sale_price_usd"] == 10.0
        assert by_sku["X-002"]["sale_price_usd"] == 20.0
        assert "dimensions" in by_sku["X-001"] and "profit" in by_sku["X-001"]
        assert by_sku["X-001"]["source"] == "agent_listing_pull"

    def test_calculation_type_filter(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            calculation_type="profit_calc",
        )
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            calculation_type="profit_reverse",
        )

        resp = client.get(
            _url(shipment_env) + "?calculation_type=profit_reverse",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert data["items"][0]["calculation_type"] == "profit_reverse"

    def test_country_filter(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            country="US",
        )
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-002",
            country="DE",
        )

        resp = client.get(
            _url(shipment_env) + "?country=DE", headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert data["items"][0]["country"] == "DE"

    def test_pagination(self, client, shipment_env):
        for sku in ("X-001", "X-002"):
            seed_new_product_calculation(
                shipment_env["project_id"], shipment_env["project_name"], sku=sku
            )
        resp = client.get(
            _url(shipment_env) + "?page=1&page_size=1", headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 2
        assert len(data["items"]) == 1

    def test_read_does_not_write_audit(self, client, shipment_env):
        row_ids = [
            seed_new_product_calculation(
                shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
            ),
            seed_new_product_calculation(
                shipment_env["project_id"], shipment_env["project_name"], sku="X-002"
            ),
        ]
        client.get(_url(shipment_env), headers=shipment_env["headers"])

        db = SessionLocal()
        try:
            rows = query_operation_audit_log_for_targets(
                db, target_type="new_product_calculation", target_ids=row_ids
            )
            assert rows == [], "读路由不落审计"
        finally:
            db.close()

    def test_missing_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/99999999/new-product-calculations",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestR2SkuDetail:
    def test_detail_default_profit_calc(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            calculation_type="profit_calc",
            sale_price_usd=12.5,
        )
        resp = client.get(
            _url(shipment_env, "/skus/X-001"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["sku"] == "X-001"
        assert data["calculation_type"] == "profit_calc"
        assert data["sale_price_usd"] == 12.5

    def test_detail_explicit_calculation_type(self, client, shipment_env):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            calculation_type="profit_reverse",
            sale_price_usd=13.0,
        )
        resp = client.get(
            _url(shipment_env, "/skus/X-001?calculation_type=profit_reverse"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["calculation_type"] == "profit_reverse"

    def test_unknown_sku_404(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env, "/skus/X-999"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_cross_project_404(self, client, shipment_env):
        """其他项目下的同名 SKU 不可见 → 404 壳（project 过滤由 service 保证）。"""
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=12.5,
        )
        resp = client.get(
            "/api/v1/agent/projects/99999998/new-product-calculations/skus/X-001",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestExportComparison:
    def test_export_returns_binary_xlsx_in_requested_order(
        self, client, shipment_env
    ):
        first = seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
        )
        second = seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-002",
        )

        resp = client.get(
            _export_url(shipment_env, [second, first]),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        assert "filename" in resp.headers["content-disposition"]
        assert int(resp.headers["content-length"]) == len(resp.content)

        sheet = load_workbook(BytesIO(resp.content), data_only=True).active
        assert sheet.cell(1, 3).value.endswith("X-002")
        assert sheet.cell(1, 4).value.endswith("X-001")

        db = SessionLocal()
        try:
            audits = query_operation_audit_log_for_targets(
                db,
                target_type="new_product_calculation",
                target_ids=[shipment_env["project_id"]],
            )
            export_audits = [
                row
                for row in audits
                if row.action == "new_product_calculation.export"
            ]
            assert len(export_audits) == 1
            assert export_audits[0].after_json["snapshot_ids"] == [second, first]
            assert export_audits[0].after_json["row_count"] == 2
        finally:
            db.close()

    @pytest.mark.parametrize(
        "query",
        [
            "",
            "snapshot_ids=1&snapshot_ids=1",
            "snapshot_ids=0",
            "&".join(f"snapshot_ids={index}" for index in range(1, 14)),
        ],
    )
    def test_export_rejects_invalid_ids(self, client, shipment_env, query):
        suffix = f"?{query}" if query else ""
        resp = client.get(
            _url(shipment_env, f"/export.xlsx{suffix}"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_export_rejects_missing_snapshot(self, client, shipment_env):
        resp = client.get(
            _export_url(shipment_env, [999999999]),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert resp.json()["error"]["details"]["missing_snapshot_ids"] == [999999999]

    def test_export_rejects_snapshot_of_other_project(self, client, shipment_env):
        other_project_id = shipment_env["project_id"] + 100000
        other_id = seed_new_product_calculation(
            other_project_id, "other-project", sku="X-OTHER"
        )
        try:
            resp = client.get(
                _export_url(shipment_env, [other_id]),
                headers=shipment_env["headers"],
            )
            assert resp.status_code == 400, resp.text
            assert resp.json()["error"]["details"]["missing_snapshot_ids"] == [other_id]
        finally:
            db = SessionLocal()
            try:
                db.query(NewProductCalculation).filter(
                    NewProductCalculation.id == other_id
                ).delete()
                db.commit()
            finally:
                db.close()


class TestBusinessScope:
    """BLF-526 上线收尾：business_scope 门禁挂载后，域外 key → 403 壳。"""

    def test_scope_allows_new_product_calculations(self, client, make_api_key):
        """business_scope 含 new_product_calculations → 放行（进入项目校验）。"""
        agent_id = "npc-scope-allow"
        key = make_api_key(agent_id=agent_id, business_scope="new_product_calculations")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = client.get(
            "/api/v1/agent/projects/99999999/new-product-calculations?page_size=1",
            headers=headers,
        )
        # project 99999999 不存在 → 404 RESOURCE_NOT_FOUND（说明过了域校验）
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_scope_denies_other_domain(self, client, make_api_key):
        """business_scope 不含 new_product_calculations → 403 AGENT_BUSINESS_OUT_OF_SCOPE。"""
        agent_id = "npc-scope-deny"
        key = make_api_key(agent_id=agent_id, business_scope="shipments")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }
        resp = client.get(
            "/api/v1/agent/projects/99999999/new-product-calculations?page_size=1",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"
