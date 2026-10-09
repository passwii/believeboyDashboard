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


def test_html_to_png_uses_three_x_device_scale_by_default(monkeypatch):
    """Default report screenshots should render at 3x device scale."""
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

    monkeypatch.setattr(pw_sync_api, "sync_playwright", fake_sync_pw, raising=False)
    monkeypatch.setattr(ss_mod, "_apply_rounded_corners", lambda b: b)

    result = ss_mod.html_to_png("<html><body>hi</body></html>")

    assert result is not None, "html_to_png returned None — stub didn't take"
    fake_browser.new_page.assert_called_once_with(
        viewport={"width": 420, "height": 800},
        device_scale_factor=3,
    )


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


def test_html_to_png_launch_is_minimal(monkeypatch):
    """html_to_png must launch Chromium with headless=True and ONLY safe
    resource-limiting args.

    Real-world regression history:
    - 2026-07-28 (第一次): 误诊加 ``channel="chrome-headless-shell"``,
      ``--single-process``, ``--disable-gpu`` → 更慢/死锁。已 revert。
    - 2026-07-28 (第二次): playwright 1.60.0 的 Chrome 148 在 2核 VPS 打满
      CPU → screenshot timeout → 级联崩溃。修复：降回 1.52.0 + 加资源限制参数。

    禁止的参数（会导致性能退化或死锁）：
    - ``--single-process``（playwright 官方不推荐，易 deadlock）
    - ``--disable-gpu``（ECharts/SVG/Canvas 走软渲染，CPU 慢 5-10x）
    - ``channel=``（playwright 1.55+ headless 已默认用 headless_shell）

    允许的参数（资源限制，不影响渲染路径）：
    - ``--renderer-process-limit``、``--disable-dev-shm-usage``、
      ``--disable-background-networking``、``--disable-extensions``、
      ``--disable-sync``、``--metrics-recording-only``、``--mute-audio``、
      ``--no-first-run``
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
    call = fake_pw_cm.__enter__.return_value.chromium.launch.call_args
    # 不能有 positional args
    assert call.args == (), (
        f"launch called with positional args {call.args!r}; expected no positional args"
    )
    # kwargs 只允许 headless + args
    assert set(call.kwargs.keys()) <= {"headless", "args"}, (
        f"launch kwargs={set(call.kwargs.keys())}; expected subset of {{'headless', 'args'}}. "
        "Adding channel= explicitly has caused production screenshot timeouts."
    )
    assert call.kwargs["headless"] is True, (
        f"headless={call.kwargs['headless']!r}; expected True"
    )
    # 禁止危险参数
    launch_args = call.kwargs.get("args", [])
    _FORBIDDEN = {"--single-process", "--disable-gpu"}
    found_forbidden = _FORBIDDEN.intersection(launch_args)
    assert not found_forbidden, (
        f"launch args contain forbidden flags {found_forbidden}; "
        "these cause software rendering (5-10x slower) or deadlocks."
    )


def test_html_to_png_closes_browser_on_screenshot_timeout(monkeypatch):
    """Regression guard: 2026-07-29 scheduled-report 卡死事故。

    现场症状：celery soft_time_limit=300 触发 SIGKILL worker 子进程 → python
    进程立即死 → `browser.close()` 永远不会执行 → chromium 子进程成为孤儿，
    长期占 400-500 MiB 内存 + D 状态等 IO pipe，必须 systemctl restart
    scheduled service 才能释放。

    修复：把 browser.close() 从成功路径移到 finally 块，无论异常、超时、
    SIGKILL 路径都会尝试 close。

    测试：模拟 page.screenshot 抛 TimeoutError，断言：
    1. html_to_png 返回 None（失败不阻断）
    2. fake_browser.close() 被调用过（清理路径触发了）
    """
    import playwright.sync_api as pw_sync_api

    from app.services.scheduled_report import screenshot as ss_mod

    fake_page = MagicMock()
    # 模拟截图超时：playwright 真实 TimeoutError 是 playwright._impl._api_types
    # .TimeoutError，继承自 Exception。
    fake_page.screenshot.side_effect = TimeoutError(
        "Page.screenshot: Timeout 120000ms exceeded"
    )
    fake_browser = MagicMock()
    fake_browser.new_page.return_value = fake_page
    fake_pw_cm = MagicMock()
    fake_pw_cm.__enter__.return_value.chromium.launch.return_value = fake_browser
    fake_pw_cm.__exit__.return_value = False
    fake_sync_pw = MagicMock(return_value=fake_pw_cm)

    monkeypatch.setattr(pw_sync_api, "sync_playwright", fake_sync_pw, raising=False)
    monkeypatch.setattr(ss_mod, "_apply_rounded_corners", lambda b: b)

    result = ss_mod.html_to_png("<html><body>hi</body></html>")

    assert result is None, (
        f"html_to_png returned {result!r} on screenshot timeout; "
        "expected None so the dispatcher can fall through to email-only path"
    )
    fake_browser.close.assert_called_once()
    # 额外说明：close() 必须被调用，否则 chromium 子进程成为孤儿
    # (400-500 MiB D-state)，见 2026-07-29 scheduled-report 卡死事故。


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
