"""Tests for the inventory-ledger ``?period=`` syntax unification (BEL-370 P1 #4).

Covers:
  * ``resolve_period_inputs`` (shared helper) — period resolution + mutual
    exclusion + full-month detection for integrity eligibility
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
# resolve_period_inputs — period mode (full month → integrity eligible)
# ---------------------------------------------------------------------------


class TestPeriodFullMonth:
    """period=last_month resolves to the full previous calendar month.

    The shared helper should mark this as integrity-eligible because the
    resolved window is a full calendar month (start.day == 1 and end is
    the last day of that month).
    """

    def test_last_month_marks_integrity_eligible(self):
        # today=2026-07-15 → T-1=2026-07-14 (mid-month).
        # last_month → (2026-06-01, 2026-06-30).
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            report_month=None,
            start_date=None,
            end_date=None,
            period="last_month",
            today=fake_today,
        )

        assert (start, end) == (date(2026, 6, 1), date(2026, 6, 30))
        assert report_month == date(2026, 6, 1)

    def test_this_month_mid_month_not_integrity_eligible(self):
        """this_month when T-1 is mid-month resolves to (month_start, T-1) —
        NOT a full calendar month, so integrity should be skipped."""
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            report_month=None,
            start_date=None,
            end_date=None,
            period="this_month",
            today=fake_today,
        )

        assert start == date(2026, 7, 1)
        assert end == date(2026, 7, 14)
        assert report_month is None  # partial month → no integrity


# ---------------------------------------------------------------------------
# resolve_period_inputs — period mode (partial → not integrity eligible)
# ---------------------------------------------------------------------------


class TestPeriodPartialMonth:
    """Relative aliases like 7d / 30d resolve to partial windows.

    These should NEVER be marked as integrity-eligible, regardless of how
    the window aligns to a calendar month.
    """

    def test_7d_not_integrity_eligible(self):
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            report_month=None,
            start_date=None,
            end_date=None,
            period="7d",
            today=fake_today,
        )

        assert (start, end) == (date(2026, 7, 8), date(2026, 7, 14))
        assert report_month is None

    def test_30d_not_integrity_eligible(self):
        fake_today = date(2026, 7, 14)

        start, end, report_month = resolve_period_inputs(
            report_month=None,
            start_date=None,
            end_date=None,
            period="30d",
            today=fake_today,
        )

        assert (start, end) == (date(2026, 6, 15), date(2026, 7, 14))
        assert report_month is None


# ---------------------------------------------------------------------------
# resolve_period_inputs — mutual exclusion
# ---------------------------------------------------------------------------


class TestMutualExclusion:
    """``period`` is mutually exclusive with report_month / start_date / end_date."""

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"report_month": "2026-06-01"},
            {"start_date": date(2026, 6, 1)},
            {"end_date": date(2026, 6, 30)},
            {"start_date": date(2026, 6, 1), "end_date": date(2026, 6, 30)},
        ],
    )
    def test_period_with_explicit_date_raises_400(self, kwargs):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                report_month=kwargs.get("report_month"),
                start_date=kwargs.get("start_date"),
                end_date=kwargs.get("end_date"),
                period="last_month",
            )
        assert exc_info.value.status_code == 400
        assert "cannot be combined" in str(exc_info.value.detail)


# ---------------------------------------------------------------------------
# resolve_period_inputs — invalid period
# ---------------------------------------------------------------------------


class TestInvalidPeriod:
    def test_unknown_alias_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                report_month=None,
                start_date=None,
                end_date=None,
                period="foo",
            )
        assert exc_info.value.status_code == 400
        assert "period must be one of" in str(exc_info.value.detail)

    def test_custom_without_start_date_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                report_month=None,
                start_date=None,
                end_date=None,
                period="custom",
            )
        assert exc_info.value.status_code == 400


# ---------------------------------------------------------------------------
# resolve_period_inputs — legacy mode (report_month / range) preserved
# ---------------------------------------------------------------------------


class TestLegacyPreserved:
    """Legacy input shapes (report_month / start_date+end_date) must keep
    working identically — no behaviour change for existing callers."""

    def test_explicit_report_month_sets_integrity(self):
        start, end, report_month = resolve_period_inputs(
            report_month="2026-06-01",
            start_date=None,
            end_date=None,
            period=None,
        )
        assert start == date(2026, 6, 1)
        assert end == date(2026, 6, 30)
        assert report_month == date(2026, 6, 1)

    def test_explicit_range_keeps_integrity_none(self):
        start, end, report_month = resolve_period_inputs(
            report_month=None,
            start_date=date(2026, 6, 5),
            end_date=date(2026, 6, 25),
            period=None,
        )
        assert (start, end) == (date(2026, 6, 5), date(2026, 6, 25))
        assert report_month is None

    def test_missing_all_inputs_raises_400(self):
        with pytest.raises(HTTPException) as exc_info:
            resolve_period_inputs(
                report_month=None,
                start_date=None,
                end_date=None,
                period=None,
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
