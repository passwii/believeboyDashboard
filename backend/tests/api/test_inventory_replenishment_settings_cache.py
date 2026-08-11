"""BLF-633: 补货分析设置写路径 Redis 缓存失效测试（web 路径）。

根因：PUT /inventory-replenishment-settings/{project_id}/{sku} 落库后从未失效
补货分析缓存，GET /inventory-replenishment-analysis 最长 5 分钟返回旧值。

策略：用 dict-backed 缓存替身模拟 Redis，锁定契约：
- PUT 设置后缓存被清空，且失效按 project_id 调用；
- 预热旧缓存 → PUT → 再次 GET 立即返回新值（无需等 TTL）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture
def auth_headers():
    """protected dependency 需要的 X-API-Key + admin。"""
    from app.core.config import get_settings

    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "tester",
        "X-Is-Admin": "true",
    }


class _FakeCache:
    """dict 缓存替身：模拟 get/set/失效语义（不依赖本地 Redis）。"""

    def __init__(self):
        self.store: dict[str, object] = {}
        self.invalidate_calls: list[int | None] = []

    def get(self, *args, **kwargs):
        return self.store.get("analysis")

    def set(self, *args, **kwargs):
        self.store["analysis"] = args[-1]

    def invalidate(self, project_id=None, *args, **kwargs):
        self.invalidate_calls.append(project_id)
        self.store.clear()


@pytest.fixture
def fake_cache(monkeypatch):
    """替换 endpoint 模块里的缓存函数为 dict 替身，并放行访问/审计。"""
    from app.api.v1.endpoints import inventory_replenishment as rp_module

    cache = _FakeCache()
    monkeypatch.setattr(rp_module, "get_inventory_replenishment_cache", cache.get)
    monkeypatch.setattr(rp_module, "set_inventory_replenishment_cache", cache.set)
    monkeypatch.setattr(
        rp_module, "invalidate_inventory_replenishment_cache", cache.invalidate
    )
    monkeypatch.setattr(
        rp_module.project_service, "ensure_project_access", lambda *a, **k: None
    )
    monkeypatch.setattr(rp_module, "append_operation_audit_log", lambda *a, **k: None)
    monkeypatch.setattr(rp_module, "append_operation_view_log", lambda *a, **k: None)
    return cache


def _patch_upsert(monkeypatch, project_id: int, sku: str = "SKU-A"):
    from app.api.v1.endpoints import inventory_replenishment as rp_module

    def fake_upsert(db, **kwargs):
        return SimpleNamespace(
            id=1,
            project_id=project_id,
            project_name="P1",
            sku=sku,
            country="US",
            asin="ASIN001",
            production_lead_days=40,
            shipping_days=45,
            safety_factor=0.25,
        )

    monkeypatch.setattr(
        rp_module, "upsert_inventory_replenishment_setting", fake_upsert
    )


_PUT_URL = "/api/v1/inventory-replenishment-settings/1/SKU-A"

_SETTING_BODY = {
    "asin": "ASIN001",
    "production_lead_days": 40,
    "shipping_days": 45,
    "safety_factor": 0.25,
}

_ANALYSIS_URL = "/api/v1/inventory-replenishment-analysis"


def _analysis_payload(risk_status: str) -> tuple:
    row = {
        "project_id": 1,
        "project_name": "P1",
        "sku": "SKU-A",
        "country": "US",
        "asin": "ASIN001",
        "available_inventory": 100,
        "in_transit_quantity": 50,
        "safety_factor": 0.25,
        "weighted_dms": 9.6,
        "sellable_days": 10.4,
        "production_lead_days": 20,
        "shipping_days": 25,
        "estimated_replenishment_quantity": 432,
        "risk_status": risk_status,
    }
    summary = {
        "sku_count": 1,
        "out_of_stock_risk_count": 0,
        "healthy_count": 1,
        "slow_moving_count": 0,
        "pending_data_count": 0,
        "total_available_inventory": 100,
        "total_in_transit_quantity": 50,
    }
    return [row], summary, 1, False


class TestSettingsWriteInvalidatesCache:
    def test_put_setting_clears_analysis_cache(
        self, client, auth_headers, fake_cache, monkeypatch
    ):
        _patch_upsert(monkeypatch, project_id=1)
        # 预热：模拟一次已缓存的旧分析结果
        fake_cache.store["analysis"] = {"stale": True}

        resp = client.put(_PUT_URL, json=_SETTING_BODY, headers=auth_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["production_lead_days"] == 40

        # 缓存被清空，且失效按 project_id 调用
        assert fake_cache.store == {}
        assert fake_cache.invalidate_calls == [1]

    def test_get_analysis_returns_fresh_value_after_put(
        self, client, auth_headers, fake_cache, monkeypatch
    ):
        from app.api.v1.endpoints import inventory_replenishment as rp_module

        _patch_upsert(monkeypatch, project_id=1)
        current = {"risk_status": "健康库存"}

        monkeypatch.setattr(
            rp_module,
            "list_inventory_replenishment_analysis",
            lambda *a, **k: _analysis_payload(current["risk_status"]),
        )

        # 第一次 GET：走计算并写入缓存
        resp1 = client.get(
            _ANALYSIS_URL, params={"project_id": 1}, headers=auth_headers
        )
        assert resp1.status_code == 200, resp1.text
        assert resp1.json()["items"][0]["risk_status"] == "健康库存"
        assert fake_cache.store != {}, "首次 GET 应回填缓存"

        # 保存设置 → 缓存失效
        resp_put = client.put(_PUT_URL, json=_SETTING_BODY, headers=auth_headers)
        assert resp_put.status_code == 200
        assert fake_cache.store == {}, "PUT 后缓存应被清空"

        # 第二次 GET：重新计算，立即返回新值（无需等 5 分钟 TTL）
        current["risk_status"] = "断货风险"
        resp2 = client.get(
            _ANALYSIS_URL, params={"project_id": 1}, headers=auth_headers
        )
        assert resp2.status_code == 200, resp2.text
        assert resp2.json()["items"][0]["risk_status"] == "断货风险"
