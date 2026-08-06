"""Agent 镜像 external 读路由测试（BLF-459 P1 迁移 + V3 下线）。

覆盖：
* 映射完整性：external 每个 GET 路由都有对应 /agent/* 路由（除已原生迁移的
  new-product-calculations）。
* 数据一致：同一项目同一参数，agent 响应 ``data`` == external handler 直调结果
  （V3 起 /external/* HTTP 路由已 410 下线，直接比对 handler 函数输出）。
* 鉴权契约：401 未带凭据 / 403 project_scope 越权。
* 壳翻译：404 项目 → RESOURCE_NOT_FOUND 壳；400 参数 → VALIDATION_FAILED 壳。
* V3 下线契约：/external/* 全路径 410 Gone + Link successor。
* projects 列表：受 scope 限制的 key 只见自己项目。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
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
    "orders/summary": "?period=7d&country=US",
    "business-summary": "?period=7d&country=US",
    "replenishment-analysis": "?country=US",
    "return-analysis": "?period=7d&country=US",
    "return-analysis-raw": "?period=7d&country=US",
    "shop-calculation-history": "?country=US",
    "shop-calculation/snapshots": "?country=US",
    "inventory-ledger/months": "",
    "inventory-ledger/snapshot": "?period=last_month",
    "inventory-ledger/events": "?period=last_month",
    "inventory-ledger/receipt-clusters": "?period=last_month",
    "inventory-ledger/integrity": "?period=last_month",
    "inventory-ledger/trend": "?months=6",
    "inventory-ledger/detail": "?period=last_month",
    "inventory-ledger/summary": "?period=last_month",
    "inventory-ledger/batches": "?limit=50",
    "inventory-ledger/consistency": "?period=last_month",
    "sku-info": "",
    "pricing-snapshots": "?country=US",
}

_AD_ALIAS_SUFFIXES = ("-raw",)  # 单数 alias 路径（ad-campaign-raw 等）同参数。


def _query_for(path: str) -> str:
    """从 /external/projects/{pid}/<rest> 提取 rest 并给出查询串。

    单数 alias 路径（ad-campaign-raw 等）与复数版本共享参数。
    """
    rest = path.split("/external/projects/{pid}/", 1)[1]
    for key, qs in _QUERY_PARAMS.items():
        if rest == key or rest.endswith(key):
            return qs
    # 单数 alias：ad-campaign-raw → ad-campaigns-raw 的参数
    alias_map = {
        "ad-campaign-raw": "ad-campaigns-raw",
        "ad-search-term-raw": "ad-search-terms-raw",
        "ad-budget-raw": "ad-budgets-raw",
        "ad-target-raw": "ad-targets-raw",
        "ad-placement-raw": "ad-placements-raw",
        "ad-promoted-product-raw": "ad-promoted-products-raw",
        "ad-time-trend-raw": "ad-time-trends-raw",
        "ad-search-term-share-raw": "ad-search-term-shares-raw",
        "ad-invalid-traffic-raw": "ad-invalid-traffic-raw",
        "ad-purchased-product-raw": "ad-purchased-products-raw",
    }
    for alias, plural in alias_map.items():
        if rest == alias or rest.endswith(alias):
            return _QUERY_PARAMS.get(plural, "")
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
    from app.api.v1.endpoints.agent.external_mirror import (
        _iter_external_apiroutes,
        external_mirror_router,
    )

    # external_mirror_router.routes 是 add_api_route 直挂的 APIRoute，
    # 路径为相对路径（/projects/...，/agent 前缀由 agent_router 提供）。
    agent_paths = {r.path for r in external_mirror_router.routes}
    excluded = {"/external/projects/{project_id}/new-product-calculations"}
    for ext_path, route in _iter_external_apiroutes():
        if "GET" not in (route.methods or set()):
            continue
        if ext_path in excluded:
            continue
        rel = ext_path[len("/external") :] or "/"
        assert rel in agent_paths, f"missing agent mirror for {ext_path}"


# ---------------------------------------------------------------------------
# 2. 数据一致 —— 同一项目同一参数，agent data == external handler 直调结果
# ---------------------------------------------------------------------------


def _external_handler_for(path: str):
    """从 external 命名空间找 path 对应的 APIRoute（handler 函数）。"""
    from app.api.v1.endpoints.agent.external_mirror import _iter_external_apiroutes

    for ext_path, route in _iter_external_apiroutes():
        if ext_path == path.format(pid="{project_id}"):
            return route
    raise AssertionError(f"no external route for {path}")


def _handler_kwargs(route, qs: str, pid: int) -> dict:
    """构造直调 external handler 的 kwargs：查询串参数 + 签名其余参数的真实默认值。

    直调（不经 FastAPI）时未传参数的默认值是 ``Query(...)`` / ``Path(...)``
    对象（truthy），不是声明的默认值——必须沿签名解包（``param.default.default``）。
    查询串来的字符串按签名注解转成 int（如 ``months``、``limit``、``page``）。
    """
    import inspect
    import typing
    from urllib.parse import parse_qsl

    from fastapi.params import Param

    kwargs: dict = dict(parse_qsl(qs.lstrip("?")))
    sig = inspect.signature(route.endpoint)
    for name, param in sig.parameters.items():
        if name in kwargs or name == "db" or name == "project_id":
            continue
        default = param.default
        if isinstance(default, Param):
            default = default.default
        if name == "project_id":
            default = pid
        kwargs[name] = default
    kwargs["project_id"] = pid
    # 字符串 → int 类型转换（按解析后的注解；from __future__ import annotations
    # 下注解是字符串，需 get_type_hints 解析）。
    try:
        hints = typing.get_type_hints(route.endpoint)
    except Exception:  # noqa: BLE001 — 注解解析失败就跳过类型转换
        hints = {}
    for name, hint in hints.items():
        if name in kwargs and hint is int:
            kwargs[name] = int(kwargs[name])
    return kwargs


@pytest.mark.parametrize("path", _MIRROR_PATHS)
def test_agent_mirror_data_parity(client, mirror_env, path):
    pid = mirror_env["project_id"]
    qs = _query_for(path)
    agent_url = f"/api/v1{path.format(pid=pid).replace('/external/', '/agent/', 1)}{qs}"

    agent = client.get(agent_url, headers=mirror_env["headers"])
    body = agent.json()

    # V3：/external/* HTTP 已下线（410），数据一致改为直调 external handler
    # 函数比对——镜像本来就是复用同一 handler，直调即同源同参同结果。
    route = _external_handler_for(path)
    db = SessionLocal()
    try:
        kwargs = _handler_kwargs(route, qs, pid)
        try:
            result = route.endpoint(db=db, **kwargs)
            direct_status = 200
        except HTTPException as exc:
            result = None
            direct_status = exc.status_code
        if hasattr(result, "model_dump"):
            ext_data = result.model_dump(mode="json")
        elif isinstance(result, list):
            ext_data = [
                item.model_dump(mode="json") if hasattr(item, "model_dump") else item
                for item in result
            ]
        else:
            ext_data = result
    finally:
        db.close()

    # 无数据 / 参数错误的端点：agent 状态码应与直调一致（200 或 4xx）。
    if direct_status != 200 or agent.status_code != 200:
        assert agent.status_code == direct_status, (
            f"{path}: agent={agent.status_code} direct={direct_status}\n"
            f"agent body: {agent.text[:300]}"
        )
        return
    assert body["ok"] is True, f"{path}: {agent.text[:300]}"

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


def test_agent_projects_list_filtered_by_name(client, make_api_key):
    """``?name=`` 精确匹配：命中返回该项目的 id+name，未命中返回空列表。

    BLF-461：Agent 派发只给项目名，靠这个过滤做「名字 → ID」的确定性解析
    （project_name 唯一约束，结果 0/1 条）。
    """
    key = make_api_key(agent_id="name-filter", project_scope="*")
    headers = _headers(key, "name-filter")

    # 构造两个临时项目，确保名字匹配是精确的（不是子串）。
    suffix = uuid.uuid4().hex[:8]
    name_a = f"blf461-a-{suffix}"
    name_b = f"blf461-b-{suffix}"
    db = SessionLocal()
    project_ids: list[int] = []
    try:
        for name in (name_a, name_b):
            proj = Project(
                project_name=name,
                project_operator="pytest",
                assistant_operator=None,
                sort_order=0,
                is_active=True,
            )
            db.add(proj)
            db.commit()
            db.refresh(proj)
            project_ids.append(proj.id)
    finally:
        db.close()

    try:
        # 命中：只返回名字完全相等的那个项目。
        resp = client.get(f"/api/v1/agent/projects?name={name_a}", headers=headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert [p["project_name"] for p in body["data"]] == [name_a]

        # 未命中：空列表（Agent 据此判断「名字写错或项目不存在」）。
        resp = client.get(
            f"/api/v1/agent/projects?name=no-such-project-{suffix}", headers=headers
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["data"] == []

        # 不带 name：行为不变（全量 active 列表）。
        resp = client.get("/api/v1/agent/projects", headers=headers)
        assert resp.status_code == 200, resp.text
        all_names = [p["project_name"] for p in resp.json()["data"]]
        assert name_a in all_names and name_b in all_names
    finally:
        db = SessionLocal()
        try:
            for pid in project_ids:
                obj = db.get(Project, pid)
                if obj is not None:
                    db.delete(obj)
            db.commit()
        finally:
            db.close()


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
# 5. V3 下线契约 —— /external/* 全路径 410 Gone + Link successor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "/api/v1/external/projects",
        "/api/v1/external/projects/1/ad-campaigns?period=7d&country=US",
        "/api/v1/external/projects/1/inventory-ledger/months",
        "/api/v1/external/projects/99999999/sku-info",
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


def test_external_gone_successor_maps_same_suffix(client):
    """410 successor 与请求路径同后缀（/external → /agent 前缀替换）。"""
    resp = client.get("/api/v1/external/projects/42/ad-search-terms?period=30d")
    assert resp.status_code == 410
    assert resp.json()["successor"] == ("/api/v1/agent/projects/42/ad-search-terms")
