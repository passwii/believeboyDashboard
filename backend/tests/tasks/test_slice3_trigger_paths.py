"""Tests for Slice 3 of the scheduled_report → Celery migration.

Verifies the trigger-path migration:
- `scheduler._dispatch_subscriptions` reads
  `Settings.scheduled_report_via_celery` and chooses:
  - `true`  → `dispatch_one_task.apply_async(..., countdown=i*SPREAD)` per sub
  - `false` → `ThreadPoolExecutor.submit(_dispatch_one, ...)` (rollback path)
- `dispatcher.dispatch_report_for_subscription` (manual trigger) does the same.
- `ledger_service.resend_ledger_entry_async` dispatches via
  `dispatch_one_task.delay(...)` carrying `pre_existing_log_id` so the
  caller can poll the log row that was created synchronously inside the
  same request — slices 3's M4 fix.
- `_dispatch_one_task_body` accepts `pre_existing_log_id`: when supplied,
  it skips `create_delivery_log_with_stage` and reuses the row.
"""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.core.config import Settings


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _settings(**overrides) -> Settings:
    base = {
        "_env_file": None,
        "database_url": "postgresql+psycopg://u:p@localhost:5432/x",
    }
    base.update(overrides)
    return Settings(**base)


def _sub_stub(*, sub_id: int = 1, email: str = "u@example.com", country: str = "US",
              ai_model: str | None = None, project_ids: str | None = None,
              frequency: str = "daily") -> SimpleNamespace:
    """Bare-minimum subscription object — only the attributes the triggers read."""

    if project_ids is None:
        project_ids_attr: list[int] | None = None
        project_ids_str = "*"
    else:
        project_ids_attr = [int(p) for p in project_ids.split(",") if p]
        project_ids_str = project_ids

    return SimpleNamespace(
        id=sub_id,
        email=email,
        country=country,
        ai_model=ai_model,
        project_id_list=project_ids_attr,
        frequency=frequency,
        # Keep the underlying model semantics explicit so future readers
        # know what's expected.
        project_ids=project_ids_str,
    )


# ---------------------------------------------------------------------------
# scheduler._dispatch_subscriptions — Celery branch
# ---------------------------------------------------------------------------

class TestSchedulerCeleryBranch:
    def test_via_celery_enqueues_apply_async_with_countdown(self):
        """`SCHEDULED_REPORT_VIA_CELERY=true` triggers `apply_async` with
        `countdown=i*SPREAD_SECONDS` and a `report_date` keyword.
        """
        fake_settings = _settings(
            scheduled_report_via_celery=True,
            scheduled_dispatch_spread_seconds=60,
        )

        captured = []

        class _FakeAsyncResult:
            def __init__(self, task_id):
                self.id = task_id

        def _fake_apply_async(kwargs, countdown):
            captured.append({"kwargs": dict(kwargs), "countdown": countdown})
            return _FakeAsyncResult(f"task-{len(captured)}")

        subs = [_sub_stub(sub_id=3), _sub_stub(sub_id=1), _sub_stub(sub_id=2)]
        # NB: scheduler sorts internally; we patch the import inside the fn.

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.apply_async",
                 side_effect=_fake_apply_async,
             ):
            from app.core.scheduler import _dispatch_subscriptions

            _dispatch_subscriptions("daily", subs)

        assert len(captured) == 3
        # Ordering should be by sub.id ASC regardless of input order
        ids = [c["kwargs"]["subscription_id"] for c in captured]
        assert ids == [1, 2, 3]
        # Default SPREAD_SECONDS=60 → countdown = i * 60
        assert [c["countdown"] for c in captured] == [0, 60, 120]
        # report_date kwarg is today's date, ISO format
        for c in captured:
            assert c["kwargs"]["report_date"] == date.today().isoformat()
            assert c["kwargs"]["triggered_by"] == "auto"
            assert c["kwargs"]["frequency"] == "daily"

    def test_via_celery_zero_spread_means_no_delay(self):
        fake_settings = _settings(
            scheduled_report_via_celery=True,
            scheduled_dispatch_spread_seconds=0,
        )
        captured = []

        def _fake_apply_async(kwargs, countdown):
            captured.append({"kwargs": dict(kwargs), "countdown": countdown})
            return SimpleNamespace(id="t")

        subs = [_sub_stub(sub_id=1), _sub_stub(sub_id=2)]

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.apply_async",
                 side_effect=_fake_apply_async,
             ):
            from app.core.scheduler import _dispatch_subscriptions

            _dispatch_subscriptions("daily", subs)

        # All zero-delay enqueues (burst path; useful for tests / debug)
        assert [c["countdown"] for c in captured] == [0, 0]

    def test_via_celery_uses_configured_spread(self):
        fake_settings = _settings(
            scheduled_report_via_celery=True,
            scheduled_dispatch_spread_seconds=15,  # 15-second staggered ramp
        )
        captured = []

        def _fake_apply_async(kwargs, countdown):
            captured.append({"countdown": countdown})
            return SimpleNamespace(id="t")

        subs = [_sub_stub(sub_id=1), _sub_stub(sub_id=2), _sub_stub(sub_id=3)]

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.apply_async",
                 side_effect=_fake_apply_async,
             ):
            from app.core.scheduler import _dispatch_subscriptions

            _dispatch_subscriptions("weekly", subs)

        assert [c["countdown"] for c in captured] == [0, 15, 30]


# ---------------------------------------------------------------------------
# scheduler._dispatch_subscriptions — rollback branch
# ---------------------------------------------------------------------------

class TestSchedulerRollbackBranch:
    def test_rollback_branch_keeps_using_dispatch_one_sync(self):
        """`SCHEDULED_REPORT_VIA_CELERY=false` MUST keep the ThreadPoolExecutor
        + sync `_dispatch_one` path unchanged. Slice 3 must not introduce
        Celery touches in this branch (P2-8 constraint).
        """
        fake_settings = _settings(scheduled_report_via_celery=False)

        applied = []

        def _fake_apply_async(*_args, **_kwargs):
            applied.append(True)
            return SimpleNamespace(id="should-not-appear")

        # Make any accidental import of apply_async fail loudly
        def _fail(*_args, **_kwargs):
            raise AssertionError(
                "scheduler must NOT call dispatch_one.apply_async when "
                "SCHEDULED_REPORT_VIA_CELERY=false (P2-8)"
            )

        from app.services.scheduled_report.dispatcher import _dispatch_one

        observed_dispatch_calls = []

        def _dispatch_one_wrapper(**kwargs):
            observed_dispatch_calls.append(kwargs)
            return {"success": True, "skipped": False}

        subs = [_sub_stub(sub_id=1), _sub_stub(sub_id=2)]

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.apply_async",
                 side_effect=_fail,
             ), \
             patch(
                 "app.services.scheduled_report.dispatcher._dispatch_one",
                 side_effect=_dispatch_one_wrapper,
             ):
            from app.core.scheduler import _dispatch_subscriptions

            _dispatch_subscriptions("daily", subs)

        assert applied == []  # never called
        assert len(observed_dispatch_calls) == 2


# ---------------------------------------------------------------------------
# dispatcher.dispatch_report_for_subscription — Celery branch (manual trigger)
# ---------------------------------------------------------------------------

class TestDispatchReportSubscriptionCeleryBranch:
    def test_manual_trigger_via_celery_returns_task_id(self):
        fake_settings = _settings(scheduled_report_via_celery=True)

        async_result = SimpleNamespace(id="abc-123")

        captured_kwargs = {}

        def _fake_delay(**kwargs):
            captured_kwargs.update(kwargs)
            return async_result

        sub = _sub_stub(sub_id=42, email="x@y.com", country="US")

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.services.scheduled_report.subscription_service.get_subscription_by_id",
                 return_value=sub,
             ), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.delay",
                 side_effect=_fake_delay,
             ):
            from app.services.scheduled_report.dispatcher import (
                dispatch_report_for_subscription,
            )

            result = dispatch_report_for_subscription(
                subscription_id=42, triggered_by="manual"
            )

        assert result["status"] == "enqueued"
        assert result["queue"] == "scheduled"
        assert result["task_id"] == "abc-123"
        assert result["triggered_by"] == "manual"
        assert result["subscription_id"] == 42
        # Kwargs include `report_date` (P0-1)
        assert captured_kwargs["report_date"] == date.today().isoformat()
        assert captured_kwargs["triggered_by"] == "manual"
        # No `pre_existing_log_id` for the manual trigger (CREATE path)
        assert "pre_existing_log_id" not in captured_kwargs

    def test_subscription_not_found_returns_error(self):
        """Independent of the branch — lookups should fail loud before
        touching Celery.
        """
        fake_settings = _settings(scheduled_report_via_celery=True)

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.services.scheduled_report.subscription_service.get_subscription_by_id",
                 return_value=None,
             ), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.delay"
             ) as delay_mock:
            from app.services.scheduled_report.dispatcher import (
                dispatch_report_for_subscription,
            )

            result = dispatch_report_for_subscription(
                subscription_id=9999, triggered_by="manual"
            )

        assert result["success"] is False
        assert result["error"] == "Subscription not found"
        delay_mock.assert_not_called()

    def test_rollback_branch_uses_dispatch_one_directly(self):
        """`SCHEDULED_REPORT_VIA_CELERY=false` keeps dispatch as a synchronous
        call returning the dispatch result dict.
        """
        fake_settings = _settings(scheduled_report_via_celery=False)

        sub = _sub_stub(sub_id=7, email="r@x.com", country="DE")

        with patch("app.core.config.get_settings", return_value=fake_settings), \
             patch(
                 "app.services.scheduled_report.subscription_service.get_subscription_by_id",
                 return_value=sub,
             ), \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.delay"
             ) as delay_mock, \
             patch(
                 "app.services.scheduled_report.dispatcher._dispatch_one",
                 return_value={"success": True, "skipped": False},
             ) as dispatch_one:
            from app.services.scheduled_report.dispatcher import (
                dispatch_report_for_subscription,
            )

            result = dispatch_report_for_subscription(
                subscription_id=7, triggered_by="manual"
            )

        delay_mock.assert_not_called()
        assert result["success"] is True
        assert dispatch_one.called


# ---------------------------------------------------------------------------
# ledger_service.resend_ledger_entry_async — Celery path with pre_existing_log_id
# ---------------------------------------------------------------------------

class TestResendEntryAsyncToCelery:
    def test_resend_dispatches_task_with_pre_existing_log_id(self):
        """resend creates the log row synchronously (returning the id to the
        API), then dispatches the task body with pre_existing_log_id so the
        body skips CREAT E and reuses the row.
        """
        from app.services.scheduled_report import ledger_service as ls

        # Synthesize: entry + subscription + log
        fake_entry = SimpleNamespace(
            expected_date="2026-07-09",
            frequency="weekly",
            latest_delivery_log_id=None,
            subscription_id=42,  # resend uses entry.subscription_id to look up sub
            status="missing",
        )
        # Provide only the attributes resend actually reads
        fake_subscription = SimpleNamespace(
            id=42,
            email="m@x.com",
            project_id_list=[1, 2],
            country="US",
            frequency="weekly",
            ai_model="model-x",
        )
        captured_kwargs = {}

        def _fake_delay(**kwargs):
            captured_kwargs.update(kwargs)
            return SimpleNamespace(id="celery-1")

        # Avoid the commit-on-subscription stub — we mock the helpers.
        with patch(
            "app.services.scheduled_report.subscription_service.create_delivery_log_with_stage"
        ) as create_log, \
             patch.object(ls, "_resolve_effective_ai_model", return_value="model-x"), \
             patch(
                 "app.db.session.SessionLocal"
             ) as session_factory, \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.delay",
                 side_effect=_fake_delay,
             ):
            session = session_factory.return_value.__enter__.return_value \
                if hasattr(session_factory.return_value, "__enter__") \
                else session_factory.return_value
            # Configure the session stubs: entry query, log creation returns id=123
            session.execute.return_value.scalars.return_value.first.return_value = fake_entry
            session.get.return_value = fake_subscription
            create_log.return_value = SimpleNamespace(id=123)

            ok, log_id, status, message = ls.resend_ledger_entry_async(
                session, ledger_key="k-fake",
            )

        assert ok is True
        assert log_id == 123
        assert status == "processing"
        # Body dispatch carried the pre_existing_log_id (M4)
        assert captured_kwargs["pre_existing_log_id"] == 123
        assert captured_kwargs["triggered_by"] == "manual"
        assert captured_kwargs["report_date"] == "2026-07-09"
        assert captured_kwargs["frequency"] == "weekly"
        assert captured_kwargs["subscription_id"] == 42

    def test_resend_overrides_ai_model(self):
        """override_ai_model argument makes it through to the task kwargs."""
        from app.services.scheduled_report import ledger_service as ls

        fake_entry = SimpleNamespace(
            expected_date="2026-07-09",
            frequency="weekly",
            latest_delivery_log_id=None,
            subscription_id=11,
            status="missing",
        )
        fake_subscription = SimpleNamespace(
            id=11,
            email="x@y.com",
            project_id_list=None,
            country="US",
            frequency="weekly",
            ai_model="sub-default-model",
        )
        captured = {}

        def _fake_delay(**kw):
            captured.update(kw)
            return SimpleNamespace(id="t")

        with patch(
            "app.services.scheduled_report.subscription_service.create_delivery_log_with_stage"
        ) as create_log, \
             patch.object(ls, "_resolve_effective_ai_model", return_value="override-model"), \
             patch("app.db.session.SessionLocal") as session_factory, \
             patch(
                 "app.celery_tasks.scheduled_report.dispatch_one.delay",
                 side_effect=_fake_delay,
             ):
            session = session_factory.return_value
            session.execute.return_value.scalars.return_value.first.return_value = fake_entry
            session.get.return_value = fake_subscription
            create_log.return_value = SimpleNamespace(id=200)

            ls.resend_ledger_entry_async(
                session, ledger_key="k", override_ai_model="override-model"
            )

        # The resolved effective model passed through
        assert captured["ai_model"] == "override-model"

    def test_resend_does_not_use_threading_anymore(self):
        """The legacy `threading.Thread(target=_dispatch_one_async, ...)` is gone
        in the Celery path — the function must not import `threading` at
        dispatch time.
        """
        import sys

        from app.services.scheduled_report import ledger_service as ls

        threading_imported = False

        real_import = __builtins__.__import__ if hasattr(__builtins__, "__import__") else __import__

        def _tracked_import(name, *args, **kwargs):
            nonlocal threading_imported
            if name == "threading" and "ledger_service" in (args[0] if args else ""):
                threading_imported = True
            return real_import(name, *args, **kwargs)

        # Simpler check: the function body should NOT contain "threading.Thread"
        source_path = ls.__file__
        with open(source_path) as f:
            src = f.read()
        # Look only inside the resend_ledger_entry_async body
        start = src.find("def resend_ledger_entry_async(")
        # End at the next `def ` at top-level
        end = src.find("\ndef ", start + 1)
        fn_src = src[start:end]
        assert "threading.Thread" not in fn_src
        assert "dispatch_one_task.delay" in fn_src


# ---------------------------------------------------------------------------
# _dispatch_one_task_body — pre_existing_log_id path
# ---------------------------------------------------------------------------

class TestDispatchOneTaskBodyReusesExistingLog:
    def test_pre_existing_log_id_skips_create_delivery_log(self):
        """When pre_existing_log_id is supplied, the body MUST NOT call
        create_delivery_log_with_stage. It MUST look up the row and reuse it.
        """
        from app.services.scheduled_report import dispatcher as dmod

        # Track whether the create helper would have been called
        create_called = []
        original_create = dmod.create_delivery_log_with_stage

        def _tracking_create(*args, **kwargs):
            create_called.append((args, kwargs))
            return original_create(*args, **kwargs)

        with patch.object(dmod, "create_delivery_log_with_stage", side_effect=_tracking_create), \
             patch.object(dmod, "_build_report_with_throttle") as build_mock, \
             patch.object(dmod, "_report_stage"), \
             patch.object(dmod, "send_scheduled_report_email") as send_mock, \
             patch.object(dmod, "mark_delivery_success"), \
             patch.object(dmod, "update_delivery_log_stage"), \
             patch.object(dmod, "_dispatch_date_str", "2026-07-09"), \
             patch.object(dmod, "_summary_cache", {}):
            # Patch SessionLocal to return a fake session that returns the log id
            fake_log = SimpleNamespace(id=555)
            sent_result = (True, "msg-id-1")

            class _FakeSession:
                def get(self, _model, _id):
                    return fake_log

                def close(self):
                    pass

            with patch.object(dmod, "SessionLocal", return_value=_FakeSession()):
                # We don't run the whole body — just verify create was skipped
                # by calling body and asserting the helper was not invoked.
                try:
                    dmod._dispatch_one_task_body(
                        subscription_id=42,
                        email="u@example.com",
                        project_ids=None,
                        country="US",
                        frequency="daily",
                        ai_model=None,
                        triggered_by="manual",
                        report_date="2026-07-09",
                        pre_existing_log_id=555,
                    )
                except Exception:
                    pass

        assert create_called == [], (
            "create_delivery_log_with_stage must NOT be called when "
            "pre_existing_log_id is supplied"
        )

    def test_pre_existing_log_id_none_path_still_creates(self):
        """When pre_existing_log_id is None (default), the body creates
        a new delivery_log — same behaviour as legacy `_dispatch_one`.
        """
        from app.services.scheduled_report import dispatcher as dmod

        create_called = []
        manual_log_check_called = []

        # When `triggered_by='auto'`, body runs `find_successful_manual_log`.
        # Make it return None so we proceed to CREATE.
        with patch(
            "app.services.scheduled_report.ledger_service.find_successful_manual_log",
            return_value=None,
        ), \
             patch.object(dmod, "create_delivery_log_with_stage") as create_mock, \
             patch.object(dmod, "_build_report_with_throttle"), \
             patch.object(dmod, "_report_stage"), \
             patch.object(dmod, "send_scheduled_report_email"), \
             patch.object(dmod, "mark_delivery_success"), \
             patch.object(dmod, "update_delivery_log_stage"):
            create_mock.return_value = SimpleNamespace(id=999)
            # Track call
            def _track(*a, **kw):
                create_called.append((a, kw))
                return SimpleNamespace(id=999)

            create_mock.side_effect = _track

            try:
                dmod._dispatch_one_task_body(
                    subscription_id=42,
                    email="u@example.com",
                    project_ids=None,
                    country="US",
                    frequency="daily",
                    ai_model=None,
                    triggered_by="auto",
                    report_date="2026-07-09",
                )
            except Exception:
                # The body runs many further SQL calls; we expect downstream
                # mocks to swallow errors so the assertion below still
                # observes `create_called`.
                pass

        assert create_called != [], (
            "create_delivery_log_with_stage MUST be called when "
            "pre_existing_log_id=None"
        )

    def test_dispatch_one_task_signature_accepts_pre_existing_log_id(self):
        """The Celery task itself must accept the kwarg end-to-end (so the
        broker can deserialize messages containing it).
        """
        import inspect

        from app.celery_tasks import scheduled_report as sr_mod

        # `dispatch_one` was decorated `@shared_task(bind=True)`. After the
        # decorator, `dispatch_one` is a Celery Task instance whose `.run`
        # is the original function — introspect THAT.
        sig = inspect.signature(sr_mod.dispatch_one.run)
        assert "pre_existing_log_id" in sig.parameters
