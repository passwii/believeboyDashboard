"""Tests for the 2026-07-28 "resend 卡死" regression.

Real-world symptom: clicking the 补发 button on the scheduled reports page
keeps the UI stuck with no screenshot and no failure feedback. Investigation
on VPS journalctl showed two independent failures:

1. Playwright's default ``page.screenshot(timeout=...)`` of 30 s is too tight
   for our 2x-scale ``full_page=True`` mobile screenshots on a 1.9 GiB VPS;
   the call raises ``TimeoutError`` and the whole dispatch path silently
   returns ``success=False`` (the email is skipped because ``skip_email=True``
   when no recipient is configured) — the user sees no screenshot and no
   error.

2. ``celery.exceptions.SoftTimeLimitExceeded`` / ``TimeLimitExceeded`` are
   subclasses of ``Exception`` so the dispatcher.py ``except Exception``
   branch *does* fire — but the dispatched body only writes ``FAILED`` on
   the *outer* ``except`` (line ~825). If the soft limit is raised from
   inside ``send_*_report_email`` and that wrapper doesn't catch it, the
   body returns ``{success=False, error=str(exc)}`` correctly — but the
   log message says "Report dispatch error" rather than the precise
   "timed out after 300s". This test pins the user-visible error string so
   future refactors don't regress on clarity.

These are regression guards, not new features. Watch them fail first, then
make the minimal dispatcher / screenshot change to pass.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from celery.exceptions import SoftTimeLimitExceeded


# ---------------------------------------------------------------------------
# 1. screenshot.html_to_png timeout
# ---------------------------------------------------------------------------


def test_html_to_png_passes_explicit_timeout_to_playwright(monkeypatch):
    """html_to_png must pass a timeout >= 60 s to page.screenshot().

    Playwright's default page.screenshot timeout is 30 s, which is too tight
    for full_page=True at 2x device scale on the production VPS (see
    journal evidence: "Page.screenshot: Timeout 30000ms exceeded" at
    20:00:00 / 20:04:19 on 2026-07-28). The fix is to pass an explicit
    timeout via the timeout= keyword arg.

    We don't actually launch Chromium in this test — we substitute a fake
    ``sync_playwright`` and assert that the call site passes timeout>=60_000.
    """
    import playwright.sync_api as pw_sync_api

    from app.services.scheduled_report import screenshot as ss_mod

    fake_page = MagicMock()
    fake_page.screenshot.return_value = b"\x89PNG\r\n\x1a\n" * 4
    fake_browser = MagicMock()
    fake_browser.new_page.return_value = fake_page
    fake_pw_cm = MagicMock()
    fake_pw_cm.__enter__.return_value.chromium.launch.return_value = fake_browser
    fake_pw_cm.__exit__.return_value = False
    fake_sync_pw = MagicMock(return_value=fake_pw_cm)

    # The production code does ``from playwright.sync_api import sync_playwright``
    # inside the function. Patch the attribute on the module so the local
    # name resolves to our fake callable.
    monkeypatch.setattr(pw_sync_api, "sync_playwright", fake_sync_pw, raising=False)

    # Skip the PIL post-processing branch — it isn't the regression we're guarding.
    monkeypatch.setattr(ss_mod, "_apply_rounded_corners", lambda b: b)

    result = ss_mod.html_to_png("<html><body>hi</body></html>")

    assert result is not None, "html_to_png returned None — stub didn't take"
    fake_page.screenshot.assert_called_once()
    call_kwargs = fake_page.screenshot.call_args.kwargs
    assert "timeout" in call_kwargs, (
        "html_to_png did not pass timeout to page.screenshot; "
        "playwright's default 30s timeout is the regression"
    )
    assert call_kwargs["timeout"] >= 60_000, (
        f"timeout={call_kwargs['timeout']!r}ms is below 60s; 30s is the original bug"
    )


def test_html_to_png_uses_headless_shell_and_single_process(monkeypatch):
    """html_to_png must launch Chromium with --single-process and prefer the
    lighter ``chrome-headless-shell`` channel.

    Real-world symptom: on the 1.9 GiB VPS, ``p.chromium.launch(headless=True)``
    on playwright 1.60 spawns **two** chrome processes (the parent ``chrome``
    + the headless_shell renderer), pushing load average past 3 and thrashing
    swap. ``--single-process`` collapses them into one; the chrome-headless-shell
    channel uses a smaller binary (~70 MB vs ~180 MB) and is playwright 1.55+'s
    default for headless — but only when explicitly requested via
    ``chromium.launch(channel="chrome-headless-shell")``. Without that,
    playwright falls back to the full chromium binary.

    This is a regression guard: anyone refactoring html_to_png should keep
    the lighter launch path.
    """
    from app.services.scheduled_report import screenshot as ss_mod

    fake_page = MagicMock()
    fake_page.screenshot.return_value = b"\x89PNG\r\n\x1a\n" * 4
    fake_browser = MagicMock()
    fake_browser.new_page.return_value = fake_page
    fake_pw_cm = MagicMock()
    fake_pw_cm.__enter__.return_value.chromium.launch.return_value = fake_browser
    fake_pw_cm.__exit__.return_value = False
    fake_sync_pw = MagicMock(return_value=fake_pw_cm)

    import playwright.sync_api as pw_sync_api

    monkeypatch.setattr(pw_sync_api, "sync_playwright", fake_sync_pw, raising=False)
    monkeypatch.setattr(ss_mod, "_apply_rounded_corners", lambda b: b)

    ss_mod.html_to_png("<html><body>hi</body></html>")

    fake_pw_cm.__enter__.return_value.chromium.launch.assert_called_once()
    launch_kwargs = fake_pw_cm.__enter__.return_value.chromium.launch.call_args.kwargs
    launch_args = fake_pw_cm.__enter__.return_value.chromium.launch.call_args.args
    # Accept either keyword ``channel=...`` or positional — both forms are valid.
    channel = launch_kwargs.get("channel") or (
        launch_args[0] if launch_args and isinstance(launch_args[0], str) else None
    )
    assert channel == "chrome-headless-shell", (
        f"launch channel={channel!r}; expected 'chrome-headless-shell' to "
        "use the lighter binary instead of full chromium"
    )
    # headless=True must stay (otherwise launches the full UI-bearing browser)
    assert launch_kwargs.get("headless") is True, (
        f"headless={launch_kwargs.get('headless')!r}; expected True"
    )
    # --single-process must be in the args list to collapse the 2-chrome process pair
    args = launch_kwargs.get("args", [])
    assert "--single-process" in args, (
        f"--single-process missing from launch args; this is what collapses "
        "the 2-chrome process pattern. Got args={args!r}"
    )


# ---------------------------------------------------------------------------
# 2. dispatcher._dispatch_one_task_body on celery time limit
# ---------------------------------------------------------------------------


def test_dispatch_one_task_body_records_failed_on_soft_time_limit(db):
    """When the body raises SoftTimeLimitExceeded, the delivery_log stage
    must be FAILED and error_message must mention the timeout (not a bare
    repr of the celery exception class).

    Without this guard, future refactors that add a more specific
    ``except SoftTimeLimitExceeded`` branch can silently drop the
    user-visible error string. Before this test existed, the original
    symptom was: post-resend the log stayed in PREPARING/RENDERING_HTML
    forever and the front-end polled "准备中" until it timed out.
    """
    from app.models.scheduled_report import (
        DeliveryStage,
        ScheduledReportDeliveryLog,
    )
    from app.services.scheduled_report import dispatcher as disp

    # Seed a delivery_log in PREPARING (mimicking what
    # resend_ledger_entry_async creates before kicking off dispatch_one).
    log = ScheduledReportDeliveryLog(
        subscription_id=1,
        frequency="daily",
        report_date="2026-07-28",
        email=None,  # resend-without-recipient → skip_email=True
        triggered_by="manual",
        status="pending",
        stage=DeliveryStage.PREPARING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)

    # Patch every side effect of the body except the celery exception.
    with (
        patch.object(
            disp,
            "_build_report_with_throttle",
            side_effect=SoftTimeLimitExceeded("simulated 300s"),
        ),
        patch.object(
            disp,
            "send_scheduled_report_email",
            return_value=(False, "should not reach"),
        ),
    ):
        result = disp._dispatch_one_task_body(
            subscription_id=1,
            email="",  # None / "" => skip_email branch
            project_ids=None,
            country="US",
            frequency="daily",
            triggered_by="manual",
            report_date="2026-07-28",
            pre_existing_log_id=log.id,
        )

    db.refresh(log)
    assert result["success"] is False
    assert log.stage == DeliveryStage.FAILED.value, (
        f"delivery_log stage={log.stage!r}; expected FAILED so the "
        "front-end stops polling PREPARING forever"
    )
    assert log.error_message, (
        "error_message must be populated for the UI to show why it failed"
    )
    assert (
        "soft time limit" in log.error_message.lower()
        or "timed out" in log.error_message.lower()
    ), (
        f"error_message={log.error_message!r} should mention timeout so users "
        "and operators can tell time-limit vs other failures apart"
    )


@pytest.fixture()
def db(monkeypatch):
    """In-memory sqlite Session AND rebind ``SessionLocal`` so
    ``_dispatch_one_task_body`` — which calls ``SessionLocal()`` itself —
    sees the same database.

    Only the ``ScheduledReportDeliveryLog`` table is created; ``create_all``
    pulls in models with JSONB columns that SQLite cannot compile.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.db import session as session_mod
    from app.models.scheduled_report import ScheduledReportDeliveryLog

    engine = create_engine("sqlite:///:memory:", future=True)
    ScheduledReportDeliveryLog.__table__.create(engine)
    TestSessionLocal = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, future=True
    )
    monkeypatch.setattr(session_mod, "SessionLocal", TestSessionLocal)
    # The dispatcher also imports SessionLocal at module load — patch the
    # name in *its* module so the rebinding takes effect there too.
    from app.services.scheduled_report import dispatcher as disp_mod

    monkeypatch.setattr(disp_mod, "SessionLocal", TestSessionLocal)

    session = TestSessionLocal()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
