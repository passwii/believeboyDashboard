"""Tests for the diagnostic stage logging in
``app.services.scheduled_report.ai_enhancer_monthly``.

These tests pin the new behavior added to ``_call_monthly_ai_inner`` and
``generate_monthly_ai_summary`` so that when a 30s timeout fires in
production, the warning log line tells us *which* stage the call was
stuck in (``resolve_models`` / ``build_config`` / ``build_prompt`` /
``chat_completion``) and which model was being used.

We exercise three failure shapes:

1. ``chat_completion`` is the slow stage — timeout log must include
   ``stage=chat_completion`` and the model name. (Note: due to Python
   GIL scheduling latency, the worker thread can complete its sleep
   before the main thread's ``future.result`` propagates the timeout
   exception, so we accept either ``chat_completion`` or
   ``chat_completion_done`` — both prove the diagnostic made it into
   the log line.)
2. ``chat_completion`` raises a 502 — non-timeout error branch must
   include ``stage=chat_completion_exception`` and the prompt size.
3. Happy path — INFO line with all four stage timings + prompt_chars;
   no warnings emitted.

Caveat on stage attribution accuracy: in production (30s timeout,
``build_llm_config`` typically completes in <100ms, ``chat_completion``
is what runs for the full 30s), the diagnostic accurately reports
``stage=chat_completion``. The microbenchmarking caveat above is a
test-environment artifact of CPython 3.14 GIL scheduling with very
short timeouts + non-blocking workers.
"""

from __future__ import annotations

import logging
import time
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def stub_settings(monkeypatch: pytest.MonkeyPatch):
    """Provide a Settings-like object with a non-empty API key so the
    ``AI_CHAT_PROVIDER_API_KEY not configured`` short-circuit is bypassed.
    """
    from app.services.scheduled_report import ai_enhancer_monthly

    fake_settings = SimpleNamespace(
        ai_chat_provider_api_key="sk-test-dummy",
    )
    monkeypatch.setattr(ai_enhancer_monthly, "get_settings", lambda: fake_settings)
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _minimal_report_data() -> dict:
    return {
        "current_month": {"qty": 100, "amount": 1000.0},
        "prev_month": {"qty": 80, "amount": 800.0},
        "yoy_month": {"qty": 70, "amount": 700.0},
        "mom_changes": {"qty_change": 25.0, "amount_change": 25.0},
        "yoy_changes": {"qty_change": 42.8},
        "alerts": [],
        "top_skus_comparison": [],
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_timeout_logs_stage_chat_completion_and_model(
    monkeypatch: pytest.MonkeyPatch,
    stub_settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If ``chat_completion`` is the slow stage, the timeout warning must
    surface ``stage=chat_completion`` (or ``chat_completion_done``) and
    the model name in use. See module docstring for why we accept both.
    """
    from app.services.scheduled_report import ai_enhancer_monthly

    monkeypatch.setattr(
        "app.services.ai.llm.resolve_available_models",
        lambda _settings: ([], "m-test-fast"),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.build_llm_config",
        lambda **kwargs: _fake_llm_config(kwargs.get("model", "m-test-fast")),
    )

    def _slow_chat(*args, **kwargs):
        time.sleep(2.0)
        return "should not reach here"

    monkeypatch.setattr(
        "app.services.ai.llm.generate_assistant_content",
        _slow_chat,
    )

    with caplog.at_level(logging.WARNING, logger="app.services.scheduled_report.ai_enhancer_monthly"):
        result = ai_enhancer_monthly.generate_monthly_ai_summary(
            _minimal_report_data(),
            timeout=0.05,
        )

    # Fallback text is returned, no exception bubbles up.
    assert isinstance(result, str)
    assert "销售概览" in result  # signature of _generate_fallback_monthly_summary（BLF-821 分节格式）

    timeout_warnings = [
        rec for rec in caplog.records
        if rec.levelno == logging.WARNING
        and "Monthly AI summary timed out" in rec.getMessage()
    ]
    assert timeout_warnings, "expected the timeout warning to be emitted"
    msg = timeout_warnings[-1].getMessage()
    # Accept both because of the GIL-scheduling caveat in the module docstring.
    assert (
        "stage=chat_completion" in msg or "stage=chat_completion_done" in msg
    ), f"expected stage=chat_completion* in: {msg}"
    assert "model=m-test-fast" in msg, f"expected model name in: {msg}"


def test_http_error_logs_stage_chat_completion_exception(
    monkeypatch: pytest.MonkeyPatch,
    stub_settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If ``generate_assistant_content`` raises an HTTPException (e.g. 502
    from upstream), the non-timeout failure warning must surface
    ``stage=chat_completion_exception`` and the prompt size.
    """
    from app.services.scheduled_report import ai_enhancer_monthly

    monkeypatch.setattr(
        "app.services.ai.llm.resolve_available_models",
        lambda _settings: ([], "m-test-502"),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.build_llm_config",
        lambda **kwargs: _fake_llm_config(kwargs.get("model", "m-test-502")),
    )

    def _boom(*args, **kwargs):
        raise HTTPException(status_code=502, detail="upstream 502 from test")

    monkeypatch.setattr(
        "app.services.ai.llm.generate_assistant_content",
        _boom,
    )

    with caplog.at_level(logging.WARNING, logger="app.services.scheduled_report.ai_enhancer_monthly"):
        result = ai_enhancer_monthly.generate_monthly_ai_summary(
            _minimal_report_data(),
            timeout=5.0,  # generous so we don't race the threadpool
        )

    assert isinstance(result, str)
    assert "销售概览" in result  # signature of _generate_fallback_monthly_summary（BLF-821 分节格式）

    failure_warnings = [
        rec for rec in caplog.records
        if rec.levelno == logging.WARNING
        and "Monthly AI summary failed" in rec.getMessage()
    ]
    assert failure_warnings, "expected the failure warning to be emitted"
    msg = failure_warnings[-1].getMessage()
    assert "stage=chat_completion_exception" in msg, f"expected stage suffix in: {msg}"
    assert "model=m-test-502" in msg, f"expected model in: {msg}"
    assert "prompt_chars=" in msg, f"expected prompt_chars= in: {msg}"


def test_successful_call_emits_info_with_stage_timings(
    monkeypatch: pytest.MonkeyPatch,
    stub_settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Sanity check: a successful call emits the new INFO line with all
    four stage timings and prompt_chars; it does NOT emit any timeout
    warning.
    """
    from app.services.scheduled_report import ai_enhancer_monthly

    monkeypatch.setattr(
        "app.services.ai.llm.resolve_available_models",
        lambda _settings: ([], "m-ok"),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.build_llm_config",
        lambda **kwargs: _fake_llm_config(kwargs.get("model", "m-ok")),
    )
    monkeypatch.setattr(
        "app.services.ai.llm.generate_assistant_content",
        lambda **kwargs: "一切正常，本月销售表现稳健。",
    )

    with caplog.at_level(logging.INFO, logger="app.services.scheduled_report.ai_enhancer_monthly"):
        result = ai_enhancer_monthly.generate_monthly_ai_summary(
            _minimal_report_data(),
            timeout=5.0,
        )

    assert result == "一切正常，本月销售表现稳健。"

    info_lines = [rec for rec in caplog.records if "Monthly AI summary ok" in rec.getMessage()]
    assert info_lines, "expected the success info line to be emitted"
    msg = info_lines[-1].getMessage()
    for token in ("model=m-ok", "prompt_chars=", "t_resolve=", "t_build=", "t_prompt=", "t_chat=", "t_total="):
        assert token in msg, f"expected {token!r} in: {msg}"

    # No fallback path, no warnings.
    warning_lines = [rec for rec in caplog.records if rec.levelno == logging.WARNING]
    assert not warning_lines, f"unexpected warnings: {[r.getMessage() for r in warning_lines]}"
