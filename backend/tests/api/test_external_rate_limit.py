"""Rate-limit tests for the external API (BEL-377).

Acceptance: with limiting enabled, the request past the configured window
returns 429. We shrink the window to ``5/minute`` so the test is fast and
deterministic, and rely on the package-level autouse fixture to reset the
in-memory slowapi storage + restore the flag afterwards.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def settings():
    return get_settings()


class TestRateLimit:
    def test_disabled_by_default_allows_burst(self, client, settings):
        assert settings.external_api_rate_limit_enabled is False
        for _ in range(10):
            assert client.get("/api/v1/external/projects").status_code == 200

    def test_over_limit_returns_429(self, client, settings):
        settings.external_api_rate_limit_enabled = True
        settings.external_api_rate_limit = "5/minute"

        statuses = [
            client.get("/api/v1/external/projects").status_code for _ in range(6)
        ]
        assert statuses[:5] == [200] * 5, statuses
        assert statuses[5] == 429, statuses

    def test_429_body_is_json(self, client, settings):
        settings.external_api_rate_limit_enabled = True
        settings.external_api_rate_limit = "1/minute"

        client.get("/api/v1/external/projects")
        resp = client.get("/api/v1/external/projects")
        assert resp.status_code == 429
        assert "detail" in resp.json()

    def test_per_key_isolation(self, client, settings, make_api_key):
        """Distinct DB keys get distinct buckets (key_func = api key id)."""
        settings.external_api_rate_limit_enabled = True
        settings.external_api_rate_limit = "2/minute"
        settings.external_api_require_auth = True

        key_a = make_api_key(label="a")
        key_b = make_api_key(label="b")

        # Exhaust key A's bucket.
        for _ in range(2):
            assert (
                client.get(
                    "/api/v1/external/projects",
                    headers={"X-API-Key": key_a["plaintext"]},
                ).status_code
                == 200
            )
        assert (
            client.get(
                "/api/v1/external/projects",
                headers={"X-API-Key": key_a["plaintext"]},
            ).status_code
            == 429
        )

        # Key B is unaffected.
        assert (
            client.get(
                "/api/v1/external/projects",
                headers={"X-API-Key": key_b["plaintext"]},
            ).status_code
            == 200
        )
