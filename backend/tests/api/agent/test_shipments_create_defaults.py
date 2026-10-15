"""Agent 货件新建默认值（BLF-1347）。

未提供 ``shipment_no`` 时自动生成 ``FBA-<生成日期>-<标识>`` 占位编号；未提供
``created_date``（发货时间）/ ``shipping_method`` / ``shipment_status`` 时按前端
新建表单的默认值填充。默认值只在新建（POST /shipments）生效，PATCH 仍是
「未提供即保持原值」的合并语义。
"""

from __future__ import annotations

import re
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.services.audit_log_service import query_operation_audit_log

#: FBA-<YYYYMMDD>-<4 位标识>（字符集去掉易混淆的 I/O/0/1）
AUTO_SHIPMENT_NO_PATTERN = re.compile(r"^FBA-\d{8}-[A-Z2-9]{4}$")
ALL_AUTO_FILLED = ["created_date", "shipment_no", "shipment_status", "shipping_method"]


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis。"""
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
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments",
        json=body,
        headers=headers,
    )


def _patch(client, shipment_env, shipment_no, body, *, token=None, idem=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    return client.patch(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}",
        json=body,
        headers=headers,
    )


def _minimal_body() -> dict:
    """最小请求体：不提供 shipment_no / created_date / shipping_method / shipment_status。"""
    return {"country": "US", "items": [{"sku": "X-001", "quantity": 100}]}


def _create(client, shipment_env, body, *, idem=None) -> tuple[dict, dict]:
    """走完 confirm 两步，返回 ``(preview, data)``。"""
    idem = idem or f"idem-{uuid.uuid4().hex[:12]}"
    preview = _post(client, shipment_env, body, idem=idem)
    assert preview.status_code == 200, preview.text
    pbody = preview.json()
    assert pbody["requires_confirmation"] is True
    replay = _post(
        client, shipment_env, body, token=pbody["confirm_token"], idem=idem
    )
    assert replay.status_code == 200, replay.text
    return pbody["preview"], replay.json()["data"]


class TestCreateAutoDefaults:
    def test_auto_fills_shipment_no_and_defaults(
        self, client, shipment_env, confirm_memory_store
    ):
        preview, data = _create(client, shipment_env, _minimal_body())

        today = date.today().isoformat()
        assert AUTO_SHIPMENT_NO_PATTERN.match(str(preview["shipment_no"])), preview
        assert str(preview["shipment_no"]).startswith(f"FBA-{date.today():%Y%m%d}-")
        assert sorted(preview["auto_filled"]) == ALL_AUTO_FILLED
        assert preview["created_date"] == today
        assert preview["shipping_method"] == "sea"
        assert preview["shipment_status"] == "draft"

        # 预览所见即落库所得（confirm 重放沿用同一候选编号）
        assert data["shipment_no"] == preview["shipment_no"]
        assert data["created_date"] == today
        assert data["shipping_method"] == "sea"
        assert data["shipment_status"] == "draft"
        assert data["total_quantity"] == 100

        # 审计记录本次被自动填充的字段
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(data["id"])
            )
            audit = next(r for r in rows if r.action == "shipment.create")
            assert sorted(audit.after_json["auto_filled"]) == ALL_AUTO_FILLED
            assert audit.after_json["shipment_no"] == preview["shipment_no"]
        finally:
            db.close()

    def test_auto_shipment_no_retries_when_candidate_taken(
        self, client, shipment_env, confirm_memory_store
    ):
        # 同一 body + 同一 Idempotency-Key ⇒ 同一候选编号；第一次落库后候选被占用，
        # 第二次应自动换到下一个候选，且预览与落库仍一致。
        body = _minimal_body()
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        _, first = _create(client, shipment_env, body, idem=idem)
        second_preview, second = _create(client, shipment_env, body, idem=idem)

        assert AUTO_SHIPMENT_NO_PATTERN.match(str(second["shipment_no"]))
        assert second["shipment_no"] != first["shipment_no"]
        assert second_preview["shipment_no"] == second["shipment_no"]
        assert sorted(second_preview["auto_filled"]) == ALL_AUTO_FILLED

    def test_explicit_values_are_not_overridden(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-EX-{uuid.uuid4().hex[:8]}"
        body = {
            "shipment_no": shipment_no,
            "country": "US",
            "created_date": "2026-09-30",
            "shipping_method": "air",
            "shipment_status": "in_transit",
            "items": [{"sku": "X-002", "quantity": 50}],
        }
        preview, data = _create(client, shipment_env, body)

        assert preview["auto_filled"] == []
        assert preview["shipment_no"] == shipment_no
        assert preview["created_date"] == "2026-09-30"
        assert data["shipment_no"] == shipment_no
        assert data["created_date"] == "2026-09-30"
        assert data["shipping_method"] == "air"
        assert data["shipment_status"] == "in_transit"

    def test_only_missing_fields_are_auto_filled(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-PART-{uuid.uuid4().hex[:8]}"
        body = {
            "shipment_no": shipment_no,
            "country": "US",
            "items": [{"sku": "X-001", "quantity": 10}],
        }
        preview, data = _create(client, shipment_env, body)

        assert sorted(preview["auto_filled"]) == [
            "created_date",
            "shipment_status",
            "shipping_method",
        ]
        assert data["shipment_no"] == shipment_no
        assert data["created_date"] == date.today().isoformat()


class TestDefaultsOnlyOnCreate:
    def test_patch_keeps_stored_values(
        self, client, shipment_env, confirm_memory_store
    ):
        _, created = _create(client, shipment_env, _minimal_body())
        shipment_no = str(created["shipment_no"])
        body = {"remark": "agent 改的备注"}
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        preview = _patch(client, shipment_env, shipment_no, body, idem=idem)
        assert preview.status_code == 200, preview.text
        replay = _patch(
            client,
            shipment_env,
            shipment_no,
            body,
            token=preview.json()["confirm_token"],
            idem=idem,
        )
        assert replay.status_code == 200, replay.text
        patched = replay.json()["data"]

        # PATCH 未提供的字段保持原值，不被新建默认值覆盖
        assert patched["shipment_no"] == shipment_no
        assert patched["created_date"] == created["created_date"]
        assert patched["shipping_method"] == created["shipping_method"]
        assert patched["shipment_status"] == created["shipment_status"]
        assert patched["remark"] == "agent 改的备注"
