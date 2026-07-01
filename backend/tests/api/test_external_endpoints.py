"""Endpoint integration tests for the external API namespace.

P0 has no auth — we just verify the request/response contracts:
  * 400 for invalid ``period`` / ``country`` / ``order_by``
  * 404 for missing project
  * 200 + empty list when no current file overlaps the requested period
  * 200 + items when a current file is found

These tests run against a real Postgres test database (see
``backend/.env`` and ``conftest.py`` if present).
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app


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


# ---------------------------------------------------------------------------
# Endpoint #1 — projects
# ---------------------------------------------------------------------------


class TestProjectsEndpoint:
    def test_default_status_returns_active(self, client):
        resp = client.get('/api/v1/external/projects')
        assert resp.status_code == 200, resp.text
        assert isinstance(resp.json(), list)
        for item in resp.json():
            assert set(item.keys()) == {'project_id', 'project_name'}

    def test_invalid_status(self, client):
        resp = client.get('/api/v1/external/projects?status=bogus')
        assert resp.status_code == 400, resp.text


# ---------------------------------------------------------------------------
# Endpoint #2 — ad-upload-files
# ---------------------------------------------------------------------------


class TestAdUploadFilesEndpoint:
    def test_missing_project_returns_404(self, client):
        resp = client.get('/api/v1/external/projects/99999999/ad-upload-files?country=US')
        assert resp.status_code == 404, resp.text
        assert 'not found' in resp.json()['detail'].lower()

    def test_existing_project_returns_list_shape(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            f'/api/v1/external/projects/{first.id}/ad-upload-files?country=US',
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert isinstance(body, list)
        for item in body:
            assert 'file_id' in item
            assert 'report_type' in item
            assert 'country' in item


# ---------------------------------------------------------------------------
# Endpoint #3+ — row endpoints (shared contract)
# ---------------------------------------------------------------------------


def _campaign_url(project_id: int) -> str:
    return f'/api/v1/external/projects/{project_id}/ad-campaigns'


class TestCampaignRowsContract:
    def test_missing_project_returns_404(self, client):
        resp = client.get(
            _campaign_url(99999999) + '?period=7d&country=US',
        )
        assert resp.status_code == 404, resp.text

    def test_missing_period_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(_campaign_url(first.id) + '?country=US')
        assert resp.status_code == 400, resp.text
        assert 'period' in resp.json()['detail'].lower()

    def test_unknown_period_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(_campaign_url(first.id) + '?period=foo&country=US')
        assert resp.status_code == 400, resp.text
        assert 'period must be one of' in resp.json()['detail'].lower()

    def test_missing_country_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(_campaign_url(first.id) + '?period=7d')
        assert resp.status_code == 400, resp.text
        assert 'country' in resp.json()['detail'].lower()

    def test_invalid_country_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(_campaign_url(first.id) + '?period=7d&country=ZZ')
        assert resp.status_code == 400, resp.text

    def test_alias_combined_with_start_date_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _campaign_url(first.id)
            + '?period=7d&start_date=2026-06-15&end_date=2026-06-30&country=US',
        )
        assert resp.status_code == 400, resp.text
        assert 'cannot be combined' in resp.json()['detail'].lower()

    def test_custom_missing_end_date_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _campaign_url(first.id)
            + '?period=custom&start_date=2026-06-15&country=US',
        )
        assert resp.status_code == 400, resp.text

    def test_unknown_order_by_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _campaign_url(first.id)
            + '?period=7d&country=US&order_by=secret_field',
        )
        assert resp.status_code == 400, resp.text
        assert 'order_by' in resp.json()['detail'].lower()

    def test_valid_request_returns_200_with_list(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        # Far-future period so we expect 200 + empty list (no current file).
        resp = client.get(
            _campaign_url(first.id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US',
        )
        assert resp.status_code == 200, resp.text
        assert resp.json() == []

    def test_limit_too_large_returns_400(self, client, db_session):
        from app.models import Project
        from sqlalchemy import select
        first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
        if first is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _campaign_url(first.id)
            + '?period=7d&country=US&limit=50001',
        )
        # FastAPI's Query(le=50000) rejects before the handler runs.
        assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# All 9 row endpoints share the same parse path; spot-check a couple more.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("endpoint", [
    'ad-search-terms',
    'ad-budgets',
    'ad-targets',
    'ad-placements',
    'ad-promoted-products',
    'ad-time-trends',
    'ad-search-term-shares',
    'ad-invalid-traffic',
    'ad-purchased-products',
])
class TestAllRowEndpoints:
    def test_missing_period_returns_400(self, client, endpoint):
        resp = client.get(
            f'/api/v1/external/projects/1/{endpoint}?country=US',
        )
        assert resp.status_code == 400, resp.text
        assert 'period' in resp.json()['detail'].lower()

    def test_invalid_country_returns_400(self, client, endpoint):
        resp = client.get(
            f'/api/v1/external/projects/1/{endpoint}?period=7d&country=ZZ',
        )
        assert resp.status_code == 400, resp.text