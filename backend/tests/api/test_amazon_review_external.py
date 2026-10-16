from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints import amazon_review_tracking as endpoint
from app.models import Project
from app.models.project_shop import ProjectShop


@pytest.fixture
def admin_headers(admin_headers):
    """Root-conftest auth headers + an internal session id (see ops test)."""
    return {**admin_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def operator_headers(operator_headers):
    return {**operator_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def businessdev_headers(businessdev_headers):
    return {**businessdev_headers, "X-Session-Id": "external-test-session"}


@pytest.fixture
def client(db_session, monkeypatch):
    """TestClient over the review-tracking router with a shared test session."""
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def _shop(db_session):
    # 建专属 project：API 会 commit，复用首个 active project 会在重复跑时
    # 撞 uq_project_shops_project_country（project_id, country 唯一）。
    project = Project(
        project_name=f"ext-{uuid.uuid4().hex[:8]}", sort_order=930200, is_active=True
    )
    db_session.add(project)
    db_session.flush()
    shop = ProjectShop(project_id=project.id, country="US", shop_id=f"ext-{uuid.uuid4().hex[:8]}",
                       shop_name=f"ext-{uuid.uuid4().hex[:8]}")
    db_session.add(shop)
    db_session.flush()
    return shop


def test_register_external_target_and_relink_restores_history(client, admin_headers, db_session):
    shop = _shop(db_session)
    asin = f"B0{uuid.uuid4().hex[:8].upper()}"
    created = client.post("/api/v1/amazon-review-tracking/external-targets",
        json={"marketplace": "US", "asin": asin, "shop_id": shop.id}, headers=admin_headers)
    assert created.status_code == 201
    body = created.json()
    assert body["kind"] == "external_asin" and [link["shop_id"] for link in body["links"]] == [shop.id]
    target_id = body["id"]

    removed = client.delete(
        f"/api/v1/amazon-review-tracking/targets/{target_id}/external-links/{body['links'][0]['id']}",
        headers=admin_headers)
    assert removed.status_code == 200 and removed.json()["is_active"] is False

    again = client.post("/api/v1/amazon-review-tracking/external-targets",
        json={"marketplace": "US", "asin": asin, "shop_id": shop.id}, headers=admin_headers)
    assert again.status_code == 201 and again.json()["id"] == target_id
    assert [link["shop_id"] for link in again.json()["links"] if link["is_active"]] == [shop.id]


def test_external_requires_admin_and_rejects_bad_shop(client, admin_headers):
    assert client.post("/api/v1/amazon-review-tracking/external-targets",
                       json={"marketplace": "US", "asin": "B0X"}).status_code == 401
    bad = client.post("/api/v1/amazon-review-tracking/external-targets",
                      json={"marketplace": "US", "asin": f"B0{uuid.uuid4().hex[:8].upper()}", "shop_id": 999999999},
                      headers=admin_headers)
    assert bad.status_code == 422
