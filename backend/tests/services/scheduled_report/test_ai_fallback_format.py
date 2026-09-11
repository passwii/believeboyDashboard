"""Tests for the simplified daily AI summary fallback formats.

BEL-xxx: 用户要求日报文案改为「站点名独占一行 + 简化的销量/近7天累计/库存」，
去掉"昨日销量/较前一日增长X%/括号"等复杂分析。这里锁住三处兜底生成的格式，
防止后续改动把折行或简化结构改回去。
"""

from __future__ import annotations

import pytest


def _country_data() -> dict:
    return {
        "DE": {
            "sales": {
                "yesterday_qty": 8,
                "yesterday_amount": 208.11,
                "change_pct": 33.3,
            },
            "week_sales": {"week_qty": 39, "week_amount": 1005.34},
            "inventory": {"total_available": 693, "in_transit": 0},
        },
        "UK": {
            "sales": {
                "yesterday_qty": 12,
                "yesterday_amount": 261.14,
                "change_pct": -42.9,
            },
            "week_sales": {"week_qty": 112, "week_amount": 2369.12},
            "inventory": {"total_available": 1003, "in_transit": 0},
        },
        "US": {
            "sales": {
                "yesterday_qty": 6,
                "yesterday_amount": 167.7,
                "change_pct": 500.0,
            },
            "week_sales": {"week_qty": 16, "week_amount": 464.6},
            "inventory": {"total_available": 225, "in_transit": 0},
        },
    }


# ---------------------------------------------------------------------------
# BLF-1014：dispatcher 不再有 LLM 摘要路径。多国家数据构建不带 AI 副作用，
# 兜底格式断言改锚 _fallback_multi_country_summary（纯格式化，无 LLM）。
# ---------------------------------------------------------------------------


def test_multi_country_report_build_has_no_llm_summary_side_effect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """多国家数据构建（generate_ai_summary=True）不再触发任何 LLM 调用。

    BLF-1014 后 AI 摘要由 Insight run 生成；数据构建期 LLM 摘要路径
    （旧 _generate_multi_country_summary）已摘除——builder 无论
    generate_ai_summary 置真置假都只产数据。
    """
    from app.services.scheduled_report import ai_enhancer_daily
    from app.services.scheduled_report.dispatcher import _build_multi_country_report

    def _must_not_call(*args, **kwargs):  # pragma: no cover - 断言守卫
        raise AssertionError("LLM summary must not be called during data build")

    monkeypatch.setattr(
        ai_enhancer_daily, "generate_ai_summary", _must_not_call, raising=True
    )

    result = _build_multi_country_report(
        [1], ["US", "DE"], "daily", generate_ai_summary=True
    )
    assert result["ai_summary"] == ""
    assert set(result["countries"]) == {"US", "DE"}
    assert result["is_multi_country"] is True


def test_fallback_multi_country_summary_line_break_format() -> None:
    """每个站点两行：站点名独占一行 + 简化数据行，站点间空行隔开。"""
    from app.services.scheduled_report.dispatcher import _fallback_multi_country_summary

    result = _fallback_multi_country_summary(_country_data())
    lines = result.split("\n")

    # 折行结构：◉ 德国站 / 数据行 / 空行 / ◉ 英国站 / 数据行 / 空行 / ◉ 美国站 / 数据行
    assert lines[0] == "◉ 德国站"
    assert lines[1] == "销量8单/€208.11，近7天累计39单/€1,005.34，库存693件"
    assert lines[2] == ""
    assert lines[3] == "◉ 英国站"
    assert lines[4] == "销量12单/£261.14，近7天累计112单/£2,369.12，库存1003件"
    assert lines[5] == ""
    assert lines[6] == "◉ 美国站"
    assert lines[7] == "销量6单/$167.70，近7天累计16单/$464.60，库存225件"


def test_fallback_multi_country_summary_drops_complex_analysis() -> None:
    """兜底摘要不再包含昨日销量、较前一日增长/下降、括号等复杂分析。"""
    from app.services.scheduled_report.dispatcher import _fallback_multi_country_summary

    result = _fallback_multi_country_summary(_country_data())
    for forbidden in ("昨日销量", "较前一日", "（近7天", "（库存"):
        assert forbidden not in result, f"应移除 '{forbidden}'，实际输出: {result}"


def test_fallback_multi_country_summary_in_transit_appended_when_positive() -> None:
    """在途数量 > 0 时附加在库存后；= 0 时不输出。"""
    from app.services.scheduled_report.dispatcher import _fallback_multi_country_summary

    data = _country_data()
    data["DE"]["inventory"] = {"total_available": 693, "in_transit": 665}
    result = _fallback_multi_country_summary(data)
    assert "库存693件，在途665件" in result


# ---------------------------------------------------------------------------
# report_builder_daily._generate_fallback_summary — 单国家兜底
# ---------------------------------------------------------------------------


def test_report_builder_daily_fallback_simplified() -> None:
    """单国家兜底同样简化为「销量/近7天累计/库存」，去掉较前一日与括号。"""
    from app.services.scheduled_report.report_builder_daily import (
        _generate_fallback_summary,
    )

    result = _generate_fallback_summary(
        "daily",
        {
            "country": "DE",
            "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
            "week_sales": {"week_qty": 39, "week_amount": 1005.34},
            "inventory": {"total_available": 693, "in_transit": 0},
        },
    )
    assert result == "销量8单/€208.11，近7天累计39单/€1,005.34，库存693件"
    for forbidden in ("昨日销量", "较前一日", "（近7天", "（库存"):
        assert forbidden not in result


# ---------------------------------------------------------------------------
# ai_enhancer_daily._generate_fallback_summary — 单国家兜底（AI 不可用时）
# ---------------------------------------------------------------------------


def test_ai_enhancer_daily_fallback_simplified() -> None:
    """AI 不可用时的兜底同样去掉较前一日/括号。"""
    from app.services.scheduled_report.ai_enhancer_daily import (
        _generate_fallback_summary,
    )

    result = _generate_fallback_summary(
        "daily",
        {
            "country": "DE",
            "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
            "week_sales": {"week_qty": 39, "week_amount": 1005.34},
            "inventory": {"total_available": 693, "in_transit": 0},
        },
    )
    assert "销量8单/€208.11" in result
    assert "近7天累计39单/€1,005.34" in result
    assert "库存693件" in result
    for forbidden in ("较前一日", "（近7天", "（库存"):
        assert forbidden not in result


# ---------------------------------------------------------------------------
# email_sender._markdown_to_email_html — 折行在邮件里不折叠
# ---------------------------------------------------------------------------


def test_markdown_to_email_html_preserves_station_line_break() -> None:
    """站点名与数据行之间的单个换行必须在邮件 HTML 里变成 <br>（不折叠成空格）。"""
    from app.services.scheduled_report.email_sender import _markdown_to_email_html

    text = "◉ 德国站\n销量8单/€208.11，近7天累计39单/€1,005.34，库存693件"
    html = _markdown_to_email_html(text)
    assert "<br" in html, f"站点名应折行，实际: {html}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])


# ---------------------------------------------------------------------------
# dispatch 同步 fallback（方案 2：日报点完立即出摘要、零转圈）
# ---------------------------------------------------------------------------


def test_build_daily_fallback_summary_multi_country() -> None:
    """多国家 report_data → 折行 fallback（含每国 sales/week_sales/inventory）。"""
    from app.services.scheduled_report.dispatcher import _build_daily_fallback_summary_from_report

    report_data = {
        "is_multi_country": True,
        "country_data": _country_data(),
        "ai_summary": "",
    }
    result = _build_daily_fallback_summary_from_report(report_data, "daily")
    lines = result.split("\n")
    assert lines[0] == "◉ 德国站"
    assert lines[1] == "销量8单/€208.11，近7天累计39单/€1,005.34，库存693件"
    assert lines[3] == "◉ 英国站"


def test_build_daily_fallback_summary_single_country() -> None:
    """单国家 report_data → report_builder_daily 的简化 fallback。"""
    from app.services.scheduled_report.dispatcher import _build_daily_fallback_summary_from_report

    report_data = {
        "country": "DE",
        "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
        "week_sales": {"week_qty": 39, "week_amount": 1005.34},
        "inventory": {"total_available": 693, "in_transit": 0},
        "ai_summary": "",
    }
    result = _build_daily_fallback_summary_from_report(report_data, "daily")
    assert result == "销量8单/€208.11，近7天累计39单/€1,005.34，库存693件"


def test_should_sync_daily_fallback_zero_disables_ai(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """daily + AI_SUMMARY_TIMEOUT_SEC_DAILY=0 → 同步 fallback（True）。"""
    from app.services.scheduled_report.dispatcher import _should_sync_daily_fallback

    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_DAILY", "0")
    assert _should_sync_daily_fallback("daily") is True


def test_should_sync_daily_fallback_positive_timeout_uses_celery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """daily + timeout>0 → 仍走 Celery（False）。"""
    from app.services.scheduled_report.dispatcher import _should_sync_daily_fallback

    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_DAILY", "30")
    assert _should_sync_daily_fallback("daily") is False


def test_should_sync_daily_fallback_non_daily_always_celery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """周报/月报不受 daily 开关影响（False）。"""
    from app.services.scheduled_report.dispatcher import _should_sync_daily_fallback

    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_DAILY", "0")
    assert _should_sync_daily_fallback("weekly") is False
    assert _should_sync_daily_fallback("monthly") is False




# ---------------------------------------------------------------------------
# BLF-1014：摘要段落不得整段消失
#
# builder 期不再生成 AI 摘要（BLF-820 起、BLF-1014 收口到 Insight run），
# report_data["ai_summary"] 到 send 时必为空 → 邮件摘要段落会整段消失。
# 现在 send 路径用纯格式化兜底文本填回（零 LLM）。这里在 **Resend 边界**
# 抓取真实待发 HTML 断言段落确实渲染，而不是断言内部调用了哪个函数。
# ---------------------------------------------------------------------------


def _daily_single() -> dict:
    return {
        "project_name": "项目A",
        "report_date": "2026-08-17",
        "country": "US",
        "date_range": "2026-08-10 ~ 2026-08-16",
        "sales": {"yesterday_qty": 10, "yesterday_amount": 100.0},
        "week_sales": {"week_qty": 39, "week_amount": 1005.34},
        "inventory": {"total_available": 693, "in_transit": 0},
        "trend_days": [{"date": "08-10", "qty": 5}, {"date": "08-11", "qty": 5}],
        "ai_summary": "",
    }


def _weekly_single() -> dict:
    return {
        "project_name": "项目B",
        "report_date": "2026-08-17",
        "week_number": "34",
        "country": "US",
        "date_range": "2026-08-10 ~ 2026-08-16",
        "prev_week_range": "2026-08-03 ~ 2026-08-09",
        "current_week": {"qty": 100, "amount": 1000.0, "avg_price": 10.0},
        "prev_week": {"qty": 80, "amount": 800.0},
        "changes": {},
        "daily_trend": [{"date": "08-10", "weekday": "周一", "qty": 100}],
        "ai_summary": "",
    }


def _monthly_single() -> dict:
    return {
        "project_name": "项目C",
        "report_date": "2026-08-01",
        "month_label": "2026年8月",
        "country": "US",
        "date_range": "2026-08-01 ~ 2026-08-31",
        "current_month": {"qty": 1200, "amount": 12000.0, "avg_price": 10.0},
        "prev_month": {"qty": 1000, "amount": 10000.0},
        "yoy_month": {"qty": 900, "amount": 9000.0},
        "mom_changes": {},
        "yoy_changes": {},
        "weekly_trend": [{"label": "第1周", "start": "2026-08-01", "end": "2026-08-07", "qty": 300}],
        "ai_summary": "",
    }


def _multi(country_data: dict, *, extra: dict) -> dict:
    data = {
        "project_name": "项目D",
        "report_date": "2026-08-17",
        "country": "US,DE",
        "is_multi_country": True,
        "country_data": country_data,
        "ai_summary": "",
    }
    data.update(extra)
    return data


def _send_and_capture(monkeypatch: pytest.MonkeyPatch, send_fn, report_data: dict, *args) -> str:
    """在 Resend 边界抓取真实待发 HTML（不触网、不传 R2）。"""
    from types import SimpleNamespace

    import resend

    import app.core.config as config_mod
    from app.services.scheduled_report import screenshot as screenshot_mod

    captured: dict = {}
    monkeypatch.setattr(
        config_mod,
        "get_settings",
        lambda: SimpleNamespace(resend_api_key="test-key", alert_from_email="ops@example.com"),
    )
    monkeypatch.setattr(
        resend.Emails, "send", lambda params: captured.update(params) or {"id": "captured"}
    )
    monkeypatch.setattr(
        screenshot_mod, "process_screenshot_and_upload", lambda *a, **k: None
    )

    ok, detail = send_fn("ops@example.com", *args, report_data)
    assert ok is True, detail
    assert detail == "captured"
    return captured["html"]


@pytest.mark.parametrize(
    ("frequency", "report_data", "marker"),
    [
        ("daily", _daily_single(), "销量10单/$100.00"),
        ("weekly", _weekly_single(), "销量 100 件"),
        ("monthly", _monthly_single(), "销量 1,200 件"),
    ],
)
def test_send_path_renders_summary_for_single_country(
    monkeypatch: pytest.MonkeyPatch, frequency: str, report_data: dict, marker: str
) -> None:
    """单站点：ai_summary 为空进 send → 邮件仍带摘要段落。"""
    from app.services.scheduled_report import (
        email_sender_daily,
        email_sender_monthly,
        email_sender_weekly,
    )

    send_fn = {
        "daily": email_sender_daily.send_scheduled_report_email,
        "weekly": email_sender_weekly.send_weekly_report_email,
        "monthly": email_sender_monthly.send_monthly_report_email,
    }[frequency]

    extra_args = (frequency,) if frequency == "daily" else ()
    html = _send_and_capture(monkeypatch, send_fn, report_data, *extra_args)

    assert marker in html
    # 摘要段落关闭时同一份数据不含该文案 → 段落确实来自兜底摘要
    off = {
        "daily": email_sender_daily._render_daily_report_html,
        "weekly": email_sender_weekly._render_weekly_report_html,
        "monthly": email_sender_monthly._render_monthly_report_html,
    }[frequency](report_data, include_summary=False)
    assert marker not in off


@pytest.mark.parametrize(
    ("frequency", "extra", "marker"),
    [
        ("daily", {"date_range": "2026-08-10 ~ 2026-08-16"}, "◉ 美国站"),
        ("weekly", {"week_number": "34", "date_range": "2026-08-10 ~ 2026-08-16"}, "◉ 德国站"),
        (
            "monthly",
            {"month_label": "2026年8月", "date_range": "2026-08-01 ~ 2026-08-31"},
            "◉ 美国站",
        ),
    ],
)
def test_send_path_renders_summary_for_multi_country(
    monkeypatch: pytest.MonkeyPatch, frequency: str, extra: dict, marker: str
) -> None:
    """多站点：每国一行兜底摘要随邮件发出（含国家标签）。"""
    from app.services.scheduled_report import (
        email_sender_daily,
        email_sender_monthly,
        email_sender_weekly,
    )

    country_data = {
        "US": {
            "country": "US",
            "sales": {"yesterday_qty": 6, "yesterday_amount": 167.7},
            "week_sales": {"week_qty": 16, "week_amount": 464.6},
            "inventory": {"total_available": 225, "in_transit": 0},
            "current_week": {"qty": 16, "amount": 464.6, "avg_price": 29.0},
            "prev_week": {"qty": 10, "amount": 300.0},
            "current_month": {"qty": 160, "amount": 4646.0, "avg_price": 29.0},
            "prev_month": {"qty": 100, "amount": 3000.0},
            "trend_days": [{"date": "08-10", "qty": 6}],
            "daily_trend": [{"date": "08-10", "weekday": "周一", "qty": 6}],
            "weekly_trend": [{"label": "第1周", "start": "08-01", "end": "08-07", "qty": 16}],
        },
        "DE": {
            "country": "DE",
            "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
            "week_sales": {"week_qty": 39, "week_amount": 1005.34},
            "inventory": {"total_available": 693, "in_transit": 0},
            "current_week": {"qty": 39, "amount": 1005.34, "avg_price": 25.0},
            "prev_week": {"qty": 30, "amount": 800.0},
            "current_month": {"qty": 390, "amount": 10053.4, "avg_price": 25.0},
            "prev_month": {"qty": 300, "amount": 8000.0},
            "trend_days": [{"date": "08-10", "qty": 8}],
            "daily_trend": [{"date": "08-10", "weekday": "周一", "qty": 8}],
            "weekly_trend": [{"label": "第1周", "start": "08-01", "end": "08-07", "qty": 39}],
        },
    }
    report_data = _multi(country_data, extra=extra)

    send_fn = {
        "daily": email_sender_daily.send_scheduled_report_email,
        "weekly": email_sender_weekly.send_weekly_report_email,
        "monthly": email_sender_monthly.send_monthly_report_email,
    }[frequency]

    extra_args = (frequency,) if frequency == "daily" else ()
    html = _send_and_capture(monkeypatch, send_fn, report_data, *extra_args)

    assert marker in html
    assert "◉ 德国站" in html and "◉ 美国站" in html
