"""Unit tests for ``app.utils.period.parse_period``.

Covers:
  * 9 convenience aliases × 3 anchor scenarios (mid-month, month-start, year-start)
  * Custom range parsing (valid / invalid / reversed)
  * Combination errors (alias + start_date / end_date, missing params)

The anchor scenarios are pinned to known dates so we can assert exact
(start_date, end_date) tuples without monkey-patching ``date.today()``.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.utils import period as _period
from app.schemas.external.common import PeriodParseError


# ---------------------------------------------------------------------------
# Convenience aliases — mid-month (most common case, today=2026-06-30 → T-1=2026-06-29)
# ---------------------------------------------------------------------------


class TestMidMonthAnchor:
    """today=2026-06-30 → T-1=2026-06-29 (mid-month)."""

    today = date(2026, 6, 30)
    anchor = date(2026, 6, 29)  # T-1

    def test_7d(self):
        s, e = _period.parse_period("7d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 23), date(2026, 6, 29))

    def test_14d(self):
        s, e = _period.parse_period("14d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 16), date(2026, 6, 29))

    def test_28d(self):
        s, e = _period.parse_period("28d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 2), date(2026, 6, 29))

    def test_30d(self):
        s, e = _period.parse_period("30d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 5, 31), date(2026, 6, 29))

    def test_60d(self):
        s, e = _period.parse_period("60d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 5, 1), date(2026, 6, 29))

    def test_90d(self):
        s, e = _period.parse_period("90d", None, None, today=self.anchor)
        # 2026-06-29 minus 89 days = 2026-04-01
        assert (s, e) == (date(2026, 4, 1), date(2026, 6, 29))

    def test_this_month(self):
        s, e = _period.parse_period("this_month", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 1), date(2026, 6, 29))

    def test_last_month(self):
        s, e = _period.parse_period("last_month", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 5, 1), date(2026, 5, 31))

    def test_ytd(self):
        s, e = _period.parse_period("ytd", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 1, 1), date(2026, 6, 29))


# ---------------------------------------------------------------------------
# Cross-month anchor — today=2026-07-01 → T-1=2026-06-30 (T-1 fell in previous month)
# ---------------------------------------------------------------------------


class TestCrossMonthAnchor:
    """today=2026-07-01 → T-1=2026-06-30. ``this_month`` and ``ytd`` should
    degenerate to the previous full month / year.
    """

    today = date(2026, 7, 1)
    anchor = date(2026, 6, 30)  # T-1 in previous month

    def test_7d(self):
        s, e = _period.parse_period("7d", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 24), date(2026, 6, 30))

    def test_this_month_degenerate_to_previous_full_month(self):
        """When T-1 falls in the previous calendar month, ``this_month`` returns
        the *previous* full month rather than an empty/reversed window."""
        s, e = _period.parse_period("this_month", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 6, 1), date(2026, 6, 30))

    def test_last_month_means_previous_calendar_month(self):
        """When anchor (T-1) is in late June and ``today`` argument carries
        that anchor, ``last_month`` resolves to May 1..31."""
        s, e = _period.parse_period("last_month", None, None, today=self.anchor)
        assert (s, e) == (date(2026, 5, 1), date(2026, 5, 31))

    def test_ytd_degenerate_to_previous_year(self):
        """At year-start T-1 falls in Dec of previous year, so ytd returns full prev year."""
        # Override anchor to year boundary
        anchor = date(2025, 12, 31)
        s, e = _period.parse_period("ytd", None, None, today=anchor)
        assert (s, e) == (date(2025, 1, 1), date(2025, 12, 31))


# ---------------------------------------------------------------------------
# Cross-year anchor — today=2026-01-01 → T-1=2025-12-31
# ---------------------------------------------------------------------------


class TestCrossYearAnchor:
    """today=2026-01-01 → T-1=2025-12-31."""

    today = date(2026, 1, 1)
    anchor = date(2025, 12, 31)

    def test_7d(self):
        s, e = _period.parse_period("7d", None, None, today=self.anchor)
        assert (s, e) == (date(2025, 12, 25), date(2025, 12, 31))

    def test_30d(self):
        s, e = _period.parse_period("30d", None, None, today=self.anchor)
        assert (s, e) == (date(2025, 12, 2), date(2025, 12, 31))

    def test_this_month_is_december(self):
        s, e = _period.parse_period("this_month", None, None, today=self.anchor)
        assert (s, e) == (date(2025, 12, 1), date(2025, 12, 31))

    def test_last_month_is_november(self):
        s, e = _period.parse_period("last_month", None, None, today=self.anchor)
        assert (s, e) == (date(2025, 11, 1), date(2025, 11, 30))

    def test_ytd_is_full_previous_year(self):
        s, e = _period.parse_period("ytd", None, None, today=self.anchor)
        assert (s, e) == (date(2025, 1, 1), date(2025, 12, 31))


# ---------------------------------------------------------------------------
# Custom range
# ---------------------------------------------------------------------------


class TestCustomRange:
    today = date(2026, 6, 30)

    def test_valid_range(self):
        s, e = _period.parse_period(
            "custom", "2026-06-15", "2026-06-28", today=self.today,
        )
        assert (s, e) == (date(2026, 6, 15), date(2026, 6, 28))

    def test_same_day(self):
        s, e = _period.parse_period(
            "custom", "2026-06-15", "2026-06-15", today=self.today,
        )
        assert (s, e) == (date(2026, 6, 15), date(2026, 6, 15))

    def test_missing_start_date(self):
        with pytest.raises(PeriodParseError, match="start_date"):
            _period.parse_period("custom", None, "2026-06-28", today=self.today)

    def test_missing_end_date(self):
        with pytest.raises(PeriodParseError, match="start_date"):
            _period.parse_period("custom", "2026-06-15", None, today=self.today)

    def test_reversed_range(self):
        with pytest.raises(PeriodParseError, match="start_date must be"):
            _period.parse_period(
                "custom", "2026-06-28", "2026-06-15", today=self.today,
            )

    def test_garbage_start_date(self):
        with pytest.raises(PeriodParseError, match="start_date"):
            _period.parse_period(
                "custom", "garbage", "2026-06-28", today=self.today,
            )

    def test_garbage_end_date(self):
        with pytest.raises(PeriodParseError, match="end_date"):
            _period.parse_period(
                "custom", "2026-06-15", "not-a-date", today=self.today,
            )


# ---------------------------------------------------------------------------
# Misc validation
# ---------------------------------------------------------------------------


class TestValidation:
    today = date(2026, 6, 30)

    def test_missing_period(self):
        with pytest.raises(PeriodParseError, match="period is required"):
            _period.parse_period(None, None, None, today=self.today)

    def test_empty_period(self):
        with pytest.raises(PeriodParseError, match="period is required"):
            _period.parse_period("", None, None, today=self.today)

    def test_unknown_alias(self):
        with pytest.raises(PeriodParseError, match="period must be one of"):
            _period.parse_period("foo", None, None, today=self.today)

    def test_alias_combined_with_start_date(self):
        with pytest.raises(PeriodParseError, match="cannot be combined"):
            _period.parse_period(
                "7d", "2026-06-15", None, today=self.today,
            )

    def test_alias_combined_with_end_date(self):
        with pytest.raises(PeriodParseError, match="cannot be combined"):
            _period.parse_period(
                "7d", None, "2026-06-15", today=self.today,
            )

    def test_alias_uppercase_normalised(self):
        """Caller can pass '7D' or '14D'; we lowercase before lookup."""
        s, e = _period.parse_period("7D", None, None, today=date(2026, 6, 29))
        assert (s, e) == (date(2026, 6, 23), date(2026, 6, 29))

    def test_alias_whitespace_trimmed(self):
        s, e = _period.parse_period("  7d  ", None, None, today=date(2026, 6, 29))
        assert (s, e) == (date(2026, 6, 23), date(2026, 6, 29))


# ---------------------------------------------------------------------------
# Whitelist sanity (not part of parse_period, but useful regression)
# ---------------------------------------------------------------------------


def test_period_aliases_constant():
    assert _period.PERIOD_ALIASES == frozenset({
        "7d", "14d", "28d", "30d", "60d", "90d",
        "this_month", "last_month", "ytd",
        "custom",
    })