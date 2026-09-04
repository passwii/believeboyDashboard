"""Regression: backend must accept `Authorization: Bearer <key>` as an auth method.

[Live-chat 401 fix] Vercel/edge server-to-server fetches may strip the custom
`X-API-Key` header. `Authorization: Bearer` is a standard header that fetch
implementations always forward, so `require_api_key` accepts both for
defense in depth. Existing `X-API-Key` callers keep working unchanged.
"""
from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def bearer_app() -> FastAPI:
    app = FastAPI()

    @app.get("/_protected")
    def _protected_endpoint(_: None = Depends(__import__("app.api.deps", fromlist=["protected"]).protected)) -> dict[str, str]:
        return {"ok": "true"}

    return app


@pytest.fixture
def api_key() -> str:
    from app.core.config import get_settings
    return get_settings().api_key


def test_require_api_key_accepts_bearer(bearer_app, api_key):
    client = TestClient(bearer_app)
    resp = client.get("/_protected", headers={"Authorization": f"Bearer {api_key}"})
    assert resp.status_code == 200, resp.text


def test_require_api_key_still_accepts_x_api_key(bearer_app, api_key):
    client = TestClient(bearer_app)
    resp = client.get("/_protected", headers={"X-API-Key": api_key})
    assert resp.status_code == 200, resp.text


def test_require_api_key_bearer_wrong_token_returns_403(bearer_app):
    client = TestClient(bearer_app)
    resp = client.get("/_protected", headers={"Authorization": "Bearer wrong-key"})
    assert resp.status_code == 403


def test_require_api_key_accepts_query_api_key(bearer_app, api_key):
    """[Live-chat 401 fix, round 2] Vercel/edge also strips `Authorization`.
    Query param `?api_key=` survives because it's part of the URL. The
    frontend proxy appends it as the last-resort fallback.
    """
    client = TestClient(bearer_app)
    resp = client.get(f"/_protected?api_key={api_key}")
    assert resp.status_code == 200, resp.text


def test_require_api_key_no_auth_returns_401(bearer_app):
    client = TestClient(bearer_app)
    resp = client.get("/_protected")
    assert resp.status_code == 401


def test_require_api_key_query_api_key_wrong_returns_403(bearer_app):
    client = TestClient(bearer_app)
    resp = client.get("/_protected?api_key=wrong-key")
    assert resp.status_code == 403