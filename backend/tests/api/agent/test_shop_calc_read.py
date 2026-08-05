"""Agent 店铺测算读路由测试（BLF-442 spec §7：R1/R2/R3 + 读不落审计 + 跨项目 404）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log_for_targets

from conftest import seed_shop_calculation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/shop-calculations{suffix}"


class TestR1List:
    def test_list_current_state_per_sku(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=10.0,
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=12.0,
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-002",
            sale_price_usd=20.0,
        )

        resp = client.get(_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 2, "当前态每 SKU 一行（X-001 两版取最新）"
        by_sku = {item["sku"]: item for item in data["items"]}
        assert by_sku["X-001"]["sale_price_usd"] == 12.0
        assert by_sku["X-002"]["sale_price_usd"] == 20.0
        assert "dimensions" in by_sku["X-001"] and "profit" in by_sku["X-001"]

    def test_country_filter(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            country="US",
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            country="DE",
        )

        resp = client.get(
            _url(shipment_env) + "?country=DE", headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert data["items"][0]["country"] == "DE"

    def test_read_does_not_write_audit(self, client, shipment_env):
        row_ids = [
            seed_shop_calculation(
                shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
            ),
            seed_shop_calculation(
                shipment_env["project_id"], shipment_env["project_name"], sku="X-002"
            ),
        ]
        client.get(_url(shipment_env), headers=shipment_env["headers"])

        db = SessionLocal()
        try:
            rows = query_operation_audit_log_for_targets(
                db, target_type="shop_calculation", target_ids=row_ids
            )
            assert rows == [], "读路由不落审计"
        finally:
            db.close()

    def test_missing_project_404(self, client, shipment_env):
        resp = client.get(
            f"/api/v1/agent/projects/99999999/shop-calculations",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestR2SkuDetail:
    def test_detail_with_country(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=12.5,
        )
        resp = client.get(
            _url(shipment_env, "/skus/X-001?country=US"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["sku"] == "X-001"
        assert data["country"] == "US"
        assert data["sale_price_usd"] == 12.5

    def test_sole_country_returns_directly(self, client, shipment_env):
        """country 缺省 + 仅一个国家存在 → 直接返回（agent 最顺滑路径）。"""
        seed_shop_calculation(
            shipment_env["project_id"], shipment_env["project_name"], sku="X-001"
        )
        resp = client.get(
            _url(shipment_env, "/skus/X-001"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["country"] == "US"

    def test_multiple_countries_ambiguous(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            country="US",
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            country="DE",
        )

        resp = client.get(
            _url(shipment_env, "/skus/X-001"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SHOP_CALCULATION_AMBIGUOUS_COUNTRY"
        countries = {d["country"] for d in err["details"]}
        assert countries == {"US", "DE"}

        # 带 country 消歧后正常返回
        ok = client.get(
            _url(shipment_env, "/skus/X-001?country=DE"),
            headers=shipment_env["headers"],
        )
        assert ok.status_code == 200
        assert ok.json()["data"]["country"] == "DE"

    def test_unknown_sku_404(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env, "/skus/X-999"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestR3History:
    def test_history_versions_desc_with_pagination(self, client, shipment_env):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=10.0,
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=11.0,
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=12.0,
        )

        resp = client.get(
            _url(shipment_env, "/skus/X-001/history"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 3
        assert [item["sale_price_usd"] for item in data["items"]] == [12.0, 11.0, 10.0]

        # limit/offset 薄壳
        paged = client.get(
            _url(shipment_env, "/skus/X-001/history?limit=2&offset=1"),
            headers=shipment_env["headers"],
        )
        assert paged.status_code == 200
        pdata = paged.json()["data"]
        assert pdata["total"] == 3, "total = 未分页前条数"
        assert [item["sale_price_usd"] for item in pdata["items"]] == [11.0, 10.0]

    def test_from_to_filter(self, client, shipment_env):
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=10.0,
            observed_at=now - timedelta(days=3),
        )
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=12.0,
            observed_at=now - timedelta(days=1),
        )
        from_iso = (now - timedelta(days=2)).date().isoformat()
        to_iso = now.date().isoformat()
        resp = client.get(
            _url(shipment_env, f"/skus/X-001/history?from={from_iso}&to={to_iso}"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1, "from/to 按 observed_at 区间过滤（含边界）"
        assert data["items"][0]["sale_price_usd"] == 12.0

    def test_history_missing_sku_returns_empty(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env, "/skus/X-999/history"), headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["items"] == [] and data["total"] == 0
