"""confirm 流 token 生命周期 + 装饰器（设计稿 §3；spec S3/S4 的机制层）。

不依赖真实 Redis：注入 InMemoryConfirmStore。真实写路由的端到端
confirm 用例（S2-S6）属 P2 plan。
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    DEFAULT_CONFIRM_TTL_SECONDS,
    InMemoryConfirmStore,
    get_confirm_store,
    issue_confirm_token,
    consume_confirm_token,
    ConfirmReplayError,
    require_confirmation,
    set_confirm_store,
)
from app.api.agent.errors import register_agent_error_handlers
from app.api.agent.response import agent_ok

EXECUTED: list[dict] = []


def _build_app() -> FastAPI:
    app = FastAPI()
    register_agent_error_handlers(app)

    @app.post("/w")
    @require_confirmation(
        action="test.action",
        build_preview=lambda body: {"echo": body},
        validate=_validate,
    )
    async def write_route(request: Request):
        body = json.loads(await request.body() or b"{}")
        EXECUTED.append(body)
        return agent_ok({"executed": True})

    @app.middleware("http")
    async def _stamp_agent_id(request: Request, call_next):
        request.state.agent_id = "confirm-agent"
        return await call_next(request)

    return app


def _validate(body: dict) -> None:
    from app.api.agent.errors import AgentApiError, ErrorCode

    if body.get("sku") == "BAD":
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message="SKU 无效", details=[]
        )


@pytest.fixture
def client():
    set_confirm_store(InMemoryConfirmStore())
    EXECUTED.clear()
    yield TestClient(_build_app())
    set_confirm_store(None)


def _post(client, body: dict, *, token: str | None = None, idem: str = "idem-1"):
    headers = {"Idempotency-Key": idem}
    if token:
        headers["X-Confirm-Token"] = token
    return client.post("/w", json=body, headers=headers)


class TestTokenLifecycle:
    def test_issue_and_consume(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, ttl = issue_confirm_token(
                agent_id="a", action="x", idempotency_key="k", body=b'{"v":1}'
            )
            assert record.token.startswith("cf_")
            assert ttl == DEFAULT_CONFIRM_TTL_SECONDS
            got = consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key="k", body=b'{"v":1}'
            )
            assert got.token == record.token
        finally:
            set_confirm_store(None)

    def test_consume_is_single_use(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b"{}"
            )
            consume_confirm_token(
                token=record.token, agent_id="a", idempotency_key=None, body=b"{}"
            )
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token, agent_id="a", idempotency_key=None, body=b"{}"
                )
            assert exc.value.reason == "invalid"
        finally:
            set_confirm_store(None)

    def test_body_hash_mismatch_invalid(self):
        set_confirm_store(InMemoryConfirmStore())
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b'{"v":1}'
            )
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token, agent_id="a", idempotency_key=None, body=b'{"v":2}'
                )
            assert exc.value.reason == "invalid"
        finally:
            set_confirm_store(None)

    def test_expired_classified(self):
        store = InMemoryConfirmStore()
        set_confirm_store(store)
        try:
            record, _ = issue_confirm_token(
                agent_id="a", action="x", idempotency_key=None, body=b"{}", ttl_seconds=1
            )
            store._rows[record.token]["record"].created_at -= 2  # 逻辑过期
            with pytest.raises(ConfirmReplayError) as exc:
                consume_confirm_token(
                    token=record.token, agent_id="a", idempotency_key=None, body=b"{}",
                    ttl_seconds=1,
                )
            assert exc.value.reason == "expired"
        finally:
            set_confirm_store(None)


class TestDecoratorFlow:
    def test_first_call_returns_preview_shell(self, client):
        resp = _post(client, {"sku": "X-001", "qty": 2})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is False
        assert body["requires_confirmation"] is True
        assert body["confirm_token"].startswith("cf_")
        assert body["expires_in_sec"] == DEFAULT_CONFIRM_TTL_SECONDS
        assert body["preview"] == {
            "action": "test.action",
            "echo": {"sku": "X-001", "qty": 2},
        }
        assert EXECUTED == []  # 未落库

    def test_replay_executes_once(self, client):
        preview = _post(client, {"sku": "X-001"}).json()
        replay = _post(client, {"sku": "X-001"}, token=preview["confirm_token"])
        assert replay.status_code == 200
        assert replay.json() == {"ok": True, "data": {"executed": True}}
        assert EXECUTED == [{"sku": "X-001"}]
        # token 用后即删：第二次重放无效
        again = _post(client, {"sku": "X-001"}, token=preview["confirm_token"])
        assert again.status_code == 400
        assert again.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        assert len(EXECUTED) == 1

    def test_replay_with_changed_body_rejected(self, client):
        preview = _post(client, {"sku": "X-001", "qty": 1}).json()
        replay = _post(
            client, {"sku": "X-001", "qty": 999}, token=preview["confirm_token"]
        )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
        assert EXECUTED == []

    def test_replay_with_changed_idempotency_key_rejected(self, client):
        preview = _post(client, {"sku": "X-001"}, idem="idem-A").json()
        replay = _post(
            client, {"sku": "X-001"}, token=preview["confirm_token"], idem="idem-B"
        )
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_validation_error_before_token_issued(self, client):
        resp = _post(client, {"sku": "BAD"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        # 未签发 token：存储为空
        assert get_confirm_store()._rows == {}
