"""Tests for the inventory-ledger ``?period=`` syntax (BEL-370 P1 #4 + P1 #4b).

Covers:
  * ``resolve_period_inputs`` — period resolution + ``period`` required +
    full-month detection for integrity eligibility
  * Month-string aliases (``YYYY-MM`` / ``YYYY-MM-DD``) — resolve to the full
    calendar month and are integrity-eligible
  * Endpoint validation — bad inputs return 400 with actionable messages
    (no DB access needed, runs before any service call)
"""

from __future__ import annotations

from datetime import date

import pytest
from fastapi import HTTPException

from app.api.v1.endpoints.inventory_ledger_common import (
    last_day_of_month,
    resolve_period_inputs,
)


# ---------------------------------------------------------------------------
# resolve_period_inputs — period is required
# ---------------------------------------------------------------------------


class TestPeriodRequired:
    """``period`` is the ONLY input convention — must not be None/empty."""

    def test_missing_period_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period=None,
                start_date=None,
                end_date=None,
            )
        assert exc_info.value.status_code == 400
        assert "period is required" in str(exc_info.value.detail)

    def test_empty_period_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="",
                start_date=None,
                end_date=None,
            )
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# resolve_period_inputs — full-month aliases → integrity eligible
# ---------------------------------------------------------------------------


class TestPeriodFullMonth:
    """Relative aliases like ``last_month`` resolve to a full calendar month.

    The helper marks these as integrity-eligible (start.day == 1 and end is
    the last day of that month).
    """

    def test_last_month_marks_integrity_eligible(self):
        # today=2026-07-14 (T-1) → last_month → (2026-06-01, 2026-06-30).
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            period="last_month",
            start_date=None,
            end_date=None,
            today=fake_today,
        )

        assert (start, end) == (date(2026, 6, 1), date(2026, 6, 30))
        assert report_month == date(2026, 6, 1)

    def test_this_month_mid_month_not_integrity_eligible(self):
        """this_month when T-1 is mid-month resolves to (month_start, T-1) —
        NOT a full calendar month, so integrity should be skipped."""
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            period="this_month",
            start_date=None,
            end_date=None,
            today=fake_today,
        )

        assert start == date(2026, 7, 1)
        assert end == date(2026, 7, 14)
        assert report_month is None  # partial month → no integrity


# ---------------------------------------------------------------------------
# resolve_period_inputs — partial-window aliases → NOT integrity eligible
# ---------------------------------------------------------------------------


class TestPeriodPartialMonth:
    """Relative aliases like 7d / 30d resolve to partial windows.

    These should NEVER be marked as integrity-eligible, regardless of how
    the window aligns to a calendar month.
    """

    def test_7d_not_integrity_eligible(self):
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            period="7d",
            start_date=None,
            end_date=None,
            today=fake_today,
        )

        assert (start, end) == (date(2026, 7, 8), date(2026, 7, 14))
        assert report_month is None

    def test_30d_not_integrity_eligible(self):
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            period="30d",
            start_date=None,
            end_date=None,
            today=fake_today,
        )

        assert (start, end) == (date(2026, 6, 15), date(2026, 7, 14))
        assert report_month is None


# ---------------------------------------------------------------------------
# resolve_period_inputs — month-string aliases (YYYY-MM / YYYY-MM-DD)
# ---------------------------------------------------------------------------


class TestMonthStringAlias:
    """``YYYY-MM`` / ``YYYY-MM-DD`` resolve to the full calendar month.

    These are the values returned by ``/months`` and are the most ergonomic
    way to request a specific month — they don't require ``period=custom``
    + ``start_date`` + ``end_date``.
    """

    def test_yyyy_mm_full_month(self):
        start, end, report_month = resolve_period_inputs(
            period="2026-01",
            start_date=None,
            end_date=None,
        )
        assert (start, end) == (date(2026, 1, 1), date(2026, 1, 31))
        assert report_month == date(2026, 1, 1)  # full month → integrity

    def test_yyyy_mm_dd_ignores_day(self):
        """Day component is ignored — window is always the full month."""
        start, end, report_month = resolve_period_inputs(
            period="2026-01-15",
            start_date=None,
            end_date=None,
        )
        assert start == date(2026, 1, 1)
        assert end == date(2026, 1, 31)
        assert report_month == date(2026, 1, 1)

    def test_yyyy_mm_december_handles_31_days(self):
        start, end, report_month = resolve_period_inputs(
            period="2025-12",
            start_date=None,
            end_date=None,
        )
        assert (start, end) == (date(2025, 12, 1), date(2025, 12, 31))
        assert report_month == date(2025, 12, 1)

    def test_yyyy_mm_february_leap(self):
        start, end, _report_month = resolve_period_inputs(
            period="2024-02",
            start_date=None,
            end_date=None,
        )
        assert (start, end) == (date(2024, 2, 1), date(2024, 2, 29))

    def test_month_alias_with_start_date_raises_400(self):
        """start_date is ONLY valid with period=custom."""
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="2026-01",
                start_date=date(2026, 1, 1),
                end_date=None,
            )
        assert exc_info.value.status_code == 400
        assert "cannot be combined" in str(exc_info.value.detail)


# ---------------------------------------------------------------------------
# resolve_period_inputs — custom range
# ---------------------------------------------------------------------------


class TestCustomRange:
    """``period=custom`` requires start_date + end_date as companions."""

    def test_custom_requires_start_date(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="custom",
                start_date=None,
                end_date=date(2026, 6, 28),
            )
        assert exc_info.value.status_code == 400
        assert "start_date and end_date" in str(exc_info.value.detail)

    def test_custom_valid_range(self):
        start, end, report_month = resolve_period_inputs(
            period="custom",
            start_date=date(2026, 6, 15),
            end_date=date(2026, 6, 28),
        )
        assert (start, end) == (date(2026, 6, 15), date(2026, 6, 28))
        assert report_month is None  # partial span → no integrity

    def test_custom_full_month_is_integrity_eligible(self):
        """Custom range that happens to be a full month IS integrity-eligible."""
        start, end, report_month = resolve_period_inputs(
            period="custom",
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 31),
        )
        assert (start, end) == (date(2026, 1, 1), date(2026, 1, 31))
        assert report_month == date(2026, 1, 1)

    def test_custom_reversed_range_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="custom",
                start_date=date(2026, 6, 28),
                end_date=date(2026, 6, 15),
            )
        assert exc_info.value.status_code == 400
        assert "start_date must be" in str(exc_info.value.detail)


# ---------------------------------------------------------------------------
# resolve_period_inputs — non-custom period rejects start_date / end_date
# ---------------------------------------------------------------------------


class TestStartDateOnlyValidForCustom:
    """start_date / end_date are ONLY valid with period=custom.

    With any other period value, providing them is a 400 — keeps the
    surface small so agents don't drift into multiple calling patterns.
    """

    @pytest.mark.parametrize(
        "period",
        [
            "last_month",
            "this_month",
            "30d",
            "7d",
            "ytd",
            "2026-01",
        ],
    )
    def test_start_date_with_non_custom_period_raises_400(self, period):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period=period,
                start_date=date(2026, 1, 1),
                end_date=None,
            )
        assert exc_info.value.status_code == 400
        assert "cannot be combined" in str(exc_info.value.detail)

    @pytest.mark.parametrize(
        "period",
        [
            "last_month",
            "this_month",
            "30d",
            "ytd",
            "2026-01",
        ],
    )
    def test_end_date_with_non_custom_period_raises_400(self, period):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period=period,
                start_date=None,
                end_date=date(2026, 1, 31),
            )
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# resolve_period_inputs — invalid period
# ---------------------------------------------------------------------------


class TestInvalidPeriod:
    def test_unknown_alias_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="foo",
                start_date=None,
                end_date=None,
            )
        assert exc_info.value.status_code == 400
        assert "period must be one of" in str(exc_info.value.detail)

    def test_invalid_month_string_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="2026-13",
                start_date=None,
                end_date=None,  # month=13
            )
        assert exc_info.value.status_code == 400

    def test_malformed_month_string_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                period="2026/01",
                start_date=None,
                end_date=None,
            )
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# last_day_of_month helper
# ---------------------------------------------------------------------------


class TestLastDayOfMonth:
    def test_january_31_days(self):
        assert last_day_of_month(date(2026, 1, 15)) == date(2026, 1, 31)

    def test_february_non_leap_28_days(self):
        assert last_day_of_month(date(2026, 2, 10)) == date(2026, 2, 28)

    def test_february_leap_29_days(self):
        assert last_day_of_month(date(2024, 2, 10)) == date(2024, 2, 29)

    def test_april_30_days(self):
        assert last_day_of_month(date(2026, 4, 1)) == date(2026, 4, 30)
