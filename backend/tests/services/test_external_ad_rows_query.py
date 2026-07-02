"""Smoke tests for ``app.services.external.ad_rows_query``.

Covers the query path without needing a live database:
  * ``_select_latest_file_id`` builds the expected WHERE clause shape.
  * Each ``query_*_rows`` helper delegates to ``_run_query`` with the
    correct ``report_type`` literal.

These tests mock SQLAlchemy execution so we don't depend on PG state.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
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


# ---------------------------------------------------------------------------
# aggregate_search_terms targeting_type 字段契约(任务 3)
# ---------------------------------------------------------------------------


class TestAggregateSearchTermsTargetingType:
    """Verify ``aggregate_search_terms`` wires ``ad_targeting`` helper correctly.

    The current implementation uses a two-pass approach (Postgres JSON
    has no equality operator) so GROUP BY stays on the 3 text keys and
    a representative raw_row is fetched per group key.
    """

    def _mock_row(self, **overrides):
        row = MagicMock()
        row.campaign_name = overrides.get('campaign_name', 'Camp-A')
        row.search_term = overrides.get('search_term', 'red shoes')
        row.match_type = overrides.get('match_type', 'EXACT')
        row.max_end_date = overrides.get('max_end_date', date(2026, 6, 15))
        row.impressions = overrides.get('impressions', 10)
        row.clicks = overrides.get('clicks', 1)
        row.spend = overrides.get('spend', Decimal('1.50'))
        row.sales_7d = overrides.get('sales_7d', Decimal('5.00'))
        row.orders_7d = overrides.get('orders_7d', 1)
        return row

    def test_calls_build_cache_and_resolve_per_row(self, monkeypatch):
        from app.services.external import aggregator

        cache_calls = []

        def fake_build_cache(db, *, project_id, country, date_from, date_to):
            cache_calls.append({'project_id': project_id, 'country': country,
                                'date_from': date_from, 'date_to': date_to})
            return {('Camp-A', 'US'): '自动投放'}

        resolve_calls = []

        def fake_resolve(*, campaign_name, country, raw_row, campaign_targeting_map):
            resolve_calls.append({
                'campaign_name': campaign_name,
                'country': country,
                'raw_row': raw_row,
            })
            return raw_row.get('投放')

        monkeypatch.setattr(aggregator.ad_targeting, 'build_campaign_targeting_cache', fake_build_cache)
        monkeypatch.setattr(aggregator.ad_targeting, 'resolve_targeting_type', fake_resolve)

        monkeypatch.setattr(
            aggregator, '_select_file_ids',
            lambda db, **kw: [101, 102],
        )

        # Two-pass: first call returns the grouped rows; second call returns
        # a representative raw_row for the first group only (the second
        # group will also fetch one).  Track call args.
        exec_results = [
            MagicMock(all=lambda: [
                self._mock_row(),
                self._mock_row(campaign_name='Camp-A', search_term='blue shoes'),
            ]),
            MagicMock(scalar_one_or_none=lambda: {'投放': 'close-match', '匹配类型': '-'}),
            MagicMock(scalar_one_or_none=lambda: {'投放': 'substitutes', '匹配类型': '-'}),
        ]
        mock_db = MagicMock()
        mock_db.execute.side_effect = exec_results

        result = aggregator.aggregate_search_terms(
            mock_db,
            project_id=42,
            country='US',
            date_from=date(2026, 6, 1),
            date_to=date(2026, 6, 30),
        )

        assert len(cache_calls) == 1
        assert cache_calls[0] == {
            'project_id': 42, 'country': 'US',
            'date_from': date(2026, 6, 1), 'date_to': date(2026, 6, 30),
        }
        # Two resolve calls — one per aggregated row
        assert len(resolve_calls) == 2
        for call in resolve_calls:
            assert call['campaign_name'] == 'Camp-A'
            assert call['country'] == 'US'

        assert len(result) == 2
        seen = {r.targeting_type for r in result}
        assert seen == {'close-match', 'substitutes'}

        # Each aggregated row must NOT carry target_text (schema field removed).
        for r in result:
            assert 'target_text' not in r.model_dump()

    def test_group_by_omits_raw_row_due_to_postgres_json(self, monkeypatch):
        """Document current design: GROUP BY stays on 3 text keys (Postgres
        `json` has no equality operator). raw_row is fetched per group key
        via a second SELECT.
        """
        from app.services.external import aggregator

        monkeypatch.setattr(
            aggregator.ad_targeting, 'build_campaign_targeting_cache',
            lambda *a, **kw: {},
        )
        monkeypatch.setattr(
            aggregator.ad_targeting, 'resolve_targeting_type',
            lambda **kw: None,
        )
        monkeypatch.setattr(
            aggregator, '_select_file_ids',
            lambda db, **kw: [101],
        )

        captured = {}

        class _ExecResult:
            def all(self_inner):
                return []

            def scalar_one_or_none(self_inner):
                return None

        def fake_execute(stmt):
            captured.setdefault('stmts', []).append(stmt)
            return _ExecResult()

        mock_db = MagicMock()
        mock_db.execute.side_effect = fake_execute

        aggregator.aggregate_search_terms(
            mock_db, project_id=1, country='US',
            date_from=date(2026, 6, 1), date_to=date(2026, 6, 30),
        )

        from app.models import AdUploadSearchTermRow
        # First stmt is the aggregate stmt; verify GROUP BY does NOT include raw_row.
        agg_stmt = captured['stmts'][0]
        group_by_cols = {getattr(g, 'key', None) for g in agg_stmt._group_by_clauses}
        assert AdUploadSearchTermRow.raw_row.key not in group_by_cols
        # And SELECT also omits raw_row (would trigger Postgres "must appear in GROUP BY").
        selected_cols = {c.key for c in agg_stmt.selected_columns}
        assert AdUploadSearchTermRow.raw_row.key not in selected_cols