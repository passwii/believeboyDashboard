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


@pytest.fixture
def admin_headers(admin_headers):
    """Root-conftest auth headers + an internal session id.

    ``_require_session`` demands a validated internal session; the root fixture
    only carries ``X-User-Id`` (the legacy admin-only path used ``X-Is-Admin``).
    """
    return {**admin_headers, "X-Session-Id": "ops-test-session"}


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
    resp = client.get("/api/v1/amazon-review-tracking/targets", params={"kind": "internal_group"}, headers=admin_headers)
    assert resp.status_code == 200
    assert any(item["id"] == target.id for item in resp.json())


def test_rating_snapshots_and_reviews_and_runs(client, admin_headers, db_session):
    target = _seed_target(db_session)
    snaps = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/rating-snapshots",
                       params={"from": "2026-10-01", "to": "2026-10-31"}, headers=admin_headers)
    assert snaps.status_code == 200 and len(snaps.json()) == 1
    assert snaps.json()[0]["average_rating"] == 4.1

    reviews = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/reviews", headers=admin_headers)
    assert reviews.status_code == 200 and reviews.json()[0]["review_key"] == "R1"

    runs = client.get(f"/api/v1/amazon-review-tracking/targets/{target.id}/runs", headers=admin_headers)
    assert runs.status_code == 200 and runs.json()[0]["status"] == "success"


def test_unknown_target_returns_404_and_requires_session(client, admin_headers):
    assert client.get("/api/v1/amazon-review-tracking/targets/999999999/reviews", headers=admin_headers).status_code == 404
    assert client.get("/api/v1/amazon-review-tracking/targets").status_code == 401
