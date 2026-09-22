"""Agent 店铺测算读路由测试（BLF-442 spec §7：R1/R2/R3 + 读不落审计 + 跨项目 404）。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log_for_targets
from conftest import seed_shop_calculation
from fastapi.testclient import TestClient
from openpyxl import load_workbook


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/shop-calculations{suffix}"


def _read_export(content: bytes) -> list[dict[str, object]]:
    workbook = load_workbook(BytesIO(content), data_only=True)
    rows = list(workbook.active.iter_rows(values_only=True))
    header_index = next(index for index, row in enumerate(rows) if row[0] == "SKU")
    headers = [str(value) for value in rows[header_index]]
    return [
        dict(zip(headers, row, strict=False))
        for row in rows[header_index + 1 :]
        if any(value is not None for value in row)
    ]


def _agent_headers(key: dict) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": key["agent_id"],
    }


class TestExport:
    def test_export_current_returns_xlsx_all_skus_and_audits(
        self, client, shipment_env
    ):
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

        response = client.get(
            _url(shipment_env, "/export.xlsx?country=US"),
            headers=shipment_env["headers"],
        )
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        assert "filename" in response.headers["content-disposition"]
        rows = _read_export(response.content)
        by_sku = {row["SKU"]: row for row in rows}
        assert set(by_sku) == {"X-001", "X-002"}
        assert by_sku["X-001"]["售价(USD)"] == 12.0
        assert by_sku["X-002"]["warnings"] == "未核算/缺数据"

        db = SessionLocal()
        try:
            audits = query_operation_audit_log_for_targets(
                db,
                target_type="shop_calculation",
                target_ids=[shipment_env["project_id"]],
            )
            assert any(audit.action == "shop_calculation.export" for audit in audits)
        finally:
            db.close()

    def test_export_supports_history_sku_as_of(self, client, shipment_env):
        now = datetime.now(timezone.utc)
        for price, observed_at in (
            (10.0, now - timedelta(days=2)),
            (11.0, now - timedelta(days=1)),
            (12.0, now),
        ):
            seed_shop_calculation(
                shipment_env["project_id"],
                shipment_env["project_name"],
                sku="X-001",
                sale_price_usd=price,
                observed_at=observed_at,
            )

        response = client.get(
            _url(
                shipment_env,
                "/export.xlsx?country=US&sku=X-001&mode=history"
                f"&as_of={(now - timedelta(hours=12)).isoformat().replace('+00:00', 'Z')}",
            ),
            headers=shipment_env["headers"],
        )
        assert response.status_code == 200, response.text
        assert [row["售价(USD)"] for row in _read_export(response.content)] == [
            11.0,
            10.0,
        ]

    def test_export_requires_shop_calculation_business_scope(
        self, client, shipment_env, make_api_key
    ):
        key = make_api_key(
            agent_id="no-export-domain",
            project_scope="*",
            business_scope="shipments",
        )
        response = client.get(
            _url(shipment_env, "/export.xlsx"), headers=_agent_headers(key)
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


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
            "/api/v1/agent/projects/99999999/shop-calculations",
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
