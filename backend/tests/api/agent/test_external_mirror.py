"""Agent 镜像 external 读路由测试（BLF-459 P1 路径迁移）。

覆盖：
* 映射完整性：external 每个 GET 路由都有对应 /agent/* 路由（除已原生迁移的
  new-product-calculations）。
* 数据一致：同一项目同一参数，agent 响应 ``data`` == external 响应 body。
* 鉴权契约：401 未带凭据 / 403 project_scope 越权。
* 壳翻译：404 项目 → RESOURCE_NOT_FOUND 壳；400 参数 → VALIDATION_FAILED 壳。
* Deprecation 头：external 全路径（含错误响应）带 Deprecation/Sunset/Link。
* projects 列表：受 scope 限制的 key 只见自己项目。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.sku_info import SkuRecord


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


# 每条镜像路由对应 external 原路径（相对 /api/v1 前缀），用于双通道比对。
# 代表各域：广告 10 表（aggregate）、主数据 / 业务分析、库存分类账、退货、
# 店铺测算历史 / 快照、定价快照。
_MIRROR_PATHS = [
    "/external/projects/{pid}/ad-campaigns",
    "/external/projects/{pid}/ad-search-terms",
    "/external/projects/{pid}/ad-budgets",
    "/external/projects/{pid}/ad-targets",
    "/external/projects/{pid}/ad-placements",
    "/external/projects/{pid}/ad-promoted-products",
    "/external/projects/{pid}/ad-time-trends",
    "/external/projects/{pid}/ad-search-term-shares",
    "/external/projects/{pid}/ad-invalid-traffic",
    "/external/projects/{pid}/ad-purchased-products",
    "/external/projects/{pid}/orders/summary",
    "/external/projects/{pid}/business-summary",
    "/external/projects/{pid}/replenishment-analysis",
    "/external/projects/{pid}/sku-info",
    "/external/projects/{pid}/inventory-ledger/months",
    "/external/projects/{pid}/inventory-ledger/snapshot",
    "/external/projects/{pid}/inventory-ledger/events",
    "/external/projects/{pid}/inventory-ledger/receipt-clusters",
    "/external/projects/{pid}/inventory-ledger/integrity",
    "/external/projects/{pid}/inventory-ledger/trend",
    "/external/projects/{pid}/inventory-ledger/detail",
    "/external/projects/{pid}/inventory-ledger/summary",
    "/external/projects/{pid}/inventory-ledger/batches",
    "/external/projects/{pid}/inventory-ledger/consistency",
    "/external/projects/{pid}/return-analysis",
    "/external/projects/{pid}/return-analysis-raw",
    "/external/projects/{pid}/shop-calculation-history",
    "/external/projects/{pid}/shop-calculation/snapshots",
    "/external/projects/{pid}/pricing-snapshots",
    "/external/projects/{pid}/ad-campaigns-raw",
    "/external/projects/{pid}/ad-campaign-raw",
    "/external/projects/{pid}/ad-search-terms-raw",
    "/external/projects/{pid}/ad-search-term-raw",
    "/external/projects/{pid}/ad-budgets-raw",
    "/external/projects/{pid}/ad-budget-raw",
    "/external/projects/{pid}/ad-targets-raw",
    "/external/projects/{pid}/ad-target-raw",
    "/external/projects/{pid}/ad-placements-raw",
    "/external/projects/{pid}/ad-placement-raw",
    "/external/projects/{pid}/ad-promoted-products-raw",
    "/external/projects/{pid}/ad-promoted-product-raw",
    "/external/projects/{pid}/ad-time-trends-raw",
    "/external/projects/{pid}/ad-time-trend-raw",
    "/external/projects/{pid}/ad-search-term-shares-raw",
    "/external/projects/{pid}/ad-search-term-share-raw",
    "/external/projects/{pid}/ad-invalid-traffic-raw",
    "/external/projects/{pid}/ad-purchased-products-raw",
    "/external/projects/{pid}/ad-purchased-product-raw",
]

# 各路由最小合法查询参数（inventory-ledger 必需 ?period=；ad 需要 country）。
_QUERY_PARAMS = {
    "ad-campaigns": "?period=7d&country=US",
    "ad-search-terms": "?period=7d&country=US",
    "ad-budgets": "?period=7d&country=US",
    "ad-targets": "?period=7d&country=US",
    "ad-placements": "?period=7d&country=US",
    "ad-promoted-products": "?period=7d&country=US",
    "ad-time-trends": "?period=7d&country=US",
    "ad-search-term-shares": "?period=7d&country=US",
    "ad-invalid-traffic": "?period=7d&country=US",
    "ad-purchased-products": "?period=7d&country=US",
    "ad-campaigns-raw": "?period=7d&country=US",
    "ad-search-terms-raw": "?period=7d&country=US",
    "ad-budgets-raw": "?period=7d&country=US",
    "ad-targets-raw": "?period=7d&country=US",
    "ad-placements-raw": "?period=7d&country=US",
    "ad-promoted-products-raw": "?period=7d&country=US",
    "ad-time-trends-raw": "?period=7d&country=US",
    "ad-search-term-shares-raw": "?period=7d&country=US",
    "ad-invalid-traffic-raw": "?period=7d&country=US",
    "ad-purchased-products-raw": "?period=7d&country=US",
    "orders/summary": "?period=7d",
    "business-summary": "?period=7d",
    "replenishment-analysis": "?period=7d",
    "return-analysis": "?period=7d",
    "return-analysis-raw": "?period=7d",
    "shop-calculation-history": "?period=7d",
    "shop-calculation/snapshots": "?period=7d",
    "inventory-ledger/months": "",
    "inventory-ledger/snapshot": "?period=last_month",
    "inventory-ledger/events": "?period=last_month",
    "inventory-ledger/receipt-clusters": "?period=last_month",
    "inventory-ledger/integrity": "?period=last_month",
    "inventory-ledger/trend": "?period=last_month",
    "inventory-ledger/detail": "?period=last_month",
    "inventory-ledger/summary": "?period=last_month",
    "inventory-ledger/batches": "?period=last_month",
    "inventory-ledger/consistency": "?period=last_month",
    "sku-info": "",
    "pricing-snapshots": "",
}

_AD_ALIAS_SUFFIXES = ("-raw",)  # 单数 alias 路径（ad-campaign-raw 等）同参数。


def _query_for(path: str) -> str:
    """从 /external/projects/{pid}/<rest> 提取 rest 并给出查询串。"""
    rest = path.split("/external/projects/{pid}/", 1)[1]
    for key, qs in _QUERY_PARAMS.items():
        if rest == key or rest.endswith(key):
            return qs
    return ""


@pytest.fixture
def mirror_env(make_api_key):
    """临时项目 + 2 SKU + 全放行 agent key，测试后清理。"""
    agent_id = f"blf459-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf459-{suffix}"

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
        for sku in ("X-001", "X-002"):
            db.add(
                SkuRecord(
                    project_id=project.id,
                    project_name=project_name,
                    sku=sku,
                    asin=f"ASIN-{sku}",
                    country="US",
                    fob_unit_cost=10,
                    first_leg_cost_rmb=1,
                    package_length_cm=10,
                    package_width_cm=10,
                    package_height_cm=10,
                    weight_kg=0.5,
                    carton_length_cm=20,
                    carton_width_cm=20,
                    carton_height_cm=20,
                    carton_weight_kg=5,
                    units_per_carton=10,
                    currency="USD",
                    sort_order=0,
                    is_active=True,
                )
            )
        db.commit()
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
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. 映射完整性 —— 所有 external GET 路由都有 agent 镜像
# ---------------------------------------------------------------------------


def test_all_external_get_routes_have_agent_mirror():
    """路由表级断言：external 每个 GET 路由（除已原生迁移的
    new-product-calculations）都存在对应 /agent/* 镜像。"""
    from app.api.v1.endpoints.agent import agent_router
    from app.api.v1.endpoints.external import external_router

    agent_paths = {r.path for r in agent_router.routes}
    excluded = {"/external/projects/{project_id}/new-product-calculations"}
    for route in external_router.routes:
        if "GET" not in (route.methods or set()):
            continue
        if route.path in excluded:
            continue
        rel = route.path[len("/external") :] or "/"
        assert f"/agent{rel}" in agent_paths, f"missing agent mirror for {route.path}"


# ---------------------------------------------------------------------------
# 2. 数据一致 —— 同一项目同一参数，agent data == external body
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", _MIRROR_PATHS)
def test_agent_mirror_data_parity(client, mirror_env, path):
    pid = mirror_env["project_id"]
    qs = _query_for(path)
    ext_url = f"/api/v1{path.format(pid=pid)}{qs}"
    agent_url = f"/api/v1{path.format(pid=pid).replace('/external/', '/agent/', 1)}{qs}"

    ext = client.get(ext_url)
    agent = client.get(agent_url, headers=mirror_env["headers"])

    # 状态码一致（200 / 400 业务错误等）
    assert agent.status_code == ext.status_code, (
        f"{path}: ext={ext.status_code} agent={agent.status_code}\n"
        f"agent body: {agent.text[:300]}"
    )
    if ext.status_code != 200:
        return  # 错误路径的壳翻译由下方专项用例覆盖
    body = agent.json()
    assert body["ok"] is True, f"{path}: {agent.text[:300]}"

    ext_data = ext.json()
    agent_data = body["data"]

    # 库存分类账 integrity/consistency 是每次实时校验，checked_at 必然不同——
    # 递归归一（顶层或嵌套 integrity 块都可能带）后再比对。
    def _strip_checked_at(value):
        if isinstance(value, dict):
            value.pop("checked_at", None)
            for v in value.values():
                _strip_checked_at(v)
        elif isinstance(value, list):
            for v in value:
                _strip_checked_at(v)
        return value

    _strip_checked_at(ext_data)
    _strip_checked_at(agent_data)
    assert agent_data == ext_data, f"{path}: data mismatch"


# ---------------------------------------------------------------------------
# 3. 鉴权契约
# ---------------------------------------------------------------------------


def test_agent_mirror_401_without_credentials(client, mirror_env):
    resp = client.get(
        f"/api/v1/agent/projects/{mirror_env['project_id']}/ad-campaigns?period=7d&country=US"
    )
    assert resp.status_code == 401
    assert resp.json()["ok"] is False
    assert resp.json()["error"]["code"] == "AGENT_AUTH_FAILED"


def test_agent_mirror_403_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="scoped-agent", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/ad-campaigns?period=7d&country=US",
        headers=_headers(key, "scoped-agent"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_agent_projects_list_filtered_by_scope(client, make_api_key):
    """受 scope 限制的 key 的 /projects 列表只见自己项目。"""
    key = make_api_key(agent_id="scoped-list", project_scope="1")
    resp = client.get("/api/v1/agent/projects", headers=_headers(key, "scoped-list"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert all(p["project_id"] == 1 for p in body["data"])


# ---------------------------------------------------------------------------
# 4. 壳翻译 —— 404 项目 / 400 参数
# ---------------------------------------------------------------------------


def test_agent_mirror_404_project_shell(client, mirror_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/sku-info",
        headers=mirror_env["headers"],
    )
    assert resp.status_code == 404
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_agent_mirror_400_validation_shell(client, mirror_env):
    resp = client.get(
        f"/api/v1/agent/projects/{mirror_env['project_id']}/ad-campaigns?period=bogus&country=US",
        headers=mirror_env["headers"],
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 5. Deprecation 头 —— external 全路径（含错误响应）
# ---------------------------------------------------------------------------


def test_external_200_carries_deprecation_headers(client, mirror_env):
    resp = client.get(f"/api/v1/external/projects/{mirror_env['project_id']}/sku-info")
    assert resp.status_code == 200
    assert resp.headers.get("Deprecation") == "true"
    assert resp.headers.get("Sunset") == "2026-11-01"
    link = resp.headers.get("Link")
    assert link == (
        f"</api/v1/agent/projects/{mirror_env['project_id']}/sku-info>; "
        'rel="successor-version"'
    )


def test_external_404_carries_deprecation_headers(client):
    """BLF-416 修复点：middleware 让 404 也带头（路由注入 Response 头做不到）。"""
    resp = client.get("/api/v1/external/projects/99999999/sku-info")
    assert resp.status_code == 404
    assert resp.headers.get("Deprecation") == "true"
    assert resp.headers.get("Sunset") == "2026-11-01"
    assert 'rel="successor-version"' in (resp.headers.get("Link") or "")
