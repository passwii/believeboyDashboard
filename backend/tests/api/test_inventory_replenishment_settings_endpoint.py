"""补货分析设置写端点（web 路径）缓存失效测试（BLF-633）。

BLF-633 根因：``PUT /api/v1/inventory-replenishment-settings/{project_id}/{sku}``
落库后从未调用 ``invalidate_inventory_replenishment_cache``，导致 GET analysis
最长 5 分钟命中旧 Redis 缓存。本文件锁定：设置写成功提交后必须以项目 id
调用失效函数；失败路径（无权限）不调用。

策略：monkeypatch service / 审计 / 项目访问，spy 失效函数，绕过 DB 与 Redis。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture
def auth_headers():
    from app.core.config import get_settings

    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "tester",
        "X-Is-Admin": "true",
    }


@pytest.fixture
def endpoint_module():
    from app.api.v1.endpoints import inventory_replenishment as mod

    return mod


def _fake_row():
    """upsert 返回行（SimpleNamespace 替代 DB 模型，字段对齐 endpoint 用法）。"""
    return SimpleNamespace(
        id=1,
        project_id=18,
        project_name="P18",
        sku="X-001",
        country="US",
        asin="ASIN001",
        production_lead_days=30,
        shipping_days=35,
        safety_factor=0.25,
        target_days=45,
    )


def _patch_deps(monkeypatch, endpoint_module):
    """放行访问控制 + 假 upsert + 假审计，返回 invalidate spy。

    BLF-667 起失效由装饰器经 _INVALIDATE_FNS 调用，因此 spy 挂在登记表上。
    """
    from app.services.infra import cache_decorator as cd

    monkeypatch.setattr(
        endpoint_module.project_service,
        "ensure_project_access",
        lambda *a, **k: None,
    )
    monkeypatch.setattr(
        endpoint_module,
        "upsert_inventory_replenishment_setting",
        lambda *a, **k: _fake_row(),
    )
    monkeypatch.setattr(
        endpoint_module,
        "append_operation_audit_log",
        lambda *a, **k: None,
    )
    calls: list[int] = []
    monkeypatch.setitem(
        cd._INVALIDATE_FNS,
        "inventory_replenishment",
        lambda project_id=None, **kw: calls.append(project_id),
    )
    return calls


class TestUpdateInventoryReplenishmentSetting:
    def test_upsert_success_invalidates_cache(
        self, monkeypatch, client, auth_headers, endpoint_module
    ):
        calls = _patch_deps(monkeypatch, endpoint_module)
        resp = client.put(
            "/api/v1/inventory-replenishment-settings/18/X-001",
            json={
                "asin": "ASIN001",
                "production_lead_days": 30,
                "shipping_days": 35,
                "safety_factor": 0.25,
            },
            headers=auth_headers,
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["sku"] == "X-001"
        assert body["production_lead_days"] == 30
        # 核心断言：提交后必须以 project_id 失效缓存
        assert calls == [18]

    def test_access_denied_does_not_invalidate(
        self, monkeypatch, client, auth_headers, endpoint_module
    ):
        from app.services.infra import cache_decorator as cd

        def deny(*a, **k):
            raise HTTPException(status_code=403, detail="无权访问该项目")

        monkeypatch.setattr(
            endpoint_module.project_service, "ensure_project_access", deny
        )
        calls: list[int] = []
        monkeypatch.setitem(
            cd._INVALIDATE_FNS,
            "inventory_replenishment",
            lambda project_id=None, **kw: calls.append(project_id),
        )
        resp = client.put(
            "/api/v1/inventory-replenishment-settings/18/X-001",
            json={
                "asin": "ASIN001",
                "production_lead_days": 30,
                "shipping_days": 35,
                "safety_factor": 0.25,
            },
            headers=auth_headers,
        )
        assert resp.status_code == 403
        assert calls == [], "访问被拒时不应失效缓存"

    def test_unauthenticated_401(self, client):
        resp = client.put(
            "/api/v1/inventory-replenishment-settings/18/X-001",
            json={
                "asin": "ASIN001",
                "production_lead_days": 30,
                "shipping_days": 35,
                "safety_factor": 0.25,
            },
        )
        assert resp.status_code == 401, resp.text
