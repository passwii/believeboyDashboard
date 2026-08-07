"""Agent 补货分析 R3 总览 / R4 覆盖度测试（BLF-502）。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from app.main import app
from conftest import (
    seed_inventory_snapshot,
    seed_replenishment_sku,
    seed_sales_order_rows,
)
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _today() -> date:
    return date.today() - timedelta(days=1)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/replenishment-analysis{suffix}"


def _seed_three_skus(env) -> None:
    """与 test_replenishment_read 同基座：X-001 critical / X-002 watch / X-003 unknown。"""
    seed_inventory_snapshot(
        env["project_id"],
        rows=[
            {
                "sku": "X-001",
                "asin": "ASIN-X-001",
                "available_qty": 10,
                "age_0_90_qty": 10,
            },
            {
                "sku": "X-002",
                "asin": "ASIN-X-002",
                "available_qty": 150,
                "age_0_90_qty": 150,
            },
            {"sku": "X-003", "asin": "ASIN-X-003", "available_qty": 0},
        ],
    )
    seed_replenishment_sku(env["project_id"], "X-003")
    seed_sales_order_rows(
        env["project_id"],
        sku_daily_qty={"X-001": 1, "X-002": 1},
    )


class TestR3Summary:
    def test_summary_distributions(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env, "/summary"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["project_id"] == shipment_env["project_id"]
        assert data["country"] == "US"
        assert data["as_of_date"] == date.today().isoformat()

        summary = data["summary"]
        assert summary["sku_count"] == 3
        assert summary["state_distribution"] == {
            "critical": 1,
            "deteriorating": 0,
            "watch": 1,
            "healthy": 0,
            "unknown": 1,
        }
        assert summary["action_distribution"] == {
            "REPLENISH_NOW": 1,
            "REPLENISH_NORMAL": 0,
            "HOLD": 0,
            "REDUCE_PRICE": 0,
            "REMOVE": 0,
            "NO_ACTION": 2,
        }
        assert summary["state_action_matrix"]["critical"]["REPLENISH_NOW"] == 1
        assert summary["state_action_matrix"]["watch"]["NO_ACTION"] == 1
        assert summary["state_action_matrix"]["unknown"]["NO_ACTION"] == 1

    def test_summary_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/999999/replenishment-analysis/summary",
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 404, resp.text


class TestR4Coverage:
    def test_coverage_full(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env, "/coverage"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]

        snap = data["inventory_snapshot"]
        assert snap["report_date"] == _today().isoformat()
        assert snap["freshness_days"] == 1
        assert snap["is_current"] is True
        assert snap["available_options_count"] == 1

        sales = data["sales_data"]
        assert sales["max_sales_date"] == date.today().isoformat()

        base = data["base_skus"]
        assert base["total_count"] == 3
        assert base["configured_count"] == 0

        # G7：1/3 unknown
        assert data["unknown_rate"] == pytest.approx(round(1 / 3, 4))

    def test_coverage_no_snapshot(self, client, shipment_env):
        # 只有销量、无库存快照 → report_date None
        seed_sales_order_rows(shipment_env["project_id"], sku_daily_qty={"X-001": 1})
        resp = client.get(
            _url(shipment_env, "/coverage"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        snap = resp.json()["data"]["inventory_snapshot"]
        assert snap["report_date"] is None
        assert snap["freshness_days"] is None
