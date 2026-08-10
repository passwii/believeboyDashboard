"""Agent 店铺测算历史/快照原生路由测试（BLF-582 原生化：非 ad 域之一）。

覆盖（对齐 BLF-580 test_ad_campaigns.py 模板）：
1. parity：agent 通道 data == ``app.services.external._shop_calculation`` 直调
   （空数据，history + snapshots 两路由；响应模型 model_dump 全等）。
2. 鉴权/壳：401 / 404 项目不存在 / 403 project_scope / 403 business_scope
   不含 shop_calculations；snapshots ``from_date > to_date`` → 400
   VALIDATION_FAILED 壳。
3. 路由面/镜像排除：2 条原生路由注册；external_mirror 无 shop-calculation
   镜像路径；_EXCLUDED_EXTERNAL_PATHS 含 2 条；external/shop_calculation.py
   已删除。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import Project


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


@pytest.fixture
def shop_calc_env(make_api_key):
    """临时项目 + 全放行 key（无测算数据），测试后清理。"""
    agent_id = f"blf582sc-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-shopcalc-{suffix}"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
    }

    db = SessionLocal()
    try:
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调（空数据）
# ---------------------------------------------------------------------------


def test_shop_calculation_history_parity(client, shop_calc_env):
    from app.schemas.external.shop_calculation import ShopCalculationHistoryResponse
    from app.services.external import _shop_calculation as svc

    pid = shop_calc_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/shop-calculation-history?country=US",
        headers=shop_calc_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        rows, total = svc.list_shop_calculation_history(
            db, project_id=pid, country="US", page=1, page_size=200
        )
        expected = ShopCalculationHistoryResponse(
            project_id=pid, country="US", total=total, data=rows
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected
    assert agent_data["total"] == 0
    assert agent_data["data"] == []


def test_shop_calculation_snapshots_parity(client, shop_calc_env):
    from app.schemas.external.shop_calculation import (
        ShopCalculationSnapshotsResponse,
    )
    from app.services.external import _shop_calculation as svc

    pid = shop_calc_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/shop-calculation/snapshots?country=US",
        headers=shop_calc_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        rows = svc.list_shop_calculation_snapshots(
            db, project_id=pid, from_date=None, to_date=None, sku=None, country="US"
        )
        expected = ShopCalculationSnapshotsResponse(
            project_id=pid,
            from_date=None,
            to_date=None,
            sku=None,
            country="US",
            total=len(rows),
            data=rows,
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected
    assert agent_data["total"] == 0


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403 / 400
# ---------------------------------------------------------------------------


def test_shop_calculation_401_without_credentials(client, shop_calc_env):
    resp = client.get(
        f"/api/v1/agent/projects/{shop_calc_env['project_id']}/shop-calculation-history"
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "AGENT_AUTH_FAILED"


def test_shop_calculation_404_project_not_found(client, shop_calc_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/shop-calculation-history",
        headers=shop_calc_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_shop_calculation_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="blf582sc-scoped", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/shop-calculation-history",
        headers=_headers(key, "blf582sc-scoped"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_shop_calculation_403_business_scope_missing(
    client, shop_calc_env, make_api_key
):
    """business_scope 不含 shop_calculations → 403（与原生 shop-calculations 域同域）。"""
    key = make_api_key(
        agent_id="blf582sc-biz",
        project_scope="*",
        business_scope="shipments",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{shop_calc_env['project_id']}"
        "/shop-calculation-history",
        headers=_headers(key, "blf582sc-biz"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_shop_calculation_snapshots_invalid_date_range(client, shop_calc_env):
    """``from_date > to_date`` → 400 VALIDATION_FAILED 壳（与原 external 一致）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{shop_calc_env['project_id']}"
        "/shop-calculation/snapshots?from_date=2026-08-10&to_date=2026-08-01",
        headers=shop_calc_env["headers"],
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 3. 路由面 / 镜像排除（模板断言）
# ---------------------------------------------------------------------------


def test_shop_calculation_native_routes_registered_and_mirror_excluded():
    from app.api.v1.endpoints.agent.external_mirror import (
        _EXCLUDED_EXTERNAL_PATHS,
        external_mirror_router,
    )
    from app.api.v1.endpoints.agent.shop_calculation import shop_calculation_router

    native_paths = {r.path for r in shop_calculation_router.routes}
    assert "/projects/{project_id}/shop-calculation-history" in native_paths
    assert "/projects/{project_id}/shop-calculation/snapshots" in native_paths

    mirror_paths = {r.path for r in external_mirror_router.routes}
    for rel in (
        "/projects/{project_id}/shop-calculation-history",
        "/projects/{project_id}/shop-calculation/snapshots",
    ):
        assert rel not in mirror_paths, f"镜像仍含 {rel}（双挂）"

    for ext in (
        "/external/projects/{project_id}/shop-calculation-history",
        "/external/projects/{project_id}/shop-calculation/snapshots",
    ):
        assert ext in _EXCLUDED_EXTERNAL_PATHS, f"排除集缺 {ext}"


def test_external_shop_calculation_module_deleted():
    """external/shop_calculation.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.shop_calculation  # noqa: F401
