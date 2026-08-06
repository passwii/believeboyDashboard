"""business_scope 业务域范围准入依赖测试（BLF-448）。

用独立迷你 app 复刻 agent 命名空间接线模式（与 test_project_scope.py 对齐）：

* 命名空间级依赖：``require_agent_credential`` + 读限流；
* 两个域路由各自挂 ``Depends(require_business_scope("<domain>"))``；
* 写路由额外挂 ``require_agent_write_rate_limit``。

覆盖：``*`` 放行 / 白名单命中 / 未命中 403（读+写都测）/ 空串归一 /
不存在 key 401 / 依赖顺序错误 fail closed。
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
from app.api.agent.scope import require_business_scope


def _build_app() -> FastAPI:
    """迷你 agent 命名空间：两个域路由 + business_scope 接线契约。"""
    app = FastAPI()
    register_agent_error_handlers(app)

    router = APIRouter(
        prefix="/api/v1/agent",
        dependencies=[
            Depends(require_agent_credential),
            Depends(require_agent_read_rate_limit),
        ],
    )
    shipments = APIRouter(
        prefix="/projects/{project_id}/shipments",
        dependencies=[Depends(require_business_scope("shipments"))],
    )

    @shipments.get("/scope-read")
    def _ship_read(project_id: int) -> dict:
        return agent_ok({"domain": "shipments", "project_id": project_id})

    @shipments.post(
        "/scope-write", dependencies=[Depends(require_agent_write_rate_limit)]
    )
    def _ship_write(project_id: int) -> dict:
        return agent_ok({"domain": "shipments", "project_id": project_id})

    shop_calcs = APIRouter(
        prefix="/projects/{project_id}/shop-calculations",
        dependencies=[Depends(require_business_scope("shop_calculations"))],
    )

    @shop_calcs.get("/scope-read")
    def _calc_read(project_id: int) -> dict:
        return agent_ok({"domain": "shop_calculations", "project_id": project_id})

    router.include_router(shipments)
    router.include_router(shop_calcs)
    app.include_router(router)
    return app


@pytest.fixture
def scope_env(make_api_key):
    """一张 agent 凭据 + 两个测试项目 id；business_scope 按用例覆盖。"""
    agent_id = f"biz-scope-agent-{uuid.uuid4().hex[:8]}"
    project_a, project_b = 900011, 900012

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


def _get_headers_for(scope_env: dict, business_scope: str) -> dict:
    key = scope_env["make_key"](business_scope=business_scope)
    return scope_env["headers"](key)


@pytest.fixture
def client() -> TestClient:
    return TestClient(_build_app())


class TestScopeAllowAll:
    def test_star_allows_all_domains(self, client, scope_env):
        headers = _get_headers_for(scope_env, "*")
        ship = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-read",
            headers=headers,
        )
        assert ship.status_code == 200, ship.text
        assert ship.json()["data"]["domain"] == "shipments"
        calc = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shop-calculations/scope-read",
            headers=headers,
        )
        assert calc.status_code == 200, calc.text
        assert calc.json()["data"]["domain"] == "shop_calculations"

    def test_empty_string_treated_as_all(self, client, scope_env):
        # 空串归一为 '*'（存量兼容，与 project_scope 一致）。
        headers = _get_headers_for(scope_env, "")
        resp = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-read",
            headers=headers,
        )
        assert resp.status_code == 200, resp.text


class TestScopeWhitelist:
    def test_domain_in_whitelist_allows(self, client, scope_env):
        headers = _get_headers_for(scope_env, "shipments")
        read = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-read",
            headers=headers,
        )
        assert read.status_code == 200, read.text
        write = client.post(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-write",
            headers=headers,
        )
        assert write.status_code == 200, write.text

    def test_multi_domain_whitelist(self, client, scope_env):
        headers = _get_headers_for(scope_env, "shipments, shop_calculations")
        for path, expected in (
            ("shipments/scope-read", "shipments"),
            ("shop-calculations/scope-read", "shop_calculations"),
        ):
            resp = client.get(
                f"/api/v1/agent/projects/{scope_env['project_a']}/{path}",
                headers=headers,
            )
            assert resp.status_code == 200, resp.text
            assert resp.json()["data"]["domain"] == expected

    def test_domain_out_of_scope_returns_403_read(self, client, scope_env):
        headers = _get_headers_for(scope_env, "shipments")
        resp = client.get(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shop-calculations/scope-read",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["error"]["code"] == ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE.value

    def test_domain_out_of_scope_returns_403_write(self, client, scope_env):
        headers = _get_headers_for(scope_env, "shop_calculations")
        resp = client.post(
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-write",
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert (
            resp.json()["error"]["code"] == ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE.value
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
            f"/api/v1/agent/projects/{scope_env['project_a']}/shipments/scope-read",
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
                "path": "/api/v1/agent/projects/42/shipments/scope-read",
                "headers": [],
                "query_string": b"",
                "server": None,
            }
        )
        request.state.agent_api_key_id = 999999  # 不存在的 key id
        with pytest.raises(AgentApiError) as exc:
            require_business_scope("shipments")(request)
        assert exc.value.code == ErrorCode.AGENT_AUTH_FAILED

    def test_scope_dependency_fails_closed_when_state_missing(self):
        """依赖直调：auth 未注入 key id（依赖顺序错误）→ fail closed。"""
        request = Request(
            {
                "type": "http",
                "method": "GET",
                "path": "/api/v1/agent/projects/42/shipments/scope-read",
                "headers": [],
                "query_string": b"",
                "server": None,
            }
        )
        with pytest.raises(AgentApiError) as exc:
            require_business_scope("shipments")(request)
        assert exc.value.code == ErrorCode.AGENT_AUTH_FAILED
