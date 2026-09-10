"""店铺身份对照回归测试（BLF-1022）。

R0：active shops 返回 shop_name + seller_identity。
W1：identity_check 门禁（整批拒绝事务语义）+ 身份随行留存。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models.complaint_center import Complaint, ComplaintRun, ShopCheck
from app.models.project import Project
from app.models.project_shop import ProjectShop

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
def _cleanup_identity_tables():
    yield
    db = SessionLocal()
    try:
        db.execute(delete(Complaint))
        db.execute(delete(ShopCheck))
        db.execute(delete(ComplaintRun))
        db.execute(delete(ProjectShop))
        db.commit()
    finally:
        db.close()


@pytest.fixture
def id_project():
    """Isolated project (yields id + name), cleaned up afterwards."""
    suffix = uuid.uuid4().hex[:8]
    name = f"blf1022-{suffix}"
    db = SessionLocal()
    try:
        project = Project(
            project_name=name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
            country="US",
        )
        db.add(project)
        db.commit()
        pid = project.id
    finally:
        db.close()
    yield pid, name
    db = SessionLocal()
    try:
        db.execute(delete(Complaint).where(Complaint.project_id == pid))
        db.execute(delete(ShopCheck).where(ShopCheck.project_id == pid))
        db.execute(delete(ProjectShop).where(ProjectShop.project_id == pid))
        db.execute(delete(Project).where(Project.id == pid))
        db.commit()
    finally:
        db.close()


def _headers(make_api_key, agent_id: str) -> dict:
    key = make_api_key(agent_id=agent_id, business_scope="complaint_center")
    return {"Authorization": f"Bearer {key['plaintext']}", "X-Agent-Id": agent_id}


def seed_identity(project_id: int, expected: str | None = "BLF2026", **overrides) -> None:
    """Seed one US ProjectShop identity row (committed, visible to handlers)."""
    from app.services import project_service

    params = {
        "shop_id": f"shop_{uuid.uuid4().hex[:16]}",
        "shop_name": f"shopname-{uuid.uuid4().hex[:8]}",
        "seller_identity_expected_alias": expected,
        "seller_identity_aliases": [expected] if expected else [],
        "seller_identity_source": "amazon_seller_central_account_switcher",
        "seller_identity_required": True,
    }
    params.update(overrides)
    db = SessionLocal()
    try:
        project_service.upsert_project_shop(db, project_id, "US", **params)
        db.commit()
    finally:
        db.close()


def _identity(expected="BLF2026", observed="BLF2026", countries=("US",), verified=True) -> dict:
    return {
        "expected_alias": expected,
        "observed_alias": observed,
        "observed_country": list(countries),
        "verified": verified,
        "source": "amazon_seller_central_account_switcher",
    }


def _batch_body(project_id: int, run_date: str = "2026-09-04", **overrides) -> dict:
    body = {
        "run_date": run_date,
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
                "project_id": project_id,
                "country": "US",
                "check_status": "ok",
                "error_message": None,
                "identity_check": _identity(),
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
                "project_id": project_id,
                "country": "US",
                "buyer_name": "Crystal",
                "first_message_date": "2026-09-02",
                "message_date": "2026-09-02",
                "subject": "Product details inquiry from Amazon customer Crystal",
                "message_body": "Need another blanket",
                "triage": {
                    "category": "with_order",
                    "has_order": True,
                    "summary_zh": "买家称电热毯坏了",
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
    }
    body.update(overrides)
    return body


def _run_count() -> int:
    db = SessionLocal()
    try:
        return db.query(ComplaintRun).count()
    finally:
        db.close()


# ── R0 ──────────────────────────────────────────────────────────


class TestR0SellerIdentity:
    def test_shops_return_shop_name_and_seller_identity(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, name = id_project
        seed_identity(pid)
        agent_id = f"id-r0-{uuid.uuid4().hex[:8]}"
        resp = client.get(f"/api/v1/agent/projects?name={name}", headers=_headers(make_api_key, agent_id))
        assert resp.status_code == 200, resp.text
        shops = resp.json()["data"][0]["shops"]
        assert len(shops) == 1
        shop = shops[0]
        assert shop["shop_id"].startswith("shop_")
        assert shop["shop_name"].startswith("shopname-")
        assert shop["country"] == "US"
        assert shop["site"] == "美国站"
        assert shop["seller_identity"]["aliases"] == ["BLF2026"]
        assert (
            shop["seller_identity"]["source"]
            == "amazon_seller_central_account_switcher"
        )
        assert shop["seller_identity"]["required"] is True


# ── W1 门禁 ─────────────────────────────────────────────────────


class TestIdentityGate:
    def test_ok_verified_writes_and_persists_identity(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=_batch_body(pid),
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 200, resp.text
        db = SessionLocal()
        try:
            sc = db.query(ShopCheck).filter_by(project_id=pid).one()
            assert sc.identity_expected_alias == "BLF2026"
            assert sc.identity_observed_alias == "BLF2026"
            assert sc.identity_observed_country == ["US"]
            assert sc.identity_verified is True
            assert sc.identity_source == "amazon_seller_central_account_switcher"
        finally:
            db.close()

    def test_ok_unverified_rejected_whole_batch(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["identity_check"] = _identity(observed="OTHER", verified=False)
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_REQUIRED"
        assert _run_count() == 0

    def test_mismatch_with_verified_true_is_contradiction(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["check_status"] = "identity_mismatch"
        body["complaints"] = []
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_CONTRADICTION"
        assert _run_count() == 0

    def test_mismatch_without_complaints_accepted(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["check_status"] = "identity_mismatch"
        body["shop_checks"][0]["identity_check"] = _identity(observed="OTHER", verified=False)
        body["complaints"] = []
        body["summary"] = {
            "total_needs_reply": 0,
            "total_reported_unresolved": 0,
            "shops_with_pending": 0,
        }
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["complaints"] == []

    def test_verified_true_with_wrong_alias_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["identity_check"] = _identity(observed="OTHER", verified=True)
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_INVALID"
        assert _run_count() == 0

    def test_verified_true_with_wrong_country_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["identity_check"] = _identity(countries=("DE",), verified=True)
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_INVALID"
        assert _run_count() == 0

    def test_missing_expected_alias_on_required_shop_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid, expected=None)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=_batch_body(pid),
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_EXPECTED_ALIAS_MISSING"
        assert _run_count() == 0

    def test_stale_expected_alias_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid, expected="BLF2026")
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["identity_check"] = _identity(expected="OLD", observed="OLD")
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_INVALID"
        assert _run_count() == 0

    def test_login_page_shop_cannot_produce_complaints(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"][0]["check_status"] = "login_page"
        body["shop_checks"][0]["identity_check"] = _identity(
            observed=None, countries=[], verified=False
        )
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_REQUIRED"
        assert _run_count() == 0

    def test_complaint_without_ok_check_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid, shop_checks=[])
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 422, resp.text
        assert resp.json()["error"]["code"] == "IDENTITY_CHECK_REQUIRED"
        assert _run_count() == 0

    def test_duplicate_shop_check_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        body["shop_checks"].append(dict(body["shop_checks"][0]))
        body["complaints"] = []
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "VALIDATION_FAILED"
        assert _run_count() == 0

    def test_shops_failed_with_object_rejected(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid, shops_failed=[{"project_id": pid}])
        body["complaints"] = []
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["ok"] is False
        assert _run_count() == 0

    def test_legacy_ok_without_identity_config_still_writes(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        """存在映射但 required=false 且无 expected_alias 的店铺保持旧语义（向后兼容 BLF-981 调用方）。"""
        pid, _ = id_project
        seed_identity(pid, expected=None, seller_identity_required=False)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        body = _batch_body(pid)
        del body["shop_checks"][0]["identity_check"]
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 200, resp.text

    def test_readback_matches_written(
        self, client: TestClient, make_api_key, id_project
    ) -> None:
        pid, _ = id_project
        seed_identity(pid)
        agent_id = f"id-w1-{uuid.uuid4().hex[:8]}"
        run_date = f"2026-09-{uuid.uuid4().int % 20 + 10:02d}"
        body = _batch_body(pid, run_date=run_date)
        body["complaints"].append(
            {**body["complaints"][0], "buyer_name": "Ava", "subject": "Second subject"}
        )
        resp = client.post(
            "/api/v1/agent/complaint-center/batch",
            json=body,
            headers=_headers(make_api_key, agent_id),
        )
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["data"]["complaints"]) == 2
        read = client.get(
            f"/api/v1/agent/complaint-center/complaints?run_date={run_date}",
            headers=_headers(make_api_key, agent_id),
        )
        assert read.status_code == 200, read.text
        assert read.json()["data"]["total"] == 2
