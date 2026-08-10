"""Agent 项目列表原生路由测试（BLF-582 原生化：非 ad 域之一）。

覆盖（对齐 BLF-580 test_ad_campaigns.py 模板）：
1. parity：agent 通道 data == ``projects_query.list_projects`` 直调
   （``ProjectItem{project_id, project_name}`` 形状，``?status=`` 过滤）。
2. 鉴权/壳：401 未鉴权；``?name=`` 精确过滤（BLF-461 语义）；
   project_scope 白名单过滤。
3. 路由面/镜像排除：/agent/projects 原生路由注册；external_mirror 无
   projects 镜像路径；_EXCLUDED_EXTERNAL_PATHS 含 /external/projects；
   external/projects.py 端点模块已删除。
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


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调
# ---------------------------------------------------------------------------


def test_projects_list_parity(client, projects_env):
    """agent 通道 data == projects_query.list_projects 直调的 ProjectItem 列表。"""
    from app.schemas.external.projects import ProjectItem
    from app.services.external import projects_query

    resp = client.get("/api/v1/agent/projects", headers=projects_env["headers"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    agent_data = body["data"]

    db = SessionLocal()
    try:
        rows = projects_query.list_projects(db, status="active")
        expected = [
            ProjectItem(project_id=p.id, project_name=p.project_name).model_dump(
                mode="json"
            )
            for p in rows
        ]
    finally:
        db.close()

    assert agent_data == expected, "agent 通道与 service 直调结果不一致"
    assert any(p["project_id"] == projects_env["project_id"] for p in agent_data), (
        "agent 通道应包含本次 fixture 创建的项目"
    )


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
