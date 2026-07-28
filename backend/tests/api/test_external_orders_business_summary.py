"""Endpoint integration tests for Phase 2 external API endpoints.

Tests for:
- GET /api/v1/external/projects/{project_id}/orders/summary
- GET /api/v1/external/projects/{project_id}/business-summary
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


def _orders_summary_url(project_id: int) -> str:
    return f'/api/v1/external/projects/{project_id}/orders/summary'


def _business_summary_url(project_id: int) -> str:
    return f'/api/v1/external/projects/{project_id}/business-summary'


def _get_first_project_id(db_session: Session) -> int | None:
    from app.models import Project
    from sqlalchemy import select
    first = db_session.execute(select(Project).limit(1)).scalar_one_or_none()
    return first.id if first else None


# =============================================================================
# Orders Summary Tests
# =============================================================================

class TestOrdersSummaryEndpoint:
    def test_missing_project_returns_404(self, client):
        resp = client.get(
            _orders_summary_url(99999999) + '?period=7d&country=US'
        )
        assert resp.status_code == 404, resp.text
        assert 'not found' in resp.json()['detail'].lower()

    def test_missing_period_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_orders_summary_url(project_id) + '?country=US')
        assert resp.status_code == 400, resp.text
        assert 'period' in resp.json()['detail'].lower()

    def test_missing_country_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_orders_summary_url(project_id) + '?period=7d')
        assert resp.status_code == 400, resp.text
        assert 'country' in resp.json()['detail'].lower()

    def test_invalid_country_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_orders_summary_url(project_id) + '?period=7d&country=ZZ')
        assert resp.status_code == 400, resp.text

    def test_unknown_period_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_orders_summary_url(project_id) + '?period=foo&country=US')
        assert resp.status_code == 400, resp.text
        assert 'period must be one of' in resp.json()['detail'].lower()

    def test_alias_combined_with_start_date_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=7d&start_date=2026-06-15&end_date=2026-06-30&country=US'
        )
        assert resp.status_code == 400, resp.text
        assert 'cannot be combined' in resp.json()['detail'].lower()

    def test_custom_missing_end_date_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=custom&start_date=2026-06-15&country=US'
        )
        assert resp.status_code == 400, resp.text

    def test_valid_request_returns_200_with_correct_shape(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        # Far-future period so we expect 200 + empty list (no current file).
        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert 'data' in body
        assert 'summary' in body
        assert 'aggregate' in body
        assert isinstance(body['data'], list)

    def test_aggregate_false_returns_no_aggregate(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US&aggregate=false'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # aggregate=false 只关 aggregate 字段；summary 端点无条件填充(summary=agg)，始终返回
        assert body.get('aggregate') is None

    def test_include_cancelled_param(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US&include_cancelled=true'
        )
        assert resp.status_code == 200, resp.text

    def test_include_pending_param(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US&include_pending=false'
        )
        assert resp.status_code == 200, resp.text

    def test_limit_too_large_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _orders_summary_url(project_id)
            + '?period=7d&country=US&limit=50001'
        )
        assert resp.status_code == 422, resp.text


# =============================================================================
# Business Summary Tests
# =============================================================================

class TestBusinessSummaryEndpoint:
    def test_missing_project_returns_404(self, client):
        resp = client.get(
            _business_summary_url(99999999) + '?period=7d&country=US'
        )
        assert resp.status_code == 404, resp.text
        assert 'not found' in resp.json()['detail'].lower()

    def test_missing_period_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_business_summary_url(project_id) + '?country=US')
        assert resp.status_code == 400, resp.text
        assert 'period' in resp.json()['detail'].lower()

    def test_missing_country_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_business_summary_url(project_id) + '?period=7d')
        assert resp.status_code == 400, resp.text
        assert 'country' in resp.json()['detail'].lower()

    def test_invalid_country_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_business_summary_url(project_id) + '?period=7d&country=ZZ')
        assert resp.status_code == 400, resp.text

    def test_unknown_period_returns_400(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(_business_summary_url(project_id) + '?period=foo&country=US')
        assert resp.status_code == 400, resp.text
        assert 'period must be one of' in resp.json()['detail'].lower()

    def test_valid_request_returns_200_with_correct_shape(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        # Far-future period so we expect 200 + empty list (no current file).
        resp = client.get(
            _business_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert 'detail' in body
        assert 'aggregate' in body
        assert 'summary' in body
        assert isinstance(body['detail'], list)

    def test_response_contains_required_aggregate_fields(self, client, db_session):
        project_id = _get_first_project_id(db_session)
        if project_id is None:
            pytest.skip('no project in test DB')

        resp = client.get(
            _business_summary_url(project_id)
            + '?period=custom&start_date=2099-01-01&end_date=2099-01-14&country=US'
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        agg = body.get('aggregate', {})
        required_fields = [
            'total_asins', 'total_page_views', 'total_sessions',
            'total_units_ordered', 'total_sales_amount',
            'total_cost', 'total_profit', 'overall_cvr', 'overall_profit_rate'
        ]
        for field in required_fields:
            assert field in agg, f"Missing aggregate field: {field}"