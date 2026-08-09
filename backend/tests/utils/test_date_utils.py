"""Tests for app.utils.date_utils.build_yoy_period (BLF-570 同比窗口).

Covers leap-year 2/29 → 2/28 clamping, cross-year windows, and ordinary months.
Also sanity-checks build_previous_period (环比窗口) which pre-dates BLF-570.
"""

from __future__ import annotations

from datetime import date

from app.utils.date_utils import build_previous_period, build_yoy_period

# ─── build_yoy_period：普通月份 ───────────────────────────────────────────────


def test_yoy_normal_month():
    assert build_yoy_period(date(2026, 3, 1), date(2026, 3, 31)) == (
        date(2025, 3, 1),
        date(2025, 3, 31),
    )


def test_yoy_cross_year_window():
    assert build_yoy_period(date(2026, 1, 15), date(2026, 2, 14)) == (
        date(2025, 1, 15),
        date(2025, 2, 14),
    )


def test_yoy_single_day():
    assert build_yoy_period(date(2026, 6, 20), date(2026, 6, 20)) == (
        date(2025, 6, 20),
        date(2025, 6, 20),
    )


# ─── build_yoy_period：闰年 2/29 边界 ─────────────────────────────────────────


def test_yoy_leap_feb29_clamps_to_feb28():
    """2024-02-29 的同比窗口钳制到 2023-02-28（去年非闰年）。"""
    assert build_yoy_period(date(2024, 2, 29), date(2024, 2, 29)) == (
        date(2023, 2, 28),
        date(2023, 2, 28),
    )


def test_yoy_leap_feb_full_month():
    """2024-02-01..29 → 2023-02-01..28（去年 2 月只有 28 天）。"""
    assert build_yoy_period(date(2024, 2, 1), date(2024, 2, 29)) == (
        date(2023, 2, 1),
        date(2023, 2, 28),
    )


def test_yoy_non_leap_feb_points_at_leap_feb():
    """2025-02-01..28（平年）→ 2024-02-01..28（2024 是闰年但 28 日合法）。"""
    assert build_yoy_period(date(2025, 2, 1), date(2025, 2, 28)) == (
        date(2024, 2, 1),
        date(2024, 2, 28),
    )


def test_yoy_matches_legacy_monthly_impl():
    """与收编前 report_builder_monthly._get_yoy_month 的整月行为一致。

    旧实现：yoy_start = month_start 平移年份；yoy_end = yoy_start 所在月
    的 day=min(month_end.day, 当月最大天数)。对整月窗口两者输出相同。
    """
    from calendar import monthrange

    def legacy(month_start: date, month_end: date) -> tuple[date, date]:
        yoy_start = month_start.replace(year=month_start.year - 1)
        max_day = monthrange(yoy_start.year, yoy_start.month)[1]
        yoy_end_day = min(month_end.day, max_day)
        return yoy_start, yoy_start.replace(day=yoy_end_day)

    cases = [
        (date(2026, 3, 1), date(2026, 3, 31)),
        (date(2024, 2, 1), date(2024, 2, 29)),
        (date(2025, 2, 1), date(2025, 2, 28)),
        (date(2026, 12, 1), date(2026, 12, 31)),
    ]
    for start, end in cases:
        assert build_yoy_period(start, end) == legacy(start, end)


# ─── build_previous_period（环比窗口，已有函数回归） ─────────────────────────


def test_previous_period_same_length_shift():
    assert build_previous_period(date(2026, 3, 10), date(2026, 3, 16)) == (
        date(2026, 3, 3),
        date(2026, 3, 9),
    )


def test_previous_period_none_input():
    assert build_previous_period(None, None) == (None, None)
