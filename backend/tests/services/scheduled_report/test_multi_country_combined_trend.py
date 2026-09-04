"""BLF-813：多站点报告开头「整体销售情况」合并柱状图测试。

多站点（日报/周报/月报）HTML 正文开头应先出现把各站点销量趋势柱状图
合并后的整体柱状图 section，随后保留原有按站点分列的并列统计形式。
单站点路径不受影响。纯渲染断言，无 DB 依赖。
"""

from __future__ import annotations

from app.services.scheduled_report import (
    email_sender_daily,
    email_sender_monthly,
    email_sender_weekly,
)

COMBINED_TITLE = "整体销售情况（多站点汇总）"


def _daily_country_data(trend_qty: list[int]) -> dict:
    return {
        "country": "US",
        "date_range": "2026-08-10 ~ 2026-08-16",
        "sales": {"yesterday_qty": 10, "yesterday_amount": 100.0, "prev_qty": 8, "change_pct": 25.0},
        "week_sales": {"week_qty": sum(trend_qty), "week_amount": 1000.0},
        "trend_days": [{"date": f"08-{10 + i}", "qty": q} for i, q in enumerate(trend_qty)],
    }


def _weekly_country_data(daily_qty: list[int]) -> dict:
    return {
        "country": "US",
        "date_range": "2026-08-10 ~ 2026-08-16",
        "prev_week_range": "2026-08-03 ~ 2026-08-09",
        "current_week": {"qty": sum(daily_qty), "amount": 1000.0},
        "prev_week": {"qty": 0, "amount": 0.0},
        "changes": {},
        "daily_trend": [
            {"date": f"08-{10 + i}", "weekday": "周一", "qty": q} for i, q in enumerate(daily_qty)
        ],
    }


def _monthly_country_data(weekly_qty: list[int]) -> dict:
    return {
        "country": "US",
        "current_month": {"qty": sum(weekly_qty), "amount": 4000.0},
        "prev_month": {"qty": 0, "amount": 0.0},
        "yoy_month": {"qty": 0, "amount": 0.0},
        "mom_changes": {},
        "yoy_changes": {},
        "weekly_trend": [
            {"label": f"第{i + 1}周", "start": f"2026-08-{1 + i * 7:02d}",
             "end": f"2026-08-{7 + i * 7:02d}", "qty": q}
            for i, q in enumerate(weekly_qty)
        ],
    }


# ---------------------------------------------------------------------------
# 日报
# ---------------------------------------------------------------------------


def test_daily_multi_country_combined_chart_first_and_aggregated():
    countries = ["US", "DE"]
    country_data = {
        "US": _daily_country_data([100, 120]),
        "DE": _daily_country_data([50, 30]),
    }
    html = email_sender_daily._render_multi_country_html(
        countries, country_data, "项目A", "2026-08-17", "", include_summary=False,
    )
    assert COMBINED_TITLE in html
    # 按日期跨站点求和：08-10 → 150、08-11 → 150
    assert ">150<" in html
    # 合并 section 在第一个原有板块（📌 今日运营概况）之前
    assert html.index(COMBINED_TITLE) < html.index("今日运营概况")
    # 原有按站点分列的形式保留（国家子标题 badge 出现）
    assert "美国站" in html and "德国站" in html


def test_daily_multi_country_no_trend_skips_combined_section():
    countries = ["US", "DE"]
    us = _daily_country_data([1])
    us["trend_days"] = []
    de = _daily_country_data([])
    html = email_sender_daily._render_multi_country_html(
        countries, {"US": us, "DE": de}, "项目A", "2026-08-17", "", include_summary=False,
    )
    assert COMBINED_TITLE not in html
    assert "今日运营概况" in html  # 其余板块不受影响


def test_daily_single_country_path_unchanged():
    data = _daily_country_data([100])
    html = email_sender_daily._render_daily_report_html(data)
    assert COMBINED_TITLE not in html


# ---------------------------------------------------------------------------
# 周报
# ---------------------------------------------------------------------------


def test_weekly_multi_country_combined_chart_first_and_aggregated():
    countries = ["US", "UK"]
    country_data = {
        "US": _weekly_country_data([10, 20]),
        "UK": _weekly_country_data([5, 5]),
    }
    html = email_sender_weekly._render_multi_country_weekly_html(
        countries, country_data, "项目B", "2026-08-17", "34", "2026-08-10 ~ 2026-08-16",
        "", include_summary=False,
    )
    assert COMBINED_TITLE in html
    # 按日跨站点求和：08-10 → 15、08-11 → 25
    assert ">15<" in html and ">25<" in html
    assert html.index(COMBINED_TITLE) < html.index("本周运营概况")
    assert "美国站" in html and "英国站" in html


def test_weekly_multi_country_no_trend_skips_combined_section():
    countries = ["US", "UK"]
    us = _weekly_country_data([3])
    us["daily_trend"] = []
    uk = _weekly_country_data([])
    html = email_sender_weekly._render_multi_country_weekly_html(
        countries, {"US": us, "UK": uk}, "项目B", "2026-08-17", "34",
        "2026-08-10 ~ 2026-08-16", "", include_summary=False,
    )
    assert COMBINED_TITLE not in html


# ---------------------------------------------------------------------------
# 月报
# ---------------------------------------------------------------------------


def test_monthly_multi_country_combined_chart_first_and_aggregated():
    countries = ["US", "DE"]
    country_data = {
        "US": _monthly_country_data([300, 500]),
        "DE": _monthly_country_data([100, 200]),
    }
    html = email_sender_monthly._render_multi_country_monthly_html(
        countries, country_data, "项目C", "2026-08-01", "2026年8月", "2026-08-01 ~ 2026-08-31",
        "", include_summary=False,
    )
    assert COMBINED_TITLE in html
    # 按周跨站点求和：第1周 → 400、第2周 → 700
    assert ">400<" in html and ">700<" in html
    assert html.index(COMBINED_TITLE) < html.index("月度运营概况")
    assert "美国站" in html and "德国站" in html


def test_monthly_multi_country_no_trend_skips_combined_section():
    countries = ["US", "DE"]
    us = _monthly_country_data([3])
    us["weekly_trend"] = []
    de = _monthly_country_data([])
    html = email_sender_monthly._render_multi_country_monthly_html(
        countries, {"US": us, "DE": de}, "项目C", "2026-08-01", "2026年8月",
        "2026-08-01 ~ 2026-08-31", "", include_summary=False,
    )
    assert COMBINED_TITLE not in html
