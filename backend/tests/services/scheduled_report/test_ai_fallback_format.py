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


