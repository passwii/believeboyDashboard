"""Unit tests for the consolidated scheduled-report AI summary module.

BLF-772 (Phase 1): ``app.services.scheduled_report.ai_schedule_report``
consolidates the per-frequency LLM-summary logic from the three
``ai_enhancer_*`` files into a single entry point.

These tests mock the LLM transport layer (``app.services.ai.llm``) and
``get_settings`` so they exercise the orchestration logic only:
success / timeout → fallback / timeout=0 → non-LLM fallback / model override,
plus per-frequency fallback selection. The original ``ai_enhancer_*`` files
are NOT touched.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def stub_settings(monkeypatch: pytest.MonkeyPatch):
    """Non-empty API key so the 'not configured' short-circuit is bypassed.

    Force-import ``app.db.session`` first so its module-level
    ``get_settings()`` call caches the *real* Settings (with ``database_url``)
    before we patch ``get_settings`` for the scheduled-report code under test.
    """
    import app.db.session  # noqa: F401  (caches real settings at import)

    fake_settings = SimpleNamespace(
        ai_chat_provider_api_key="sk-test-dummy",
        database_url="postgresql+psycopg://x",
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: fake_settings)
    return fake_settings


@pytest.fixture()
def no_key_settings(monkeypatch: pytest.MonkeyPatch):
    """Empty API key so the 'not configured' short-circuit fires."""
    import app.db.session  # noqa: F401  (caches real settings at import)

    fake_settings = SimpleNamespace(
        ai_chat_provider_api_key="",
        database_url="postgresql+psycopg://x",
    )
    monkeypatch.setattr("app.core.config.get_settings", lambda: fake_settings)
    return fake_settings


def _fake_llm_config(model: str) -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://example.invalid/v1",
        api_key="k",
        model=model,
        system_prompt="s",
        reasoning_effort=None,
        timeout_seconds=10,
    )


def _daily_payload() -> dict:
    return {
        "country": "DE",
        "sales": {"yesterday_qty": 8, "yesterday_amount": 208.11},
        "week_sales": {"week_qty": 39, "week_amount": 1005.34},
        "inventory": {"total_available": 693, "in_transit": 0},
    }


def _weekly_payload() -> dict:
    return {
        "current_week": {"qty": 100, "amount": 1000.0},
        "prev_week": {"qty": 80, "amount": 800.0},
        "changes": {"qty_change": 25.0, "amount_change": 25.0},
        "alerts": [],
        "top_skus_comparison": [],
    }


def _monthly_payload() -> dict:
    return {
        "current_month": {"qty": 100, "amount": 1000.0},
        "prev_month": {"qty": 80, "amount": 800.0},
        "yoy_month": {"qty": 70, "amount": 700.0},
        "mom_changes": {"qty_change": 25.0, "amount_change": 25.0},
        "yoy_changes": {"qty_change": 42.8},
        "alerts": [],
        "top_skus_comparison": [],
    }


def _patch_llm(monkeypatch, model="m-default", content="AI 生成的摘要"):
    """Wire the LLM transport mocks. ``generate_assistant_content`` returns
    ``content``; assertables track whether it was called and with which model.
    """
    calls: dict[str, object] = {"called": False, "model": None}

    def _resolve(_settings):
        return ([], model)

    def _build(**kwargs):
        calls["model"] = kwargs.get("model")
        return _fake_llm_config(kwargs.get("model", model))

    def _chat(**kwargs):
        calls["called"] = True
        return content

    monkeypatch.setattr("app.services.ai.llm.resolve_available_models", _resolve)
    monkeypatch.setattr("app.services.ai.llm.build_llm_config", _build)
    monkeypatch.setattr("app.services.ai.llm.generate_assistant_content", _chat)
    return calls


# ---------------------------------------------------------------------------
# Success paths
# ---------------------------------------------------------------------------


def test_daily_success_returns_cleaned_content(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """Daily success strips the meta-info pollution (字数：N字)."""
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(
        monkeypatch,
        model="m-daily",
        content="◉ 德国站\n销量8单/€208.11（字数：30字）",
    )
    result = generate_summary("daily", _daily_payload(), timeout_sec=5)
    assert calls["called"] is True
    assert "字数" not in result
    assert result == "◉ 德国站\n销量8单/€208.11"


def test_weekly_success_returns_stripped_content(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch, model="m-weekly", content="  周报分析内容  ")
    result = generate_summary("weekly", _weekly_payload(), timeout_sec=5)
    assert calls["called"] is True
    assert result == "周报分析内容"


def test_monthly_success_returns_stripped_content(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch, model="m-monthly", content="  月报分析内容  ")
    result = generate_summary("monthly", _monthly_payload(), timeout_sec=5)
    assert calls["called"] is True
    assert result == "月报分析内容"


# ---------------------------------------------------------------------------
# Timeout → fallback
# ---------------------------------------------------------------------------


def test_timeout_returns_fallback_and_does_not_raise(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """When the LLM call exceeds timeout_sec, the fallback is returned and
    no exception bubbles up."""
    import time

    from app.services.scheduled_report.ai_schedule_report import generate_summary

    monkeypatch.setattr(
        "app.services.ai.llm.resolve_available_models",
        lambda _settings: ([], "m-timeout"),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.build_llm_config",
        lambda **kwargs: _fake_llm_config(kwargs.get("model", "m-timeout")),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.generate_assistant_content",
        lambda **kwargs: time.sleep(1.0) or "should not reach",
    )

    result = generate_summary("weekly", _weekly_payload(), timeout_sec=0.05)
    assert isinstance(result, str)
    # weekly fallback signature: "本周销售"
    assert "本周销售" in result


# ---------------------------------------------------------------------------
# timeout_sec=0 → non-LLM fallback (transport never called)
# ---------------------------------------------------------------------------


def test_timeout_zero_returns_fallback_without_calling_llm(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """timeout_sec=0 disables AI entirely → fallback, transport untouched."""
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch)
    result = generate_summary("daily", _daily_payload(), timeout_sec=0)
    assert calls["called"] is False
    assert "销量" in result  # daily fallback signature


# ---------------------------------------------------------------------------
# No API key → non-LLM fallback (transport never called)
# ---------------------------------------------------------------------------


def test_no_api_key_returns_fallback_without_calling_llm(
    monkeypatch: pytest.MonkeyPatch, no_key_settings
) -> None:
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch)
    result = generate_summary("monthly", _monthly_payload(), timeout_sec=5)
    assert calls["called"] is False
    assert "本月销售" in result


# ---------------------------------------------------------------------------
# Model override
# ---------------------------------------------------------------------------


def test_model_override_passed_to_llm(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """An explicit ``model`` is forwarded to build_llm_config (not the default)."""
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch, model="m-default", content="ok")
    result = generate_summary(
        "weekly", _weekly_payload(), model="m-override", timeout_sec=5
    )
    assert result == "ok"
    assert calls["model"] == "m-override"


def test_model_none_uses_default(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """``model=None`` resolves to the default model name from resolve_available_models."""
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    calls = _patch_llm(monkeypatch, model="m-default", content="ok")
    generate_summary("weekly", _weekly_payload(), timeout_sec=5)
    assert calls["model"] == "m-default"


# ---------------------------------------------------------------------------
# Per-frequency fallback selection
# ---------------------------------------------------------------------------


def test_fallback_signature_per_frequency(
    monkeypatch: pytest.MonkeyPatch, stub_settings
) -> None:
    """Each frequency yields its own fallback signature when AI is off."""
    from app.services.scheduled_report.ai_schedule_report import generate_summary

    _patch_llm(monkeypatch)

    daily = generate_summary("daily", _daily_payload(), timeout_sec=0)
    weekly = generate_summary("weekly", _weekly_payload(), timeout_sec=0)
    monthly = generate_summary("monthly", _monthly_payload(), timeout_sec=0)

    assert "销量" in daily
    assert "本周销售" in weekly
    assert "本月销售" in monthly
    # Distinct enough that they aren't accidentally the same generator.
    assert weekly != monthly


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
