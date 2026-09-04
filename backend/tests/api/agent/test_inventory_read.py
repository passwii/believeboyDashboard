"""Agent 库存信息读路由测试（BLF-478：R1 inventory + sku 过滤 + 读不落审计）。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from app.db.session import SessionLocal
from app.main import app
from app.models import OperationAuditLog
from conftest import seed_inventory_snapshot
from fastapi.testclient import TestClient
from sqlalchemy import func, select


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_redis_cache(monkeypatch):
    """R1 的 Redis 缓存替换成直查——测试不依赖本地 Redis，也不串缓存。"""
    from app.api.v1.endpoints.agent import inventory as inv_module

    monkeypatch.setattr(
        inv_module, "get_inventory_analysis_cache", lambda *a, **k: None
    )
    monkeypatch.setattr(
        inv_module, "set_inventory_analysis_cache", lambda *a, **k: None
    )


def _today() -> date:
    return date.today() - timedelta(days=1)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/inventory{suffix}"


def _seed_basic(env) -> None:
    """R1 基座：X-001 有货 10（0-90）+ X-002 缺货 0（365+ 超龄）。"""
    seed_inventory_snapshot(
        env["project_id"],
        rows=[
            {
                "sku": "X-001",
                "asin": "ASIN-X-001",
                "available_qty": 10,
                "age_0_90_qty": 10,
                "recommended_action": "Replenish",
                "stock_status": "in_stock",
                "aging_status": "fresh",
            },
            {
                "sku": "X-002",
                "asin": "ASIN-X-002",
                "available_qty": 0,
                "age_365_plus_qty": 5,
                "recommended_action": "Liquidate",
                "stock_status": "out_of_stock",
                "aging_status": "over_aged",
            },
        ],
    )


class TestR1Inventory:
    def test_full_inventory(self, client, shipment_env):
        _seed_basic(shipment_env)
        resp = client.get(_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]

        assert data["project_id"] == shipment_env["project_id"]
        assert data["country"] == "US"
        assert data["report_date"] == _today().isoformat()

        summary = data["summary"]
        assert summary["sku_count"] == 2
        assert summary["out_of_stock_count"] == 1
        assert summary["over_aged_sku_count"] == 1
        assert summary["total_available_qty"] == 10
        assert summary["total_age_0_90_qty"] == 10
        assert summary["total_age_365_plus_qty"] == 5
        assert summary["action_type_count"] == 2
        assert data["action_options"] == ["Liquidate", "Replenish"]

        items = data["items"]
        assert [i["sku"] for i in items] == ["X-001", "X-002"]
        row = next(i for i in items if i["sku"] == "X-001")
        assert row["available_qty"] == 10
        assert row["product_name"] is None  # shipment_env 的 SkuRecord 无品名
        assert row["stock_status"] == "in_stock"
        assert row["aging_status"] == "fresh"

    def test_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/999999/inventory",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_business_scope_out_of_scope(self, client, shipment_env, make_api_key):
        key = make_api_key(
            agent_id=shipment_env["agent_id"],
            business_scope="shipments",
        )
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": shipment_env["agent_id"],
        }
        _seed_basic(shipment_env)
        resp = client.get(_url(shipment_env), headers=headers)
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_unauthenticated_401(self, client):
        resp = client.get("/api/v1/agent/projects/1/inventory")
        assert resp.status_code == 401, resp.text


class TestR1SkuFilter:
    def test_single_sku(self, client, shipment_env):
        _seed_basic(shipment_env)
        resp = client.get(
            _url(shipment_env), params={"sku": "X-001"}, headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]

        assert data["summary"]["sku_count"] == 1
        assert data["summary"]["out_of_stock_count"] == 0
        assert data["summary"]["total_available_qty"] == 10
        assert data["summary"]["action_type_count"] == 1
        assert [i["sku"] for i in data["items"]] == ["X-001"]

    def test_substring_case_insensitive(self, client, shipment_env):
        _seed_basic(shipment_env)
        resp = client.get(
            _url(shipment_env), params={"sku": "x-00"}, headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        assert [i["sku"] for i in resp.json()["data"]["items"]] == ["X-001", "X-002"]

    def test_no_match_returns_empty_items(self, client, shipment_env):
        _seed_basic(shipment_env)
        resp = client.get(
            _url(shipment_env), params={"sku": "NOPE"}, headers=shipment_env["headers"]
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["items"] == []
        assert data["summary"]["sku_count"] == 0
        assert data["summary"]["total_available_qty"] == 0


class TestR1ReportDate:
    def test_historical_snapshot(self, client, shipment_env):
        """两张快照（前天/昨天）：report_date=前天 → 命中旧快照。"""
        old = _today() - timedelta(days=1)
        seed_inventory_snapshot(
            shipment_env["project_id"],
            report_date=old,
            rows=[
                {
                    "sku": "X-001",
                    "asin": "ASIN-X-001",
                    "available_qty": 3,
                    "age_0_90_qty": 3,
                    "recommended_action": "Replenish",
                    "stock_status": "in_stock",
                    "aging_status": "fresh",
                },
            ],
        )
        seed_inventory_snapshot(
            shipment_env["project_id"],
            report_date=_today(),
            rows=[
                {
                    "sku": "X-001",
                    "asin": "ASIN-X-001",
                    "available_qty": 10,
                    "age_0_90_qty": 10,
                    "recommended_action": "Replenish",
                    "stock_status": "in_stock",
                    "aging_status": "fresh",
                },
                {
                    "sku": "X-002",
                    "asin": "ASIN-X-002",
                    "available_qty": 0,
                    "age_365_plus_qty": 5,
                    "recommended_action": "Liquidate",
                    "stock_status": "out_of_stock",
                    "aging_status": "over_aged",
                },
            ],
        )
        resp = client.get(
            _url(shipment_env),
            params={"report_date": old.isoformat()},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["report_date"] == old.isoformat()
        # 服务语义：base SKU 恒出现，快照缺失的 SKU 以 0 补齐
        assert data["summary"]["sku_count"] == 2
        assert data["summary"]["total_available_qty"] == 3
        old_row = next(i for i in data["items"] if i["sku"] == "X-001")
        assert old_row["available_qty"] == 3

    def test_bad_report_date_validation(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env),
            params={"report_date": "not-a-date"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestReadNoAudit:
    def test_read_does_not_write_audit(self, client, shipment_env):
        _seed_basic(shipment_env)
        resp = client.get(_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text

        db = SessionLocal()
        try:
            count = db.execute(
                select(func.count())
                .select_from(OperationAuditLog)
                .where(OperationAuditLog.agent_id == shipment_env["agent_id"])
            ).scalar()
            assert count == 0, "纯读路由不落审计"
        finally:
            db.close()
