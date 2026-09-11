"""Tests for app.services.scheduled_report.ai_timeout.

These tests pin the env-reading contract for the AI summary timeout
helper used by daily / weekly / monthly report builders. The motivating
bug (BEL-58) was a hardcoded ``= 0`` constant that silently disabled AI
in production; these tests guard against regressions to that shape.
"""

from __future__ import annotations

import os
from concurrent.futures import TimeoutError as FuturesTimeout
from unittest.mock import patch

import pytest

from app.services.scheduled_report import ai_timeout
from app.services.scheduled_report.ai_timeout import get_ai_timeout_sec


@pytest.fixture()
def clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove all AI_SUMMARY_TIMEOUT_SEC* vars before each test."""
    for key in list(os.environ):
        if key.startswith("AI_SUMMARY_TIMEOUT_SEC"):
            monkeypatch.delenv(key, raising=False)


# ---------------------------------------------------------------------------
# get_ai_timeout_sec — env-reading contract
# ---------------------------------------------------------------------------


def test_default_is_30_seconds(clean_env: None) -> None:
    """Without any env vars set, default to 30.0."""
    assert get_ai_timeout_sec("daily") == 30.0
    assert get_ai_timeout_sec("weekly") == 30.0
    assert get_ai_timeout_sec("monthly") == 30.0


def test_explicit_zero_disables_ai(clean_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """`0` is the supported "disable AI" switch — must be preserved, not snapped to default."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "0")
    assert get_ai_timeout_sec("daily") == 0.0
    assert get_ai_timeout_sec("weekly") == 0.0


def test_shared_env_applies_to_all_frequencies(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A single AI_SUMMARY_TIMEOUT_SEC value applies to every frequency."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "45")
    assert get_ai_timeout_sec("daily") == 45.0
    assert get_ai_timeout_sec("weekly") == 45.0
    assert get_ai_timeout_sec("monthly") == 45.0


def test_per_frequency_overrides_shared(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AI_SUMMARY_TIMEOUT_SEC_<FREQ> takes precedence over the shared var."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "45")
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_WEEKLY", "120")
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_MONTHLY", "0")

    assert get_ai_timeout_sec("daily") == 45.0
    assert get_ai_timeout_sec("weekly") == 120.0
    assert get_ai_timeout_sec("monthly") == 0.0


def test_invalid_value_falls_back_to_default(
    clean_env: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Non-numeric env values should warn and fall back to 30.0."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "not-a-number")
    with caplog.at_level("WARNING", logger=ai_timeout.logger.name):
        assert get_ai_timeout_sec("daily") == 30.0
    assert "not a number" in caplog.text


def test_invalid_per_frequency_falls_back_to_shared(
    clean_env: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A garbage per-freq value should not poison the shared value below it."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "60")
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_WEEKLY", "garbage")
    with caplog.at_level("WARNING", logger=ai_timeout.logger.name):
        # Per-freq parse fails → falls through to shared (60), not to default (30).
        assert get_ai_timeout_sec("weekly") == 60.0
    assert "WEEKLY" in caplog.text


def test_empty_string_falls_back(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Empty string is treated as 'not set'."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "")
    assert get_ai_timeout_sec("daily") == 30.0


def test_frequency_case_insensitive(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Frequency arg is lowercased before resolving the env key."""
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC_WEEKLY", "77")
    assert get_ai_timeout_sec("Weekly") == 77.0
    assert get_ai_timeout_sec("WEEKLY") == 77.0


def test_unknown_frequency_uses_shared_value(
    clean_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unrecognized frequency has no per-freq env key, so it falls
    through to the shared ``AI_SUMMARY_TIMEOUT_SEC`` (not 'daily').
    """
    monkeypatch.setenv("AI_SUMMARY_TIMEOUT_SEC", "12")
    assert get_ai_timeout_sec("hourly") == 12.0


def test_unknown_frequency_defaults_to_30_when_no_env(
    clean_env: None,
) -> None:
    """An unrecognized frequency with no env at all → 30.0 default."""
    assert get_ai_timeout_sec("hourly") == 30.0


# ---------------------------------------------------------------------------
# BLF-1014：旧 `_generate_summary`（builder 内联 LLM + 线程超时）已摘除，
# 超时兜底语义现在落在两处：
# 1. Insight run 的 Celery 层（execute_insight_run 的 soft/hard limit）；
# 2. dispatch 期 AI 禁用/超时的纯文本 fallback（_generate_fallback_summary）。
# 以下用例锁定 builder 不再有 LLM 路径，及 fallback 文本函数仍可用。
# ---------------------------------------------------------------------------


def test_report_builder_daily_has_no_llm_summary_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """builder 模块不再有 _generate_summary，数据构建期无 LLM 调用。"""
    from app.services.scheduled_report import report_builder_daily

    assert not hasattr(report_builder_daily, "_generate_summary")
    assert not hasattr(report_builder_daily, "get_ai_timeout_sec")

    def _explode(*args, **kwargs):  # pragma: no cover - 断言守卫
        raise AssertionError("AI module must not be invoked during data build")

    monkeypatch.setattr(
        "app.services.scheduled_report.ai_enhancer_daily.generate_ai_summary",
        _explode,
    )
    # build_report_email_data 的签名保留 generate_ai_summary 兼容参数，
    # 置 True 不再触发 LLM——仅推进阶段标记（stage_callback 传入 None）。
    summary = report_builder_daily._generate_fallback_summary(
        "daily", {"sales": {}, "week_sales": {}, "inventory": {}}
    )
    assert "销量" in summary


def test_fallback_summary_text_shape_matches_legacy() -> None:
    """纯文本 fallback 的口径不变：销量/近7天累计/库存。"""
    from app.services.scheduled_report.report_builder_daily import (
        _generate_fallback_summary,
    )

    summary = _generate_fallback_summary(
        "daily",
        {
            "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
            "week_sales": {"week_qty": 39, "week_amount": 1005.34},
            "inventory": {"total_available": 693, "in_transit": 0},
            "country": "DE",
        },
    )
    assert "销量8单/€208.11" in summary
    assert "近7天累计39单/€1,005.34" in summary
    assert "库存693件" in summary
