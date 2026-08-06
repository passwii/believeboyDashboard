"""Agent 新品测算读路由测试（BLF-451 spec §10：R1/R2 + 读不落审计 + 跨项目 404）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log_for_targets

from conftest import seed_new_product_calculation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(env, suffix: str = "") -> str:
    return (
        f"/api/v1/agent/projects/{env['project_id']}/new-product-calculations{suffix}"
    )


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
