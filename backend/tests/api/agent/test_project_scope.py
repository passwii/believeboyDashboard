"""project_scope 项目范围准入依赖测试（BLF-441，spec §6）。

店铺域路由（R1-R4/W1/C1）尚未落地（BLF-442），因此这里用独立迷你 app
复刻 spec §2 的路由接线模式作为契约：

* router 前缀 ``/api/v1/agent/projects/{project_id}``；
* 命名空间级依赖：``require_agent_credential`` + 读限流；
* 读路由挂 ``Depends(require_project_scope)``；
* 写路由额外挂 ``require_agent_write_rate_limit``（同 P2 货件域接线）。

覆盖：``*`` 放行 / 白名单命中 / 未命中 403（读+写都测）/ 不存在 key 401。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.testclient import TestClient

from app.api.agent.auth import require_agent_credential
from app.api.agent.errors import AgentApiError, ErrorCode, register_agent_error_handlers
from app.api.agent.rate_limit import (
    require_agent_read_rate_limit,
    require_agent_write_rate_limit,
)
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope


def _build_app() -> FastAPI:
    """迷你 agent 命名空间：project_scope 接线契约（spec §2 模式）。"""
    app = FastAPI()
    register_agent_error_handlers(app)

    router = APIRouter(
        prefix="/api/v1/agent/projects/{project_id}",
        dependencies=[
            Depends(require_agent_credential),
            Depends(require_agent_read_rate_limit),
        ],
    )

    @router.get("/scope-read")
    def _scope_read(project_id: int, _scope=Depends(require_project_scope)) -> dict:
        return agent_ok({"project_id": project_id})

    @router.post(
        "/scope-write",
        dependencies=[Depends(require_agent_write_rate_limit)],
    )
    def _scope_write(project_id: int, _scope=Depends(require_project_scope)) -> dict:
        return agent_ok({"project_id": project_id})

    app.include_router(router)
    return app


@pytest.fixture
def scope_env(make_api_key):
    """一张 agent 凭据 + 两个测试项目 id；scope 按用例覆盖。"""
    agent_id = f"scope-agent-{uuid.uuid4().hex[:8]}"
    project_a, project_b = 900001, 900002

    def _headers(key: dict) -> dict:
        return {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": agent_id,
        }

    yield {
        "agent_id": agent_id,
        "project_a": project_a,
        "project_b": project_b,
        "headers": _headers,
        "make_key": lambda **kw: make_api_key(agent_id=agent_id, **kw),
    }


def _get_headers_for(scope_env: dict, project_scope: str) -> dict:
    key = scope_env["make_key"](project_scope=project_scope)
    return scope_env["headers"](key)


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


class TestScopeAllowAll:
    def test_star_allows_read_and_write(self, client, scope_env):
        headers = _get_headers_for(scope_env, "*")
        read = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-read",
            headers=headers,
        )
        assert read.status_code == 200, read.text
        assert read.json()["data"]["project_id"] == scope_env["project_a"]
        write = client.post(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-write",
            headers=headers,
        )
        assert write.status_code == 200, write.text

    def test_empty_string_treated_as_all(self, client, scope_env):
        # 前端空选 = 全项目；service 层把空串归一为 '*'（存量兼容）。
        headers = _get_headers_for(scope_env, "")
        resp = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-read",
            headers=headers,
        )
        assert resp.status_code == 200, resp.text


class TestScopeWhitelist:
    def test_project_in_whitelist_allows(self, client, scope_env):
        headers = _get_headers_for(scope_env, f"{scope_env['project_a']}")
        read = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-read",
            headers=headers,
        )
        assert read.status_code == 200, read.text
        write = client.post(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-write",
            headers=headers,
        )
        assert write.status_code == 200, write.text

    def test_multi_project_whitelist(self, client, scope_env):
        scope = f"{scope_env['project_a']}, {scope_env['project_b']}"
        headers = _get_headers_for(scope_env, scope)
        for pid in (scope_env["project_a"], scope_env["project_b"]):
            resp = client.get(
                f"/api/v1/agent/projects/{pid}/scope-read", headers=headers
            )
            assert resp.status_code == 200, resp.text

    def test_project_out_of_scope_returns_403_read(self, client, scope_env):
        headers = _get_headers_for(scope_env, f"{scope_env['project_a']}")
        resp = client.get(
            f"/api/v1/agent/projects/{scope_env['project_b']}/scope-read",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE.value

    def test_project_out_of_scope_returns_403_write(self, client, scope_env):
        headers = _get_headers_for(scope_env, f"{scope_env['project_b']}")
        resp = client.post(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-write",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert (
            resp.json()["error"]["code"] == ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE.value
        )


class TestMissingKey:
    def test_auth_fails_for_deleted_key(self, client, scope_env):
        """key 行被删（吊销后清理）→ 401：auth 层 resolve 不到即拒。"""
        key = scope_env["make_key"]()
        headers = scope_env["headers"](key)
        from app.db.session import SessionLocal
        from app.models.agent_api_key import AgentApiKey

        db = SessionLocal()
        try:
            obj = db.get(AgentApiKey, key["id"])
            db.delete(obj)
            db.commit()
        finally:
            db.close()
        resp = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/scope-read",
            headers=headers,
        )
        assert resp.status_code == 401, resp.text
        assert resp.json()["error"]["reason"] == "token_invalid"

    def test_scope_dependency_fails_closed_when_key_row_missing(self):
        """依赖直调：auth 之后 key 行丢失 → 401 fail closed（与 auth 同语义）。"""
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/v1/agent/projects/42/scope-read",
                "headers": [],
                "query_string": b"",
                "server": None,
            }
        )
        request.state.agent_api_key_id = 999999  # 不存在的 key id
        with pytest.raises(AgentApiError) as exc:
            require_project_scope(42, request)
        assert exc.value.code == ErrorCode.AGENT_AUTH_FAILED

    def test_scope_dependency_fails_closed_when_state_missing(self):
        """依赖直调：auth 未注入 key id（依赖顺序错误）→ fail closed。"""
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/v1/agent/projects/42/scope-read",
                "headers": [],
                "query_string": b"",
                "server": None,
            }
        )
        with pytest.raises(AgentApiError) as exc:
            require_project_scope(42, request)
        assert exc.value.code == ErrorCode.AGENT_AUTH_FAILED
