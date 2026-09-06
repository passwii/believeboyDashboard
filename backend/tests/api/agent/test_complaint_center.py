"""Agent 客诉中心写侧域路由测试（BLF-981）。

对齐 inventory/shipments 模式：project_id + country。

覆盖：
1. W1 batch 批量 upsert：首次写入成功、返回 run_id + shop_check + complaint id；
   同一天重复提交幂等（upsert 不产生重复行，返回相同 run_id）；
   complaint 自然键冲突时 upsert（不重复）；
   Idempotency-Key 校验（空字符串 → 400）。
2. R1 GET /complaints：Agent 起草前读取最新状态。
3. 鉴权/错误壳：未鉴权 401；业务域缺失 403；KNOWN_BUSINESS_DOMAINS 含 complaint_center。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck

pytestmark = pytest.mark.usefixtures("db_session")


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_agent_rate_limit():
    from app.api.agent.rate_limit import agent_write_limiter

    agent_write_limiter.reset()
    yield
    agent_write_limiter.reset()


@pytest.fixture(autouse=True)
def _cleanup_complaint_tables():
    yield
    db = SessionLocal()
    try:
        db.execute(delete(Complaint))
        db.execute(delete(ShopCheck))
        db.execute(delete(ComplaintRun))
        db.commit()
    finally:
        db.close()


def _make_headers(make_api_key, agent_id: str, *, business_scope: str = "complaint_center") -> dict:
    key = make_api_key(agent_id=agent_id, business_scope=business_scope)
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }


def _batch_body(**overrides) -> dict:
    """最小合法 batch 请求体（1 shop + 1 complaint with order）。"""
    return {
        "run_date": "2026-09-04",
        "trigger": "autopilot",
        "shops_total": 1,
        "shops_checked": 1,
        "shops_failed": [],
        "summary": {
            "total_needs_reply": 1,
            "total_reported_unresolved": 0,
            "shops_with_pending": 1,
        },
        "shop_checks": [
            {
                "project_id": 1,
                "country": "US",
                "check_status": "ok",
                "error_message": None,
                "metrics": {
                    "needs_reply": 1,
                    "reported_unresolved": 0,
                    "resolved_total": 0,
                    "resolved_today": 0,
                },
            }
        ],
        "complaints": [
            {
                "project_id": 1,
                "country": "US",
                "buyer_name": "Crystal",
                "message_date": "2026-09-02",
                "subject": "Product details inquiry from Amazon customer Crystal",
                "message_body": "Need another blanket the one I bought last year doesn't work",
                "triage": {
                    "category": "with_order",
                    "has_order": True,
                    "summary_zh": "买家称去年买的电热毯坏了，想再买一条",
                },
                "order": {
                    "order_id": "112-8707798-7079456",
                    "asin": "B0CR19VKBX",
                    "product_title": "XINIUSLEEP Electric Blanket Twin",
                    "qty": 1,
                    "purchased_at": "2025-01-04T23:58:00+08:00",
                    "shipped_at": "2025-01-05T15:59:00+08:00",
                    "delivered_at": "2025-01-08T15:59:00+08:00",
                },
                "sla": {
                    "reply_deadline": "2026-09-05T01:08:00+08:00",
                    "expires_soon": True,
                },
            }
        ],
        **overrides,
    }


class TestBatchWrite:
    """W1 POST /batch 批量写入。"""

    def test_first_write_returns_ids(self, client: TestClient, make_api_key) -> None:
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id)
        resp = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["run_id"] > 0
        assert data["run_date"] == "2026-09-04"
        assert len(data["shop_checks"]) == 1
        assert data["shop_checks"][0]["shop_check_id"] > 0
        assert data["shop_checks"][0]["project_id"] == 1
        assert data["shop_checks"][0]["country"] == "US"
        assert len(data["complaints"]) == 1
        assert data["complaints"][0]["complaint_id"] > 0

    def test_idempotent_same_day_resubmit(self, client: TestClient, make_api_key) -> None:
        """同一天重复提交 → 更新原 run，不产生重复行。"""
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id)
        resp1 = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        resp2 = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        assert resp1.status_code == 200, resp1.text
        assert resp2.status_code == 200, resp2.text
        assert resp1.json()["data"]["run_id"] == resp2.json()["data"]["run_id"]

    def test_complaint_natural_key_upsert(self, client: TestClient, make_api_key) -> None:
        """相同自然键重复写入 → upsert 不产生重复 complaint。"""
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id)
        client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        resp = client.get(
            "/api/v1/agent/complaint-center/complaints?run_date=2026-09-04",
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["total"] == 1

    def test_idempotency_key_rejected_if_empty(self, client: TestClient, make_api_key) -> None:
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id)
        headers["Idempotency-Key"] = "   "
        resp = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        assert resp.status_code == 400
        assert resp.json()["ok"] is False


class TestReadEndpoints:
    """R1 GET /complaints。"""

    def test_list_complaints(self, client: TestClient, make_api_key) -> None:
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id)
        client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        resp = client.get(
            "/api/v1/agent/complaint-center/complaints?run_date=2026-09-04",
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert data["total"] == 1
        assert data["items"][0]["buyer_name"] == "Crystal"
        assert data["items"][0]["status"] == "pending"


class TestAuthAndScope:
    """鉴权 / 错误壳。"""

    def test_unauthenticated_returns_401(self, client: TestClient) -> None:
        resp = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body())
        assert resp.status_code == 401
        assert resp.json()["ok"] is False

    def test_missing_agent_id_returns_401(self, client: TestClient, make_api_key) -> None:
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        key = make_api_key(agent_id=agent_id, business_scope="complaint_center")
        headers = {"Authorization": f"Bearer {key['plaintext']}"}
        resp = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        assert resp.status_code == 401

    def test_wrong_business_scope_returns_403(self, client: TestClient, make_api_key) -> None:
        agent_id = f"cc-agent-{uuid.uuid4().hex[:8]}"
        headers = _make_headers(make_api_key, agent_id, business_scope="shipments")
        resp = client.post("/api/v1/agent/complaint-center/batch", json=_batch_body(), headers=headers)
        assert resp.status_code == 403

    def test_complaint_center_in_known_business_domains(self) -> None:
        from app.api.agent.scope import KNOWN_BUSINESS_DOMAINS
        assert "complaint_center" in KNOWN_BUSINESS_DOMAINS
