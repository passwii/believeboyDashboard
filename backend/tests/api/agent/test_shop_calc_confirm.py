"""Agent 店铺测算写路由 confirm 流测试（BLF-442 spec §7：W1）。"""

from __future__ import annotations

import uuid

import pytest
from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log
from conftest import seed_shop_calculation, shop_calc_body
from fastapi.testclient import TestClient


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis，且可直接改 created_at 模拟过期。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    """clear 内存写桶：跨测试隔离（slowapi 状态按进程共享）。"""
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


def _post(client, shipment_env, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.post(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shop-calculations",
        json=body,
        headers=headers,
    )


class TestAppendConfirm:
    def test_preview_then_replay_appends_and_audits(
        self, client, shipment_env, confirm_memory_store
    ):
        body = shop_calc_body(sku="X-001", sale_price_usd=22.0, profit_usd=6.0)
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["preview"]["action"] == "shop_calculation.append"
        assert pbody["preview"]["sku"] == "X-001"
        assert pbody["preview"]["sale_price_usd"] == 22.0
        assert pbody["preview"]["overwrites_current"] is False
        assert pbody["preview"]["previous_sale_price_usd"] is None

        # 重放落库
        replay = _post(
            client, shipment_env, body, token=pbody["confirm_token"], idem=idem
        )
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"]["sku"] == "X-001"
        assert rbody["data"]["sale_price_usd"] == 22.0
        assert rbody["data"]["source"] == "agent_listing_pull"
        assert rbody["data"]["created_by"] is None, (
            "agent 归因走审计，created_by 保持 NULL"
        )
        assert rbody["idempotency_key"] == idem

        # 审计行：target_type=shop_calculation / target_id=row.id / agent 归因
        db = SessionLocal()
        try:
            row_id = rbody["data"]["id"]
            rows = query_operation_audit_log(
                db, target_type="shop_calculation", target_id=str(row_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "shop_calculation.append"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.operator is None
        finally:
            db.close()

    def test_preview_shows_overwrites_current(
        self, client, shipment_env, confirm_memory_store
    ):
        seed_shop_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=18.5,
        )
        body = shop_calc_body(sku="X-001", sale_price_usd=19.99, profit_usd=4.8)
        preview = _post(client, shipment_env, body)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["preview"]["overwrites_current"] is True
        assert pbody["preview"]["previous_sale_price_usd"] == 18.5
        assert "已有当前价" in pbody["preview"]["note"]

    def test_replay_single_use(self, client, shipment_env, confirm_memory_store):
        body = shop_calc_body(sku="X-001")
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, body, idem=idem)
        token = preview.json()["confirm_token"]
        first = _post(client, shipment_env, body, token=token, idem=idem)
        assert first.status_code == 200
        second = _post(client, shipment_env, body, token=token, idem=idem)
        assert second.status_code == 400
        assert second.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_replay_body_change_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        body = shop_calc_body(sku="X-001", sale_price_usd=22.0)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, body, idem=idem)
        token = preview.json()["confirm_token"]
        changed = shop_calc_body(sku="X-001", sale_price_usd=99.0)
        replay = _post(client, shipment_env, changed, token=token, idem=idem)
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_confirm_token_expired(self, client, shipment_env, confirm_memory_store):
        body = shop_calc_body(sku="X-001")
        preview = _post(client, shipment_env, body)
        token = preview.json()["confirm_token"]
        confirm_memory_store._rows[token][
            "record"
        ].created_at -= 400  # 超过 300s 逻辑 TTL
        replay = _post(client, shipment_env, body, token=token)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"


class TestAppendValidation:
    def test_out_of_scope_write_returns_403(self, client, shipment_env, make_api_key):
        """L2 准入（BLF-441）：W1 写路由挂 require_project_scope，未授权项目 403。"""
        out_key = make_api_key(
            agent_id=shipment_env["agent_id"], project_scope="900001"
        )
        headers = {
            "Authorization": f"Bearer {out_key['plaintext']}",
            "X-Agent-Id": shipment_env["agent_id"],
            "Idempotency-Key": f"idem-{uuid.uuid4().hex[:12]}",
        }
        resp = client.post(
            f"/api/v1/agent/projects/{shipment_env['project_id']}/shop-calculations",
            json=shop_calc_body(sku="X-001"),
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    def test_sku_not_in_project_rejected_before_confirm(
        self, client, shipment_env, confirm_memory_store
    ):
        body = shop_calc_body(sku="X-999")
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SHOP_CALCULATION_INVALID_SKU"
        assert {"sku": "X-999", "reason": "not_found"} in err["details"]
        assert get_confirm_store()._rows == {}, "业务校验先于 confirm：未签发 token"

    def test_sku_country_mismatch_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        """D2 严格粒度：SKU 主数据只有 US，写 DE 被拦截。"""
        body = shop_calc_body(sku="X-001", country="DE")
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "SHOP_CALCULATION_INVALID_SKU"

    def test_invalid_source_rejected(self, client, shipment_env, confirm_memory_store):
        body = shop_calc_body(sku="X-001")
        body["source"] = "manual"  # agent 通道禁 manual
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SHOP_CALCULATION_INVALID_SOURCE"
        assert sorted(err["details"]["allowed"]) == [
            "agent_listing_pull",
            "agent_market_research",
            "agent_review_scrape",
            "external_api",
        ]
        assert get_confirm_store()._rows == {}

    def test_missing_source_rejected(self, client, shipment_env, confirm_memory_store):
        body = shop_calc_body(sku="X-001")
        del body["source"]
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SHOP_CALCULATION_INVALID_SOURCE"

    def test_negative_profit_is_accepted_and_warned(
        self, client, shipment_env, confirm_memory_store
    ):
        body = shop_calc_body(sku="X-001", profit_usd=-2.5, profit_rate=-0.125)
        idem = f"negative-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, body, idem=idem)
        assert preview.status_code == 200, preview.text
        payload = preview.json()
        assert payload["requires_confirmation"] is True
        assert payload["preview"]["profit_usd"] == -2.5
        assert payload["preview"]["profit_rate"] == -0.125
        assert "NEGATIVE_PROFIT" in payload["preview"]["warnings"]
        assert payload["preview"]["breakeven_advertising_rate"] is not None

        replay = _post(
            client,
            shipment_env,
            body,
            token=payload["confirm_token"],
            idem=idem,
        )
        assert replay.status_code == 200, replay.text
        assert replay.json()["data"]["profit"]["profit_usd"] == -2.5
        assert "NEGATIVE_PROFIT" in replay.json()["data"]["warnings"]

    def test_negative_profit_rate_is_not_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        body = shop_calc_body(sku="X-001", profit_usd=0.5, profit_rate=-0.01)
        response = _post(client, shipment_env, body)
        assert response.status_code == 200, response.text
        assert "NEGATIVE_PROFIT" in response.json()["preview"]["warnings"]

    def test_non_positive_sale_price_or_total_fee_is_still_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        for overrides in ({"sale_price_usd": 0}, {"total_fee_usd": 0}):
            response = _post(client, shipment_env, shop_calc_body(**overrides))
            assert response.status_code == 400, response.text
            assert response.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_future_observed_at_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        from datetime import datetime, timedelta, timezone

        body = shop_calc_body(
            sku="X-001",
            observed_at=(datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
        )
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_past_observed_at_accepted(
        self, client, shipment_env, confirm_memory_store
    ):
        from datetime import datetime, timedelta, timezone

        body = shop_calc_body(
            sku="X-001",
            observed_at=(datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
        )
        preview = _post(client, shipment_env, body)
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["observed_at"] is not None
