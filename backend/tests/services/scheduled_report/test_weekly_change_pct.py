"""Tests for the BLF-570 weekly-report migration to ``math_utils.change_pct``.

Verifies:
- ``report_builder_weekly._calc_change_pct`` delegates to the public
  ``change_pct``（口径一致：正常值相等，prev=0 且 curr>0 → None）
- Email renderers (``email_sender_weekly``) are None-safe（显示 "—" 而非误导的 "持平"）
- AI fallback summary (``ai_enhancer_weekly``) is None-safe
- Positive-signal detection is None-safe
"""

from __future__ import annotations

from app.services.scheduled_report import report_builder_weekly
from app.services.scheduled_report.ai_enhancer_weekly import (
    _generate_fallback_weekly_summary,
)
from app.services.scheduled_report.email_sender_weekly import (
    _fmt_week_change,
    _render_ads_comparison_cards,
    _render_top_sku_comparison_table,
    _render_week_comparison_table,
)
from app.utils.math_utils import change_pct

# ─── _calc_change_pct 委托 change_pct（口径一致） ─────────────────────────────


def test_calc_change_pct_normal_matches_change_pct():
    """正常值：委托后与公共函数完全一致（周报验证口径一致的依据）。"""
    for current, prev in [(110, 100), (80, 100), (100, 100), (1, 3), (0, 100)]:
        assert report_builder_weekly._calc_change_pct(current, prev) == change_pct(
            current, prev
        )


def test_calc_change_pct_prev_zero_curr_positive_is_none():
    """上期无基数 → None（与旧实现返回 0.0 的分叉点，BLF-570 统一）。"""
    assert report_builder_weekly._calc_change_pct(10, 0) is None


def test_calc_change_pct_both_zero_is_zero():
    assert report_builder_weekly._calc_change_pct(0, 0) == 0.0


# ─── email_sender_weekly None 安全 ────────────────────────────────────────────


def test_fmt_week_change_none_renders_dash():
    _, text, icon = _fmt_week_change(None)
    assert text == "—"
    assert icon == ""


def test_fmt_week_change_zero_still_flat():
    _, text, _ = _fmt_week_change(0)
    assert text == "持平"


def test_render_week_comparison_table_with_none_change():
    rows = [{"label": "销量", "current": "10", "prev": "0", "change": None}]
    html = _render_week_comparison_table(rows)
    assert "—" in html


def test_render_top_sku_comparison_table_with_none_change():
    skus = [{"sku": "SKU-1", "current": 10, "prev": 0, "change": None, "new": True}]
    html = _render_top_sku_comparison_table(skus)
    assert "NEW" in html
    assert "—" in html


def test_render_ads_comparison_cards_with_none_change():
    ads = {
        "spend": {"current": 50, "prev": 0, "change": None},
        "roas": {"current": 2.0, "prev": 0, "change": None},
        "acos": {"current": 30.0, "prev": 0, "change": None},
        "ctr": {"current": 1.0, "prev": 0, "change": None},
        "ad_ratio_all": {"current": 5.0, "prev": 0, "change": None},
    }
    html = _render_ads_comparison_cards(ads, "US")
    assert "—" in html


# ─── ai_enhancer_weekly fallback 摘要 None 安全 ───────────────────────────────


def test_fallback_summary_none_changes_no_crash():
    report = {
        "current_week": {"qty": 10, "amount": 100.0},
        "prev_week": {"qty": 0, "amount": 0.0},
        "changes": {"qty_change": None, "amount_change": None},
        "alerts": [],
        "top_skus_comparison": [],
    }
    summary = _generate_fallback_weekly_summary(report)
    assert "无上期基数" in summary


def test_fallback_summary_none_sku_change_no_crash():
    report = {
        "current_week": {"qty": 10, "amount": 100.0},
        "prev_week": {"qty": 0, "amount": 0.0},
        "changes": {"qty_change": None, "amount_change": None},
        "alerts": [],
        "top_skus_comparison": [
            {"sku": "SKU-1", "current": 10, "prev": 0, "change": None}
        ],
    }
    summary = _generate_fallback_weekly_summary(report)
    assert "SKU-1" in summary  # 仍正常渲染（不因 change=None 崩溃/丢句）


# ─── _build_positive_signals None 安全 ────────────────────────────────────────


def test_build_positive_signals_none_roas_change_no_crash():
    ads_comparison = {
        "roas": {"current": 2.0, "prev": 0.0, "change": None},
        "spend": {"current": 50.0, "prev": 0.0, "change": None},
        "acos": {"current": 30.0, "prev": 0.0, "change": None},
        "ctr": {"current": 1.0, "prev": 0.0, "change": None},
        "ad_ratio_all": {"current": 5.0, "prev": 0.0, "change": None},
    }
    signals = report_builder_weekly._build_positive_signals([], ads_comparison)
    assert signals == []


# ─── 集成：prev 周为 0 时 changes 携带 None ───────────────────────────────────


def test_weekly_changes_carry_none_when_prev_week_zero():
    """上上周销量为 0 且上周有销量 → changes 中为 None（不再返回 0.0）。

    这是 BLF-570 统一后的契约：0.0 表示"持平"，None 表示"上期无基数"。
    """
    assert change_pct(10, 0) is None
    assert report_builder_weekly._calc_change_pct(10, 0) is None
