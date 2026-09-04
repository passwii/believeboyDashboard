"""Agent 新品测算写路由 confirm 流测试（BLF-451 spec §10：W1 upsert）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.models.new_product_calculation import NewProductCalculation
from app.services.audit_log_service import query_operation_audit_log

from conftest import new_product_body, seed_new_product_calculation


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


def _post(client, env, body, *, token=None, idem=None):
    headers = dict(env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.post(
        f"/api/v1/agent/projects/{env['project_id']}/new-product-calculations",
        json=body,
        headers=headers,
    )


def _count_rows(db, project_id: int) -> int:
    return (
        db.query(NewProductCalculation)
        .filter(NewProductCalculation.project_id == project_id)
        .count()
    )


class TestUpsertConfirm:
    def test_preview_then_replay_upserts_and_audits(
        self, client, shipment_env, confirm_memory_store
    ):
        body = new_product_body(sku="X-001", sale_price_usd=22.0, profit_usd=6.0)
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["preview"]["action"] == "new_product_calculation.upsert"
        assert pbody["preview"]["sku"] == "X-001"
        assert pbody["preview"]["sale_price_usd"] == 22.0
        assert pbody["preview"]["is_new"] is True
        assert pbody["preview"]["previous"] is None

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

        # 审计行：target_type=new_product_calculation / target_id=row.id / agent 归因
        db = SessionLocal()
        try:
            row_id = rbody["data"]["id"]
            rows = query_operation_audit_log(
                db, target_type="new_product_calculation", target_id=str(row_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "new_product_calculation.upsert"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.operator is None
        finally:
            db.close()

    def test_preview_shows_previous_on_overwrite(
        self, client, shipment_env, confirm_memory_store
    ):
        seed_new_product_calculation(
            shipment_env["project_id"],
            shipment_env["project_name"],
            sku="X-001",
            sale_price_usd=18.5,
        )
        body = new_product_body(sku="X-001", sale_price_usd=19.99, profit_usd=4.8)
        preview = _post(client, shipment_env, body)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["preview"]["is_new"] is False
        assert pbody["preview"]["previous"]["sale_price_usd"] == 18.5
        assert "覆盖" in pbody["preview"]["note"]

    def test_replay_single_use(self, client, shipment_env, confirm_memory_store):
        body = new_product_body(sku="X-001")
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
        body = new_product_body(sku="X-001", sale_price_usd=22.0)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, body, idem=idem)
        token = preview.json()["confirm_token"]
        changed = new_product_body(sku="X-001", sale_price_usd=99.0)
        replay = _post(client, shipment_env, changed, token=token, idem=idem)
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_confirm_token_expired(self, client, shipment_env, confirm_memory_store):
        body = new_product_body(sku="X-001")
        preview = _post(client, shipment_env, body)
        token = preview.json()["confirm_token"]
        confirm_memory_store._rows[token][
            "record"
        ].created_at -= 400  # 超过 300s 逻辑 TTL
        replay = _post(client, shipment_env, body, token=token)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"


class TestUpsertSemantics:
    def test_second_write_updates_same_row(
        self, client, shipment_env, confirm_memory_store
    ):
        """upsert 覆盖语义：同键二次写入行数不变、字段更新。"""
        body1 = new_product_body(sku="X-001", sale_price_usd=22.0, profit_usd=6.0)
        idem1 = f"idem-{uuid.uuid4().hex[:12]}"
        preview1 = _post(client, shipment_env, body1, idem=idem1)
        replay1 = _post(
            client,
            shipment_env,
            body1,
            token=preview1.json()["confirm_token"],
            idem=idem1,
        )
        assert replay1.status_code == 200

        body2 = new_product_body(sku="X-001", sale_price_usd=30.0, profit_usd=9.0)
        idem2 = f"idem-{uuid.uuid4().hex[:12]}"
        preview2 = _post(client, shipment_env, body2, idem=idem2)
        assert preview2.json()["preview"]["is_new"] is False
        assert preview2.json()["preview"]["previous"]["sale_price_usd"] == 22.0
        replay2 = _post(
            client,
            shipment_env,
            body2,
            token=preview2.json()["confirm_token"],
            idem=idem2,
        )
        assert replay2.status_code == 200
        assert replay2.json()["data"]["sale_price_usd"] == 30.0

        db = SessionLocal()
        try:
            assert _count_rows(db, shipment_env["project_id"]) == 1, (
                "upsert 覆盖：同键二次写入行数不变"
            )
            row = (
                db.query(NewProductCalculation)
                .filter(
                    NewProductCalculation.project_id == shipment_env["project_id"],
                    NewProductCalculation.sku == "X-001",
                )
                .one()
            )
            assert float(row.sale_price_usd) == 30.0
        finally:
            db.close()

        # 审计：两次 upsert 各一条，挂在同一 row id 上
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db,
                target_type="new_product_calculation",
                target_id=str(replay2.json()["data"]["id"]),
            )
            assert len(rows) == 2, "同键覆盖：每条审计都挂在稳定 row id 上"
        finally:
            db.close()

    def test_different_calculation_type_creates_separate_row(
        self, client, shipment_env, confirm_memory_store
    ):
        """不同 calculation_type 是不同业务键 → 各一行（upsert 键含类型）。"""
        for calc_type in ("profit_calc", "profit_reverse"):
            body = new_product_body(
                sku="X-001", calculation_type=calc_type, sale_price_usd=20.0
            )
            idem = f"idem-{uuid.uuid4().hex[:12]}"
            preview = _post(client, shipment_env, body, idem=idem)
            replay = _post(
                client,
                shipment_env,
                body,
                token=preview.json()["confirm_token"],
                idem=idem,
            )
            assert replay.status_code == 200

        db = SessionLocal()
        try:
            assert _count_rows(db, shipment_env["project_id"]) == 2
        finally:
            db.close()


class TestUpsertValidation:
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
            f"/api/v1/agent/projects/{shipment_env['project_id']}/new-product-calculations",
            json=new_product_body(sku="X-001"),
            headers=headers,
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    def test_sku_not_in_project_rejected_before_confirm(
        self, client, shipment_env, confirm_memory_store
    ):
        body = new_product_body(sku="X-999")
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "NEW_PRODUCT_CALCULATION_INVALID_SKU"
        assert {"sku": "X-999", "reason": "not_found"} in err["details"]
        assert get_confirm_store()._rows == {}, "业务校验先于 confirm：未签发 token"

    def test_sku_country_mismatch_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        """严格粒度：SKU 主数据只有 US，写 DE 被拦截。"""
        body = new_product_body(sku="X-001", country="DE")
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "NEW_PRODUCT_CALCULATION_INVALID_SKU"

    def test_invalid_source_rejected(self, client, shipment_env, confirm_memory_store):
        body = new_product_body(sku="X-001")
        body["source"] = "manual"  # agent 通道禁 manual
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "NEW_PRODUCT_CALCULATION_INVALID_SOURCE"
        assert sorted(err["details"]["allowed"]) == [
            "agent_listing_pull",
            "agent_market_research",
            "agent_review_scrape",
            "external_api",
        ]
        assert get_confirm_store()._rows == {}

    def test_missing_source_rejected(self, client, shipment_env, confirm_memory_store):
        body = new_product_body(sku="X-001")
        del body["source"]
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "NEW_PRODUCT_CALCULATION_INVALID_SOURCE"

    def test_eu_accounting_type_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        """W1 白名单仅 4 种（D2b）：eu_accounting 属店铺域，写入被拦。"""
        body = new_product_body(sku="X-001", calculation_type="eu_accounting")
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_non_positive_profit_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        body = new_product_body(sku="X-001", profit_usd=-1.0)
        resp = _post(client, shipment_env, body)
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_future_observed_at_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        from datetime import datetime, timedelta, timezone

        body = new_product_body(
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

        body = new_product_body(
            sku="X-001",
            observed_at=(datetime.now(timezone.utc) - timedelta(days=7)).isoformat(),
        )
        preview = _post(client, shipment_env, body)
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["observed_at"] is not None
