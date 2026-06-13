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
# _generate_summary — timeout / fallback integration
# ---------------------------------------------------------------------------


def test_generate_summary_returns_fallback_when_timeout_is_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If env says timeout=0, _generate_summary should short-circuit to fallback text
    without invoking the AI module at all. This is the BEL-58 'disable AI' opt-in.
    """
    from app.services.scheduled_report import report_builder_daily

    # Force the helper to return 0.
    monkeypatch.setattr(report_builder_daily, "get_ai_timeout_sec", lambda freq: 0.0)

    # If AI is invoked, the import inside _call_ai will explode. Patch it to
    # prove it is NOT called.
    def _explode(*args, **kwargs):
        raise AssertionError("AI module should not be invoked when timeout=0")

    monkeypatch.setattr(
        "app.services.scheduled_report.ai_enhancer_daily.generate_ai_summary",
        _explode,
    )

    fallback = report_builder_daily._generate_fallback_summary(
        "daily", {"sales": {}, "week_sales": {}, "inventory": {}}
    )
    with patch.object(report_builder_daily, "_generate_fallback_summary", return_value=fallback) as mock_fb:
        result = report_builder_daily._generate_summary("daily", {})
    assert result == fallback
    assert mock_fb.call_count == 1


def test_generate_summary_catches_futures_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the AI future times out, _generate_summary should catch
    FuturesTimeout and return the fallback text (not raise).
    """
    from app.services.scheduled_report import report_builder_daily

    # Force a small positive timeout so we enter the executor path.
    monkeypatch.setattr(report_builder_daily, "get_ai_timeout_sec", lambda freq: 0.05)

    def _slow_ai(*args, **kwargs):
        import time

        time.sleep(2.0)  # Far longer than the 0.05s timeout.
        return "should not reach here"

    monkeypatch.setattr(
        "app.services.scheduled_report.ai_enhancer_daily.generate_ai_summary",
        _slow_ai,
    )

    fallback = report_builder_daily._generate_fallback_summary(
        "daily", {"sales": {}, "week_sales": {}, "inventory": {}}
    )
    with patch.object(report_builder_daily, "_generate_fallback_summary", return_value=fallback) as mock_fb:
        result = report_builder_daily._generate_summary("daily", {})
    assert result == fallback
    assert mock_fb.call_count == 1


def test_generate_summary_returns_ai_text_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: AI returns within timeout → its text is used, fallback is not."""
    from app.services.scheduled_report import report_builder_daily

    monkeypatch.setattr(report_builder_daily, "get_ai_timeout_sec", lambda freq: 5.0)

    def _fast_ai(frequency, overview, model=None):
        return "AI 摘要：昨日销量表现良好。"

    monkeypatch.setattr(
        "app.services.scheduled_report.ai_enhancer_daily.generate_ai_summary",
        _fast_ai,
    )

    result = report_builder_daily._generate_summary("daily", {})
    assert result == "AI 摘要：昨日销量表现良好。"
