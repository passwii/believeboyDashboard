"""Agent 货件写路由 confirm 流（spec S2-S6；S2 在 Task 9 补）。"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.agent.confirm import InMemoryConfirmStore, get_confirm_store, set_confirm_store
from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log

from conftest import seed_schedule


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def settings():
    from app.core.config import get_settings

    return get_settings()


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


def _post(client, shipment_env, url_suffix, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.post(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments{url_suffix}",
        json=body,
        headers=headers,
    )


def _create_body(shipment_no: str) -> dict:
    return {
        "shipment_no": shipment_no,
        "country": "US",
        "shipping_method": "sea",
        "shipment_status": "draft",
        "etd_date": "2026-08-20",
        "eta_date": "2026-09-15",
        "logistics_unit_price": 13.5,
        "items": [
            {"sku": "X-001", "quantity": 100},
            {"sku": "X-002", "quantity": 50},
        ],
    }


class TestCreateShipment:
    def test_s3_preview_then_replay(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-C-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        # 第一次：预览壳（HTTP 200 + ok:false + requires_confirmation）
        preview = _post(client, shipment_env, "", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["expires_in_sec"] == 300
        assert pbody["preview"]["shipment_no"] == shipment_no
        assert pbody["preview"]["items_count"] == 2
        assert pbody["preview"]["total_quantity"] == 150

        # 第二次：重放落库
        replay = _post(client, shipment_env, "", body, token=pbody["confirm_token"], idem=idem)
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"]["shipment_no"] == shipment_no
        assert rbody["data"]["total_quantity"] == 150
        assert rbody["idempotency_key"] == idem

        # 审计行：agent 归因
        db = SessionLocal()
        try:
            schedule_id = rbody["data"]["id"]
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(schedule_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "shipment.create"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.operator is None
        finally:
            db.close()

    def test_replay_single_use(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-U-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]
        first = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert first.status_code == 200
        second = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert second.status_code == 400
        assert second.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_s6_invalid_sku_before_confirm(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VSKU-{uuid.uuid4().hex[:8]}")
        body["items"].append({"sku": "X-999", "quantity": 1})
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_ITEMS_INVALID_SKU"
        assert {"row": 3, "sku": "X-999", "reason": "not_found"} in err["details"]
        # 业务校验先于 confirm：未签发 token
        assert get_confirm_store()._rows == {}

    def test_invalid_status_rejected(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VST-{uuid.uuid4().hex[:8]}")
        body["shipment_status"] = "shipped"
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_STATUS_INVALID"
        assert sorted(err["details"]["allowed"]) == ["completed", "draft", "in_transit"]

    def test_invalid_shipping_method_rejected(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-VSM-{uuid.uuid4().hex[:8]}")
        body["shipping_method"] = "海运"  # 只接受英文 token
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_duplicate_shipment_no_rejected(self, client, shipment_env, confirm_memory_store):
        existing = f"SH-DUP-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], existing)
        body = _create_body(existing)
        resp = _post(client, shipment_env, "", body)
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "SHIPMENT_DUPLICATE_NO"

    def test_unknown_project_on_create_404(self, client, shipment_env, confirm_memory_store):
        body = _create_body(f"SH-NP-{uuid.uuid4().hex[:8]}")
        headers = dict(shipment_env["headers"])
        headers["Idempotency-Key"] = "idem-x"
        resp = client.post(
            "/api/v1/agent/projects/99999999/shipments", json=body, headers=headers
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestWriteRateLimit:
    def test_write_bucket(self, client, shipment_env, confirm_memory_store, settings):
        settings.agent_api_write_rate_limit = "2/minute"
        for i in range(2):
            resp = _post(
                client, shipment_env, "", _create_body(f"SH-RL-{uuid.uuid4().hex[:8]}")
            )
            assert resp.status_code == 200, resp.text
        blocked = _post(
            client, shipment_env, "", _create_body(f"SH-RL-{uuid.uuid4().hex[:8]}")
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "AGENT_RATE_LIMIT_EXCEEDED"


def _put(client, shipment_env, url_suffix, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.put(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments{url_suffix}",
        json=body,
        headers=headers,
    )


def _patch(client, shipment_env, url_suffix, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.patch(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments{url_suffix}",
        json=body,
        headers=headers,
    )


class TestReplaceItems:
    def test_replace_preview_replay_and_semantics(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-IT-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # 已有 X-001×100、X-002×50
        body = {"items": [{"sku": "X-002", "quantity": 30}]}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _put(client, shipment_env, f"/{shipment_no}/items", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["items_count"] == 1
        assert pbody["preview"]["total_quantity"] == 30

        replay = _put(
            client, shipment_env, f"/{shipment_no}/items", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        # 替换语义：只剩一行 X-002×30
        assert data["sku_count"] == 1
        assert data["total_quantity"] == 30
        assert data["items"][0]["sku"] == "X-002"

        # 审计行
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.items.replace")
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.before_json == {"items_count": 2}
            assert audit.after_json["total_quantity"] == 30
        finally:
            db.close()

    def test_replace_items_invalid_sku(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-ITSKU-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _put(
            client, shipment_env, f"/{shipment_no}/items",
            {"items": [{"sku": "X-999", "quantity": 1}]},
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SHIPMENT_ITEMS_INVALID_SKU"

    def test_replace_items_unknown_shipment_404(self, client, shipment_env, confirm_memory_store):
        resp = _put(client, shipment_env, "/SH-NOPE/items", {"items": [{"sku": "X-001", "quantity": 1}]})
        assert resp.status_code == 404


class TestPatchShipment:
    def test_patch_merges_partial_fields(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-P-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        body = {"remark": "agent 改的备注", "etd_date": "2026-10-01"}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _patch(client, shipment_env, f"/{shipment_no}", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert sorted(pbody["preview"]["changed"]) == ["etd_date", "remark"]

        replay = _patch(
            client, shipment_env, f"/{shipment_no}", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["remark"] == "agent 改的备注"
        assert data["etd_date"] == "2026-10-01"
        # 未 patch 的字段保持原值
        assert data["shipping_method"] == "sea"
        assert data["shipment_status"] == "draft"
        assert data["sku_count"] == 2  # 明细不受影响

    def test_patch_rejects_items_key(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PI-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _patch(
            client, shipment_env, f"/{shipment_no}",
            {"items": [{"sku": "X-001", "quantity": 1}]},
        )
        assert resp.status_code == 400
        assert "items" in resp.json()["error"]["human_message"]

    def test_patch_rejects_unknown_fields(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PU-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _patch(client, shipment_env, f"/{shipment_no}", {"nope_field": 1})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_patch_invalid_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-PS-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _patch(client, shipment_env, f"/{shipment_no}", {"shipment_status": "arrived"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "SHIPMENT_STATUS_INVALID"


class TestStatusTransition:
    def test_s5_status_preview_replay_and_audit(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-ST-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # draft
        body = {"to_status": "in_transit"}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(client, shipment_env, f"/{shipment_no}/status", body, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["from_status"] == "draft"
        assert pbody["preview"]["to_status"] == "in_transit"

        replay = _post(
            client, shipment_env, f"/{shipment_no}/status", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["shipment_status"] == "in_transit"

        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.status.transition")
            assert audit.before_json == {"shipment_status": "draft"}
            assert audit.after_json == {"shipment_status": "in_transit"}
            assert audit.agent_id == shipment_env["agent_id"]
        finally:
            db.close()

    def test_invalid_to_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-STI-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}/status", {"to_status": "shipped"})
        assert resp.status_code == 400
        err = resp.json()["error"]
        assert err["code"] == "SHIPMENT_STATUS_INVALID"
        assert sorted(err["details"]["allowed"]) == ["completed", "draft", "in_transit"]

    def test_missing_to_status(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-STM-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(client, shipment_env, f"/{shipment_no}/status", {})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestRecalculateCosts:
    def test_s2_preview_replay_and_audit(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-RC-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)  # 已有明细
        body = {"logistics_unit_price": 13.5}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs", body, idem=idem
        )
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["requires_confirmation"] is True
        assert pbody["preview"]["action"] == "shipment.recalculate_costs"
        assert pbody["preview"]["shipment_no"] == shipment_no
        assert pbody["preview"]["logistics_unit_price"] == 13.5
        assert "note" in pbody["preview"]

        replay = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs", body,
            token=pbody["confirm_token"], idem=idem,
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["logistics_unit_price"] == 13.5
        assert data["logistics_total_price"] > 0  # 费用被回写

        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.recalculate_costs")
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.after_json["logistics_unit_price"] == 13.5
        finally:
            db.close()

    def test_recalculate_without_items_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        # 空明细货件：直接建，不塞明细
        from app.schemas.shipment_schedule import ShipmentScheduleCreate
        from app.services import shipment as svc

        shipment_no = f"SH-RCE-{uuid.uuid4().hex[:8]}"
        db = SessionLocal()
        try:
            svc.create_shipment_schedule(
                db,
                ShipmentScheduleCreate(
                    project_id=shipment_env["project_id"],
                    country="US",
                    shipment_no=shipment_no,
                    shipping_method="sea",
                    shipment_status="draft",
                ),
                operator="pytest",
            )
            db.commit()
        finally:
            db.close()

        resp = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs",
            {"logistics_unit_price": 10},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert get_confirm_store()._rows == {}  # 校验先于 confirm

    def test_negative_price_rejected(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-RCN-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _post(
            client, shipment_env, f"/{shipment_no}/recalculate-costs",
            {"logistics_unit_price": -1},
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


class TestConfirmTokenFailures:
    def test_s4_expired_token(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-EXP-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]

        # 模拟逻辑过期（TTL 300s）：直接回拨 created_at
        confirm_memory_store._rows[token]["record"].created_at -= 301

        replay = _post(client, shipment_env, "", body, token=token, idem=idem)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"

    def test_changed_body_rejected(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-CHB-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _post(client, shipment_env, "", body, idem=idem)
        token = preview.json()["confirm_token"]

        tampered = _create_body(shipment_no)
        tampered["items"][0]["quantity"] = 999999  # 预览小改动、确认大改动
        replay = _post(client, shipment_env, "", tampered, token=token, idem=idem)
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_changed_idempotency_key_rejected(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-CHK-{uuid.uuid4().hex[:8]}"
        body = _create_body(shipment_no)
        preview = _post(client, shipment_env, "", body, idem="idem-A")
        token = preview.json()["confirm_token"]
        replay = _post(client, shipment_env, "", body, token=token, idem="idem-B")
        assert replay.status_code == 400
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"
