from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints import amazon_review_tracking as endpoint
from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import AmazonReviewTarget
from app.services.amazon_review_ingestion_service import (
    RatingCapture,
    ReviewCapture,
    record_crawl_result,
)
from app.services.amazon_review_tracking_service import create_group

TARGETS_URL = "/api/v1/amazon-review-tracking/targets"


@pytest.fixture
def admin_headers(admin_headers):
    """Root-conftest auth headers + an internal session id.

    ``_require_session`` demands a validated internal session; the root fixture
    only carries ``X-User-Id`` (the legacy admin-only path used ``X-Is-Admin``).
    """
    return {**admin_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def operator_headers(operator_headers):
    return {**operator_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def businessdev_headers(businessdev_headers):
    return {**businessdev_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def client(db_session, monkeypatch):
    """TestClient over the review-tracking router with a shared test session."""
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def _seed_target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(project_id=project.id, project_name=project.project_name,
        sku=f"ops-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=930000, is_active=True)
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US",
        name=f"Ops-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = db_session.execute(select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)).scalar_one()
    record_crawl_result(db_session, target_id=target.id, captured_at=datetime(2026, 10, 21, tzinfo=timezone.utc),
        status="success", rating=RatingCapture(average_rating=4.1, rating_count=9),
        reviews=[ReviewCapture(review_key="R1", id_confidence="original", rating=4, title="t")],
        is_complete_list=True)
    db_session.flush()
    return target


def test_list_targets_filters_by_group_and_kind(client, admin_headers, db_session):
    target = _seed_target(db_session)
    resp = client.get(TARGETS_URL, params={"kind": "internal_group"}, headers=admin_headers)
    assert resp.status_code == 200
    assert any(item["id"] == target.id for item in resp.json())


def test_rating_snapshots_and_reviews_and_runs(client, admin_headers, db_session):
    target = _seed_target(db_session)
    snaps = client.get(f"{TARGETS_URL}/{target.id}/rating-snapshots",
                       params={"from": "2026-10-01", "to": "2026-10-31"}, headers=admin_headers)
    assert snaps.status_code == 200 and len(snaps.json()) == 1
    assert snaps.json()[0]["average_rating"] == 4.1

    reviews = client.get(f"{TARGETS_URL}/{target.id}/reviews", headers=admin_headers)
    assert reviews.status_code == 200 and reviews.json()[0]["review_key"] == "R1"

    runs = client.get(f"{TARGETS_URL}/{target.id}/runs", headers=admin_headers)
    assert runs.status_code == 200 and runs.json()[0]["status"] == "success"


def test_unknown_target_returns_404_and_requires_session(client, admin_headers):
    assert client.get(f"{TARGETS_URL}/999999999/reviews", headers=admin_headers).status_code == 404
    assert client.get(TARGETS_URL).status_code == 401


def test_revoked_session_returns_401(client, admin_headers, monkeypatch):
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: False)
    assert client.get(TARGETS_URL, headers=admin_headers).status_code == 401


def test_operator_session_can_read(client, operator_headers):
    assert client.get(TARGETS_URL, headers=operator_headers).status_code == 200


def test_non_operator_session_forbidden(client, businessdev_headers):
    resp = client.get(TARGETS_URL, headers=businessdev_headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "需要运营或管理员权限"


def test_target_filters_exclude_non_matching(client, admin_headers, db_session):
    internal = _seed_target(db_session)
    external = AmazonReviewTarget(
        kind="external_asin", marketplace="UK",
        asin=f"B0{uuid.uuid4().hex[:8].upper()}", is_active=True,
    )
    db_session.add(external)
    db_session.flush()

    by_kind = client.get(TARGETS_URL, params={"kind": "external_asin"}, headers=admin_headers).json()
    kind_ids = {item["id"] for item in by_kind}
    assert external.id in kind_ids and internal.id not in kind_ids

    by_market = client.get(TARGETS_URL, params={"marketplace": "UK"}, headers=admin_headers).json()
    market_ids = {item["id"] for item in by_market}
    assert external.id in market_ids and internal.id not in market_ids


def test_reviews_and_runs_pagination_and_limit_bounds(client, admin_headers, db_session):
    target = _seed_target(db_session)
    record_crawl_result(db_session, target_id=target.id, captured_at=datetime(2026, 10, 22, tzinfo=timezone.utc),
        status="success", reviews=[
            ReviewCapture(review_key="R2", id_confidence="original", rating=5),
            ReviewCapture(review_key="R3", id_confidence="original", rating=3),
        ])
    db_session.flush()

    reviews_url = f"{TARGETS_URL}/{target.id}/reviews"
    first = client.get(reviews_url, params={"limit": 2, "offset": 0}, headers=admin_headers)
    assert first.status_code == 200 and [r["review_key"] for r in first.json()] == ["R1", "R2"]
    second = client.get(reviews_url, params={"limit": 2, "offset": 2}, headers=admin_headers)
    assert second.status_code == 200 and [r["review_key"] for r in second.json()] == ["R3"]
    assert client.get(reviews_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(reviews_url, params={"limit": 501}, headers=admin_headers).status_code == 422

    runs_url = f"{TARGETS_URL}/{target.id}/runs"
    first_run = client.get(runs_url, params={"limit": 1, "offset": 0}, headers=admin_headers)
    assert first_run.status_code == 200 and len(first_run.json()) == 1
    assert client.get(runs_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(runs_url, params={"limit": 201}, headers=admin_headers).status_code == 422


def test_targets_and_snapshots_limit_bounds(client, admin_headers, db_session):
    target = _seed_target(db_session)
    assert client.get(TARGETS_URL, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(TARGETS_URL, params={"limit": 1001}, headers=admin_headers).status_code == 422
    snaps_url = f"{TARGETS_URL}/{target.id}/rating-snapshots"
    assert client.get(snaps_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(snaps_url, params={"limit": 1001}, headers=admin_headers).status_code == 422
