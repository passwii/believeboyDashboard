"""Unit tests for ``app.api.v1.endpoints.external._whitelist.parse_order_by``."""
from __future__ import annotations

import pytest

from app.api.v1.endpoints.external import _whitelist
from app.models import AdUploadCampaignRow, AdUploadBudgetRow
from app.schemas.external.common import PeriodParseError


class TestParseOrderBy:
    def test_valid_column_default_desc(self):
        col, direction = _whitelist.parse_order_by(
            "report_end_date", "desc", model=AdUploadCampaignRow,
        )
        assert col is AdUploadCampaignRow.report_end_date
        assert direction == "desc"

    def test_valid_column_asc(self):
        col, direction = _whitelist.parse_order_by(
            "spend", "asc", model=AdUploadCampaignRow,
        )
        assert col is AdUploadCampaignRow.spend
        assert direction == "asc"

    def test_unknown_column(self):
        with pytest.raises(PeriodParseError, match="order_by must be one of"):
            _whitelist.parse_order_by(
                "secret_field", "desc", model=AdUploadCampaignRow,
            )

    def test_unknown_direction(self):
        with pytest.raises(PeriodParseError, match="order_dir must be"):
            _whitelist.parse_order_by(
                "spend", "sideways", model=AdUploadCampaignRow,
            )

    def test_different_table_whitelist(self):
        """Budget table exposes different columns than campaign."""
        # budget_utilization_rate is in budget whitelist
        col, _ = _whitelist.parse_order_by(
            "budget_utilization_rate", "desc", model=AdUploadBudgetRow,
        )
        assert col is AdUploadBudgetRow.budget_utilization_rate

    def test_column_unique_to_one_table(self):
        """budget_utilization_rate is in budget but NOT in campaign."""
        # Should succeed on budget
        _whitelist.parse_order_by(
            "budget_utilization_rate", "desc", model=AdUploadBudgetRow,
        )
        # Should fail on campaign
        with pytest.raises(PeriodParseError):
            _whitelist.parse_order_by(
                "budget_utilization_rate", "desc", model=AdUploadCampaignRow,
            )


def test_whitelist_covers_common_columns():
    """Spot-check that every documented common column is exposed somewhere."""
    expected_campaign_cols = {
        "id", "source_file_id", "report_start_date", "report_end_date",
        "campaign_name", "spend", "impressions", "clicks",
        "sales_7d", "orders_7d", "roas", "acos",
    }
    actual = set(_whitelist.ROW_WHITELIST[AdUploadCampaignRow].keys())
    assert expected_campaign_cols.issubset(actual)

    expected_budget_cols = {
        "id", "source_file_id", "report_start_date", "report_end_date",
        "campaign_name", "budget", "suggested_budget",
        "budget_utilization_rate", "missed_impressions_max", "missed_sales_max",
    }
    actual = set(_whitelist.ROW_WHITELIST[AdUploadBudgetRow].keys())
    assert expected_budget_cols.issubset(actual)