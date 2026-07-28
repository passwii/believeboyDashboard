"""Endpoint integration tests for ``GET /external/projects/{id}/sku-info``.

Follows the same contract style as ``test_external_endpoints.py``:
  * 404 for missing project
  * 400 for invalid country
  * 200 + correct shape for valid requests
  * pagination (has_next) behaviour
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.sku_info import SkuRecord


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Session:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _first_project(db: Session) -> Project | None:
    return db.execute(select(Project).limit(1)).scalar_one_or_none()


def _sku_url(project_id: int, **params: str) -> str:
    base = f"/api/v1/external/projects/{project_id}/sku-info"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    return f"{base}?{qs}" if qs else base


class TestSkuInfoContract:
    """Basic request/response contract tests."""

    def test_missing_project_returns_404(self, client):
        resp = client.get(_sku_url(99999999))
        assert resp.status_code == 404, resp.text
        assert "not found" in resp.json()["detail"].lower()

    def test_invalid_country_returns_400(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id, country="INVALID"))
        assert resp.status_code == 400, resp.text
        assert "country" in resp.json()["detail"].lower()

    def test_valid_request_returns_correct_shape(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id))
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["project_id"] == project.id
        assert "country" in body
        assert "has_next" in body
        assert isinstance(body["data"], list)

        if body["data"]:
            item = body["data"][0]
            expected_keys = {
                "sku",
                "asin",
                "fnsku",
                "product_name",
                "fob_unit_cost",
                "first_leg_cost_rmb",
                "currency",
                "country",
                "package_length_cm",
                "package_width_cm",
                "package_height_cm",
                "weight_kg",
                "carton_length_cm",
                "carton_width_cm",
                "carton_height_cm",
                "carton_weight_kg",
                "units_per_carton",
                "is_active",
                "product_image_url",
            }
            assert set(item.keys()) == expected_keys

    def test_internal_fields_not_exposed(self, client, db_session):
        """Ensure id, sort_order, source_file, R2 keys are NOT in response."""
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id))
        assert resp.status_code == 200, resp.text
        body = resp.json()

        if body["data"]:
            item = body["data"][0]
            forbidden = {
                "id",
                "sort_order",
                "source_file",
                "sku_factory_info",
                "product_image_r2_key",
                "fnsku_label_r2_key",
            }
            assert forbidden.isdisjoint(item.keys())


class TestSkuInfoFiltering:
    """Filter and pagination behaviour."""

    def test_is_active_filter(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id, is_active="true"))
        assert resp.status_code == 200, resp.text
        for item in resp.json()["data"]:
            assert item["is_active"] is True

    def test_sku_search_filter(self, client, db_session):
        """If there are SKUs in the DB, search by partial name returns subset."""
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        # Get first SKU name to search for
        first_sku = db_session.execute(
            select(SkuRecord.sku)
            .where(SkuRecord.project_id == project.id, SkuRecord.is_active.is_(True))
            .limit(1)
        ).scalar_one_or_none()
        if first_sku is None:
            pytest.skip("no active SKU records for project")

        # Search with first 3 chars
        resp = client.get(_sku_url(project.id, sku=first_sku[:3]))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["data"]) >= 1
        for item in body["data"]:
            assert first_sku[:3].lower() in item["sku"].lower()

    def test_pagination_limit(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id, limit="2"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["data"]) <= 2

    def test_include_total(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id, include_total="true"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] is not None
        assert isinstance(body["total"], int)
        assert body["total"] >= len(body["data"])

    def test_country_filter(self, client, db_session):
        project = _first_project(db_session)
        if project is None:
            pytest.skip("no project in test DB")

        resp = client.get(_sku_url(project.id, country="US"))
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["country"] == "US"
        for item in body["data"]:
            assert item["country"] == "US"
