"""External API 退役契约测试（BLF-459 V3 下线 + BLF-583 机制全删）。

覆盖：
* ``external_mirror`` 机制已退役删除：模块 import 失败、agent 命名空间无
  ``agent-external-mirror`` 路由（BLF-583）。
* V3 下线契约：/external/* 全路径 410 Gone + Link successor + Deprecation 头。
* 老路径 → agent 新路径同后缀映射。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# 1. BLF-583：external_mirror 机制已退役删除
# ---------------------------------------------------------------------------


def test_external_mirror_module_deleted():
    """BLF-583：external_mirror.py 已删除，import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.agent.external_mirror  # noqa: F401


def test_no_agent_external_mirror_routes(client):
    """agent 命名空间无任何镜像路由残留（tags=agent-external-mirror）。"""
    from app.api.v1.endpoints.agent import agent_router

    mirror_routes = [
        r
        for r in agent_router.routes
        if getattr(r, "tags", None) and "agent-external-mirror" in (r.tags or [])
    ]
    assert mirror_routes == [], f"agent 仍有镜像路由: {[r.path for r in mirror_routes]}"


def test_external_endpoint_package_deleted():
    """BLF-583：endpoints/external/ 包已整体删除，import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external  # noqa: F401


# ---------------------------------------------------------------------------
# 2. V3 下线契约 —— /external/* 全路径 410 Gone + Link successor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "/api/v1/external/projects",
        "/api/v1/external/projects/1/ad-campaigns?period=7d&country=US",
        "/api/v1/external/projects/1/inventory-ledger/months",
        "/api/v1/external/projects/99999999/sku-info",
        "/api/v1/external/projects/1/new-product-calculations",
    ],
)
def test_external_all_gone_410(client, url):
    """V3：旧命名空间全部 410 Gone + Link 指向 /agent/* 对应路径。"""
    resp = client.get(url)
    assert resp.status_code == 410, f"{url}: got {resp.status_code}"
    body = resp.json()
    assert "下线" in body["detail"]
    successor = body["successor"]
    assert successor.startswith("/api/v1/agent")
    link = resp.headers.get("Link") or ""
    assert f"<{successor}>" in link
    assert 'rel="successor-version"' in link
    # D4=A 契约：下线信号必须带 Deprecation: true 头（BLF-526 验收）。
    assert resp.headers.get("Deprecation") == "true"


def test_external_gone_successor_maps_same_suffix(client):
    """410 successor 与请求路径同后缀（/external → /agent 前缀替换）。"""
    resp = client.get("/api/v1/external/projects/42/ad-search-terms?period=30d")
    assert resp.status_code == 410
    assert resp.json()["successor"] == ("/api/v1/agent/projects/42/ad-search-terms")
