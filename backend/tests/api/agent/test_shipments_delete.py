"""Agent 货件删除路由（confirm 两步；不可逆，v0.5 起开放）。"""

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


def _delete(client, shipment_env, shipment_no, *, token=None, idem=None, project_id=None):
    headers = dict(shipment_env["headers"])
    headers["Idempotency-Key"] = idem or f"idem-{uuid.uuid4().hex[:12]}"
    if token:
        headers["X-Confirm-Token"] = token
    pid = project_id if project_id is not None else shipment_env["project_id"]
    return client.delete(
        f"/api/v1/agent/projects/{pid}/shipments/{shipment_no}",
        headers=headers,
    )


def _detail(client, shipment_env, shipment_no) -> TestClient:
    return client.get(
        f"/api/v1/agent/projects/{shipment_env['project_id']}/shipments/{shipment_no}",
        headers=shipment_env["headers"],
    )


class TestDeleteShipment:
    def test_preview_then_replay_deletes_shipment(
        self, client, shipment_env, confirm_memory_store
    ):
        shipment_no = f"SH-D-{uuid.uuid4().hex[:8]}"
        schedule_id = seed_schedule(shipment_env["project_id"], shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"

        # 第一次：预览壳（HTTP 200 + ok:false + requires_confirmation，不落库）
        preview = _delete(client, shipment_env, shipment_no, idem=idem)
        assert preview.status_code == 200, preview.text
        pbody = preview.json()
        assert pbody["ok"] is False
        assert pbody["requires_confirmation"] is True
        assert pbody["confirm_token"].startswith("cf_")
        assert pbody["expires_in_sec"] == 300
        assert pbody["preview"]["action"] == "shipment.delete"
        assert pbody["preview"]["shipment_no"] == shipment_no
        assert pbody["preview"]["shipment_status"] == "draft"
        assert pbody["preview"]["items_count"] == 2
        assert pbody["preview"]["total_quantity"] == 150
        assert "永久删除" in pbody["preview"]["note"]

        # 预览不落库：货件仍在
        assert _detail(client, shipment_env, shipment_no).status_code == 200

        # 第二次：重放删除
        replay = _delete(
            client, shipment_env, shipment_no, token=pbody["confirm_token"], idem=idem
        )
        assert replay.status_code == 200, replay.text
        rbody = replay.json()
        assert rbody["ok"] is True
        assert rbody["data"] == {"deleted": True, "shipment_no": shipment_no}
        assert rbody["idempotency_key"] == idem

        # 货件已删：详情 404
        assert _detail(client, shipment_env, shipment_no).status_code == 404

        # 审计行：agent 归因 + before 记录被删货件信息
        db = SessionLocal()
        try:
            rows = query_operation_audit_log(
                db, target_type="shipment_schedule", target_id=str(schedule_id)
            )
            assert len(rows) == 1
            audit = rows[0]
            assert audit.action == "shipment.delete"
            assert audit.agent_id == shipment_env["agent_id"]
            assert audit.idempotency_key == idem
            assert audit.operator is None
            assert audit.before_json == {
                "shipment_no": shipment_no,
                "project_id": shipment_env["project_id"],
                "status": "draft",
                "items_count": 2,
            }
        finally:
            db.close()

    def test_unknown_shipment_404(self, client, shipment_env, confirm_memory_store):
        resp = _delete(client, shipment_env, "SH-NOPE")
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
        assert get_confirm_store()._rows == {}  # 校验先于 confirm，未签发 token

    def test_cross_project_404(self, client, shipment_env, confirm_memory_store):
        """货件在本项目存在，但用不存在的 project_id 访问 → 404（不泄漏存在性）。"""
        shipment_no = f"SH-XP-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _delete(client, shipment_env, shipment_no, project_id=99999999)
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


class TestDeleteConfirmTokenFailures:
    def test_invalid_token_replay(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-INV-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        resp = _delete(client, shipment_env, shipment_no, token="cf_bogus")
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_expired_token_replay(self, client, shipment_env, confirm_memory_store):
        shipment_no = f"SH-EXP-{uuid.uuid4().hex[:8]}"
        seed_schedule(shipment_env["project_id"], shipment_no)
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        preview = _delete(client, shipment_env, shipment_no, idem=idem)
        token = preview.json()["confirm_token"]

        # 模拟逻辑过期（TTL 300s）：直接回拨 created_at
        confirm_memory_store._rows[token]["record"].created_at -= 301

        replay = _delete(client, shipment_env, shipment_no, token=token, idem=idem)
        assert replay.status_code == 409
        assert replay.json()["error"]["code"] == "CONFIRM_TOKEN_EXPIRED"
        # 过期消费后 token 已弹出：货件仍在
        assert _detail(client, shipment_env, shipment_no).status_code == 200
