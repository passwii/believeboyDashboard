"""Agent 补货分析读路由测试（BLF-502：R1 决策清单 / R2 单 SKU 深挖 + 读不落审计）。"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest
from app.db.session import SessionLocal
from app.main import app
from app.models import OperationAuditLog
from app.services.inventory.replenishment import (
    list_inventory_replenishment_analysis,
)
from conftest import (
    seed_inventory_snapshot,
    seed_replenishment_sku,
    seed_sales_order_rows,
)
from fastapi.testclient import TestClient
from sqlalchemy import func, select


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _no_redis_cache(monkeypatch):
    """R1 的 Redis 缓存替换成直查——测试不依赖本地 Redis，也不串缓存。"""
    from app.api.v1.endpoints.agent import replenishment_analysis as rp_module

    monkeypatch.setattr(
        rp_module, "get_inventory_replenishment_cache", lambda *a, **k: None
    )
    monkeypatch.setattr(
        rp_module, "set_inventory_replenishment_cache", lambda *a, **k: None
    )


def _today() -> date:
    return date.today() - timedelta(days=1)


def _url(env, suffix: str = "") -> str:
    return f"/api/v1/agent/projects/{env['project_id']}/replenishment-analysis{suffix}"


def _seed_three_skus(env) -> None:
    """三段式基座：X-001 critical/shortage→REPLENISH_NOW；X-002 watch→NO_ACTION；
    X-003 unknown（无销量）→NO_ACTION。"""
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


class TestR1List:
    def test_service_rows_are_json_native(self, shipment_env):
        """service 行必须自洽可 JSON 序列化（复审[3]）。

        insight adapter 会把补货行原样塞进 canonical slot，而 ``json_safe``
        遇非 JSON 原生类型即抛（既定 tripwire）。``signals`` 若是 pydantic
        模型，库存健康 run 会在提交期直接 TypeError——这正是复审抓到的
        ``TypeError: value of type InventorySignals is not JSON-native``。
        HTTP 层的 ``_to_json_safe_rows`` 会掩盖它，所以这里直接问 service。
        """
        _seed_three_skus(shipment_env)
        db = SessionLocal()
        try:
            rows, _summary, _total, _has_next = list_inventory_replenishment_analysis(
                db,
                project_id=shipment_env["project_id"],
                country="US",
                keyword=None,
                risk_status=None,
                in_transit_only=False,
                order_by="sellable_days",
                order_dir="asc",
                page=1,
                page_size=200,
            )
        finally:
            db.close()

        assert rows, "种子数据应产出补货行"
        x001 = next(r for r in rows if r["sku"] == "X-001")
        assert isinstance(x001["signals"], dict)
        json.dumps(rows, ensure_ascii=False)  # 非 JSON 原生 → TypeError

    def test_full_list_with_detail_full(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env),
            params={"detail": "full"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]

        assert data["page"] == 1
        assert data["total"] == 3
        assert data["has_next"] is False
        summary = data["summary"]
        assert summary["sku_count"] == 3
        assert summary["critical_count"] == 1
        assert summary["watch_count"] == 1
        assert summary["unknown_count"] == 1
        assert summary["state_distribution"]["critical"] == 1
        assert summary["action_distribution"]["REPLENISH_NOW"] == 1
        assert summary["state_action_matrix"]["critical"]["REPLENISH_NOW"] == 1

        items = data["items"]
        x001 = next(i for i in items if i["sku"] == "X-001")
        # D4：DoH<14 → REPLENISH_NOW（修复后真实产出）
        assert x001["inventory_state"] == "critical"
        assert x001["replenishment_action"] == "REPLENISH_NOW"
        # G1：decision_path 解释性字段
        assert x001["decision_path"]["state_rule"] == "P1"
        assert x001["decision_path"]["critical_subtype"] == "shortage"
        # BLF-630 二轮：order_buffer<0（DoH≈8 天 < L=45）→ buffer-negative-urgent 优先于 shortage 分支
        assert x001["decision_path"]["action_rule"] == "buffer-negative-urgent"
        # signals 全量
        assert x001["signals"]["dms_30"] == pytest.approx(1.0)
        assert x001["signals"]["data_freshness_days"] == 1  # G4 真实值

        x002 = next(i for i in items if i["sku"] == "X-002")
        assert x002["inventory_state"] == "watch"
        assert x002["replenishment_action"] == "NO_ACTION"

        x003 = next(i for i in items if i["sku"] == "X-003")
        assert x003["inventory_state"] == "unknown"

    def test_default_detail_summary_is_light(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(_url(shipment_env), headers=shipment_env["headers"])
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        assert items, "应有 items"
        x001 = next(i for i in items if i["sku"] == "X-001")
        # D2 瘦身：核心决策字段在，heavy 字段不在
        assert x001["inventory_state"] == "critical"
        assert x001["sellable_days"] is not None
        assert "signals" not in x001
        assert "decision_path" not in x001
        assert "dms_30" not in x001

    def test_filter_inventory_state_multi(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env),
            params={"inventory_state": "critical,unknown"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 2
        assert sorted(i["sku"] for i in data["items"]) == ["X-001", "X-003"]

    def test_filter_replenishment_action(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env),
            params={"replenishment_action": "REPLENISH_NOW"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert [i["sku"] for i in data["items"]] == ["X-001"]

    def test_order_by_sellable_days_asc(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env),
            params={"order_by": "sellable_days", "order_dir": "asc"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        items = resp.json()["data"]["items"]
        skus = [i["sku"] for i in items]
        assert skus[0] == "X-001"  # DoH=10 最小

    def test_invalid_inventory_state_400(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env),
            params={"inventory_state": "bogus"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_invalid_action_400(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env),
            params={"replenishment_action": "FLY_NOW"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_invalid_order_by_400(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env),
            params={"order_by": "secret_field"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_invalid_detail_400(self, client, shipment_env):
        resp = client.get(
            _url(shipment_env),
            params={"detail": "huge"},
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_project_404(self, client, shipment_env):
        resp = client.get(
            "/api/v1/agent/projects/999999/replenishment-analysis",
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
        resp = client.get(_url(shipment_env), headers=headers)
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_unauthenticated_401(self, client):
        resp = client.get("/api/v1/agent/projects/1/replenishment-analysis")
        assert resp.status_code == 401, resp.text


class TestR2Sku:
    def test_sku_detail_full(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env, "/skus/X-001"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        row = resp.json()["data"]
        assert row["sku"] == "X-001"
        assert row["inventory_state"] == "critical"
        assert row["replenishment_action"] == "REPLENISH_NOW"
        assert row["decision_path"]["state_rule"] == "P1"
        assert row["signals"]["dms_30"] == pytest.approx(1.0)
        assert row["project_id"] == shipment_env["project_id"]

    def test_sku_not_found_returns_null_200(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env, "/skus/NOPE"),
            headers=shipment_env["headers"],
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"] is None


class TestReadNoAudit:
    def test_read_does_not_write_audit(self, client, shipment_env):
        _seed_three_skus(shipment_env)
        resp = client.get(
            _url(shipment_env),
            params={"detail": "full"},
            headers=shipment_env["headers"],
        )
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
