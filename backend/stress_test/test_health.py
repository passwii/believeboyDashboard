"""
Pytest health check suite for BelieveBoy backend.
Run: pytest backend/stress_test/test_health.py -v

Covers:
  - /health (enhanced, with DB + Redis status)
  - /health/live (no auth, no DB)
  - /health/ready (DB required, returns 503 if down)
  - /health (auth protection — 401 without API key)
"""

import pytest
import httpx
from typing import Generator


# ── Config ────────────────────────────────────────────────────────────────────
BASE_URL: str | None = None  # set via env BACKEND_URL
API_KEY: str | None = None  # set via env API_KEY

import os as _os

BASE_URL = _os.environ.get("BACKEND_URL", "http://127.0.0.1:8100")
API_KEY = _os.environ.get("API_KEY", "change-me-in-dev")


# ── Fixtures ──────────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def anon_client() -> Generator[httpx.Client, None, None]:
    with httpx.Client(base_url=BASE_URL, timeout=10.0) as c:
        yield c


@pytest.fixture(scope="module")
def auth_client() -> Generator[httpx.Client, None, None]:
    with httpx.Client(
        base_url=BASE_URL,
        timeout=10.0,
        headers={
            "X-API-Key": API_KEY,
            "X-Operator": "pytest-stress-test",
            "X-User-Id": "pytest",
            "X-User-Name": "pytest",
            "X-Is-Admin": "false",
        },
    ) as c:
        yield c


# ── Tests ─────────────────────────────────────────────────────────────────────
class TestHealthEndpoints:
    """Health check endpoint suite."""

    def test_health_live_no_auth(self, anon_client: httpx.Client):
        """Liveness probe: no auth, no DB check — should always succeed."""
        res = anon_client.get("/api/v1/health/live")
        assert res.status_code == 200, f"Expected 200, got {res.status_code}: {res.text}"
        data = res.json()
        assert data["status"] == "ok"
        assert "timestamp" in data

    def test_health_requires_api_key(self, anon_client: httpx.Client):
        """The enhanced /health requires X-API-Key header."""
        res = anon_client.get("/api/v1/health")
        # 401 or 403 depending on FastAPI security config — either is acceptable
        assert res.status_code in (401, 403), f"Expected auth error, got {res.status_code}"

    def test_health_with_api_key(self, auth_client: httpx.Client):
        """Enhanced /health returns DB and Redis status."""
        res = auth_client.get("/api/v1/health")
        assert res.status_code == 200, f"Got {res.status_code}: {res.text}"
        data = res.json()

        assert data["status"] in ("ok", "degraded"), f"Unexpected status: {data['status']}"
        assert "database" in data
        assert "redis" in data
        assert "timestamp" in data

        # DB should be reachable in test environment
        db_ok = data["database"].startswith("ok")
        assert db_ok, f"Database is not healthy: {data['database']}"

    def test_health_ready_db_required(self, auth_client: httpx.Client):
        """Readiness probe returns 503 if DB is unreachable."""
        res = auth_client.get("/api/v1/health/ready")
        # In normal operation this should be 200
        # If DB is down, this returns 503 — which is correct behavior
        assert res.status_code in (200, 503), f"Unexpected status code: {res.status_code}"
        if res.status_code == 503:
            data = res.json()
            assert data["status"] == "unavailable"

    def test_health_response_time(self, auth_client: httpx.Client):
        """Health check should respond in < 500ms even under load."""
        import time

        start = time.perf_counter()
        res = auth_client.get("/api/v1/health")
        elapsed_ms = (time.perf_counter() - start) * 1000

        assert res.status_code == 200
        assert elapsed_ms < 500, f"Health check took {elapsed_ms:.1f}ms — too slow"


class TestKeyEndpointsSmoke:
    """Smoke tests for the most critical endpoints (used in stress test mix)."""

    PROJECT_NAME = "TestProject"

    def test_daily_reports_list(self, auth_client: httpx.Client):
        res = auth_client.get(
            f"/api/v1/daily-reports/list",
            params={"project_name": self.PROJECT_NAME, "days": 7, "page": 1, "page_size": 50},
        )
        # 200 or 422 (validation) — not 5xx
        assert res.status_code < 500, f"Got {res.status_code}: {res.text}"

    def test_product_costs_list(self, auth_client: httpx.Client):
        res = auth_client.get(
            f"/api/v1/product-costs/list",
            params={"page": 1, "page_size": 100, "project_name": self.PROJECT_NAME},
        )
        assert res.status_code < 500, f"Got {res.status_code}: {res.text}"

    def test_shipment_schedules_list(self, auth_client: httpx.Client):
        res = auth_client.get(
            f"/api/v1/shipment-schedules/list",
            params={"page": 1, "page_size": 20, "project_name": self.PROJECT_NAME},
        )
        assert res.status_code < 500, f"Got {res.status_code}: {res.text}"

    def test_exchange_rates_list(self, auth_client: httpx.Client):
        res = auth_client.get("/api/v1/exchange-rates/list", params={"page": 1, "page_size": 50})
        assert res.status_code < 500, f"Got {res.status_code}: {res.text}"

    def test_ai_conversations_list(self, auth_client: httpx.Client):
        res = auth_client.get("/api/v1/ai/conversations", params={"page": 1, "page_size": 20})
        assert res.status_code < 500, f"Got {res.status_code}: {res.text}"


if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])