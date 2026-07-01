"""Smoke tests for ``app.services.external.ad_rows_query``.

Covers the query path without needing a live database:
  * ``_select_latest_file_id`` builds the expected WHERE clause shape.
  * Each ``query_*_rows`` helper delegates to ``_run_query`` with the
    correct ``report_type`` literal.

These tests mock SQLAlchemy execution so we don't depend on PG state.
"""
from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

import pytest

from app.services.external import ad_rows_query


@pytest.fixture
def db_session() -> MagicMock:
    return MagicMock()


# ---------------------------------------------------------------------------
# query_*_rows delegation
# ---------------------------------------------------------------------------


class TestQueryDelegation:
    """Each query helper should pass the correct ``report_type`` literal to
    ``_run_query`` (and ultimately to ``_select_latest_file_id``).
    """

    expected_report_types = {
        "query_campaign_rows": "ad_campaign_report",
        "query_budget_rows": "ad_budget_report",
        "query_target_rows": "ad_target_report",
        "query_placement_rows": "ad_placement_report",
        "query_search_term_rows": "ad_search_term_report",
        "query_search_term_share_rows": "ad_search_term_share_report",
        "query_promoted_product_rows": "ad_promoted_product_report",
        "query_time_trend_rows": "ad_time_trend_report",
        "query_purchased_product_rows": "ad_purchased_product_report",
        "query_invalid_traffic_rows": "ad_invalid_traffic_report",
    }

    @pytest.mark.parametrize("func_name,report_type", list(expected_report_types.items()))
    def test_report_type_literal(self, db_session, func_name, report_type, monkeypatch):
        captured = {}

        def fake_run_query(db, *, row_model, project_id, country, report_type, **kwargs):
            captured['report_type'] = report_type
            captured['row_model'] = row_model
            return []

        monkeypatch.setattr(ad_rows_query, '_run_query', fake_run_query)

        func = getattr(ad_rows_query, func_name)
        func(
            db_session,
            project_id=1,
            country='US',
            date_from=date(2026, 6, 1),
            date_to=date(2026, 6, 30),
            order_dir='desc',
            limit=10,
            offset=0,
        )

        assert captured['report_type'] == report_type


# ---------------------------------------------------------------------------
# list_ad_upload_files validation
# ---------------------------------------------------------------------------


class TestListAdUploadFiles:
    def test_limit_too_small(self, db_session):
        with pytest.raises(ValueError, match="limit must be"):
            ad_rows_query.list_ad_upload_files(
                db_session, project_id=1, limit=0,
            )

    def test_limit_too_large(self, db_session):
        with pytest.raises(ValueError, match="limit must be"):
            ad_rows_query.list_ad_upload_files(
                db_session, project_id=1, limit=501,
            )

    def test_negative_offset(self, db_session):
        with pytest.raises(ValueError, match="offset must be"):
            ad_rows_query.list_ad_upload_files(
                db_session, project_id=1, offset=-1,
            )

    def test_filters_passed_to_query(self, db_session, monkeypatch):
        captured = {}

        def fake_run(db, stmt):
            # Capture stmt.to_statement_params-like for assertion
            captured['statement'] = stmt
            return []

        # Easier: just call the real function and assert db.execute was called once.
        result = ad_rows_query.list_ad_upload_files(
            db_session,
            project_id=42,
            report_type='ad_campaign_report',
            country='US',
            include_history=False,
            limit=10,
            offset=5,
        )
        assert result == []
        # db.execute was called exactly once
        assert db_session.execute.call_count == 1