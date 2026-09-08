"""Agent 项目列表原生路由测试（BLF-990 / BLF-582）。

覆盖项目级 is_active、nested shop 映射、name/scope/auth 和路由排除。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models import Project, ProjectShop


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_project_shop_model_exposes_project_country_and_shop_id():
    shop = ProjectShop(project_id=1, country="US", shop_id="shop_test")
    assert shop.project_id == 1
    assert shop.country == "US"
    assert shop.shop_id == "shop_test"


def test_project_shop_model_has_unique_mapping_constraints():
    constraints = {constraint.name for constraint in ProjectShop.__table__.constraints}
    assert "uq_project_shops_project_country" in constraints
    assert "uq_project_shops_shop_id" in constraints
    assert "ck_project_shops_country" in constraints
    assert "ck_project_shops_shop_id_nonempty" in constraints

def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


@pytest.fixture
def projects_env(make_api_key):
    """临时项目 + 全放行 key，测试后清理。"""
    agent_id = f"blf582p-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-projects-{suffix}"

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


def test_projects_list_returns_shop_ids_and_project_active_state(client, projects_env):
    db = SessionLocal()
    try:
        db.add_all(
            [
                ProjectShop(
                    project_id=projects_env["project_id"],
                    country="DE",
                    shop_id="shop-de-test",
                ),
                ProjectShop(
                    project_id=projects_env["project_id"],
                    country="US",
                    shop_id="shop-us-test",
                ),
            ]
        )
        db.commit()
    finally:
        db.close()

    resp = client.get(
        f"/api/v1/agent/projects?name={projects_env['project_name']}",
        headers=projects_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    item = resp.json()["data"][0]
    assert item["is_active"] is True
    assert item["shops"] == [
        {"shop_id": "shop-de-test", "country": "DE", "site": "德国站"},
        {"shop_id": "shop-us-test", "country": "US", "site": "美国站"},
    ]


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调
# ---------------------------------------------------------------------------


def test_projects_list_parity(client, projects_env):
    """agent 通道 data == service 项目列表及其店铺映射。"""
    from app.schemas.external.projects import AgentShopItem, ProjectItem
    from app.services.external import projects_query
    from app.utils.country import get_country_label_cn

    resp = client.get("/api/v1/agent/projects", headers=projects_env["headers"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    agent_data = body["data"]

    db = SessionLocal()
    try:
        rows = projects_query.list_projects(db, status="active")
        shops_by_project = projects_query.list_project_shops(
            db, [project.id for project in rows]
        )
        expected = [
            ProjectItem(
                project_id=project.id,
                project_name=project.project_name,
                country=project.country,
                country_name=get_country_label_cn(project.country),
                is_active=bool(project.is_active),
                shops=[
                    AgentShopItem(
                        shop_id=shop.shop_id,
                        country=shop.country,
                        site=get_country_label_cn(shop.country),
                    )
                    for shop in shops_by_project.get(project.id, [])
                ],
            ).model_dump(mode="json")
            for project in rows
        ]
    finally:
        db.close()

    assert agent_data == expected, "agent 通道与 service 直调结果不一致"
    fixture_item = next(
        item for item in agent_data if item["project_id"] == projects_env["project_id"]
    )
    assert fixture_item["is_active"] is True
    assert fixture_item["shops"] == []


def test_projects_list_name_filter(client, projects_env):
    """``?name=`` 精确过滤：命中返回该项目；未命中返回空列表（BLF-461）。"""
    resp = client.get(
        f"/api/v1/agent/projects?name={projects_env['project_name']}",
        headers=projects_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert [p["project_name"] for p in body["data"]] == [projects_env["project_name"]]

    resp = client.get(
        f"/api/v1/agent/projects?name=no-such-{projects_env['project_name']}",
        headers=projects_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == []


def test_projects_list_scope_filtered(client, make_api_key):
    """受 project_scope 限制的 key 只见白名单内项目（L2 门禁语义）。"""
    key = make_api_key(agent_id="blf582-scoped", project_scope="1")
    resp = client.get("/api/v1/agent/projects", headers=_headers(key, "blf582-scoped"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert all(p["project_id"] == 1 for p in body["data"])


def test_projects_list_401_without_credentials(client):
    resp = client.get("/api/v1/agent/projects")
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


# ---------------------------------------------------------------------------
# 2. 路由面（模板断言：原生路由注册 + external_mirror 已删）
# ---------------------------------------------------------------------------


def test_projects_native_route_registered_and_mirror_removed():
    from app.api.v1.endpoints.agent.projects import projects_router

    native_paths = {r.path for r in projects_router.routes}
    assert "/projects" in native_paths

    # BLF-583：external_mirror 已退役删除，镜像路由整体移除，无双挂可能。
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.agent.external_mirror  # noqa: F401


def test_external_projects_module_deleted():
    """external/projects.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.projects  # noqa: F401
