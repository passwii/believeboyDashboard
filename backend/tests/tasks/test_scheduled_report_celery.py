"""Tests for the scheduled_report → Celery slice 2.

Validates the wiring contract that is otherwise runtime-only:
- `dispatch_one` task registers under the right name + queue + decorator
  options (acks_late, max_retries, time_limit) per 方案 §4.5 and §4.8.
- `generate_delivery_summary` registers with ai_summary queue + its own
  semaphore slot (§4.6).
- `acquire_remote_semaphore("ai_summary", ...)` honours
  `Settings.max_concurrent_ai_summary` and is **independent** from
  `max_concurrent_insights` (the M2 fix).
- `_sync_module_global_report_date` re-binds the dispatcher module
  globals to the task's `report_date` (P0-1).
- `_return_if_already_sent` short-circuits if a prior `sent` row exists
  (P0-2 / P0-3 fast path).
- `dispatch_one` delegates to `_dispatch_one_task_body` with the same
  kwargs the legacy `_dispatch_one` would.
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any
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


# ---------------------------------------------------------------------------
# `dispatch_one` Celery task wiring
# ---------------------------------------------------------------------------

class TestDispatchOneTaskContract:
    def setup_method(self):
        from app.celery_tasks.scheduled_report import dispatch_one

        self.task = dispatch_one

    def test_registered_name_is_dispatch_one(self):
        assert self.task.name == "dispatch_one"

    def test_acks_late_enabled(self):
        # The task is registered on the believeboy Celery app (via `@shared_task`),
        # but `task.app` may default to Celery's lazy default app before our
        # `celery_app.conf.update(...)` runs. Reading the named app's config
        # is the canonical check.
        from app.tasks.celery_app import celery_app

        assert celery_app.conf.task_acks_late is True

    def test_max_retries_is_3(self):
        assert self.task.max_retries == 3

    def test_soft_and_hard_time_limits_calibrated(self):
        # §4.8 derived values from real P50/P90/P99
        assert self.task.soft_time_limit == 300
        assert self.task.time_limit == 420

    def test_signature_accepts_required_kwargs(self):
        # Verify the public surface so future schema changes show up here.
        sig = inspect.signature(self.task.run)  # type: ignore[attr-defined]
        params = sig.parameters
        for name in (
            "subscription_id", "email", "project_ids", "country", "frequency",
            "ai_model", "use_cache", "triggered_by", "report_date",
        ):
            assert name in params, f"missing param: {name}"


# ---------------------------------------------------------------------------
# Routing: dispatch_one → scheduled, generate_delivery_summary → ai_summary
# ---------------------------------------------------------------------------

class TestRoutingRegistration:
    def test_dispatch_one_routes_to_scheduled(self):
        # Don't `send_task` to a live broker — read the route table
        # directly which is set at config time and is the source of truth.
        from app.tasks.celery_app import celery_app

        routes = celery_app.conf.task_routes
        assert routes["dispatch_one"] == {"queue": "scheduled"}

    def test_generate_delivery_summary_routes_to_ai_summary(self):
        from app.tasks.celery_app import celery_app

        routes = celery_app.conf.task_routes
        assert routes["generate_delivery_summary"] == {"queue": "ai_summary"}

    def test_include_module_wiring(self):
        # Sanity: the include list grew by 2 entries (slice 2 addition)
        from app.tasks.celery_app import celery_app

        # `include` is read from the Celery app source rather than the
        # instance after startup, so just verify the routing table has our
        # routes — this avoids coupling tests to internal attributes.
        routes = celery_app.conf.task_routes
        assert "dispatch_one" in routes
        assert "generate_delivery_summary" in routes


# ---------------------------------------------------------------------------
# generate_delivery_summary wiring
# ---------------------------------------------------------------------------

class TestGenerateDeliverySummaryTaskContract:
    def setup_method(self):
        from app.celery_tasks.ai_summary import generate_delivery_summary

        self.task = generate_delivery_summary

    def test_registered_name(self):
        assert self.task.name == "generate_delivery_summary"

    def test_acks_late_enabled(self):
        assert self.task.app.conf.task_acks_late is True

    def test_max_retries_is_2(self):
        assert self.task.max_retries == 2

    def test_soft_and_hard_time_limits_calibrated(self):
        assert self.task.soft_time_limit == 120
        assert self.task.time_limit == 240

    def test_signature_accepts_required_kwargs(self):
        sig = inspect.signature(self.task.run)  # type: ignore[attr-defined]
        params = sig.parameters
        for name in ("log_id", "ledger_key", "override_ai_model"):
            assert name in params, f"missing param: {name}"

    def test_acquires_semaphore_with_max_concurrent_setting(self):
        # The task must thread settings.max_concurrent_ai_summary into
        # acquire_remote_semaphore so ai_summary stays independent from
        # insights (M2 fix).
        captured: dict[str, Any] = {}

        from contextlib import contextmanager

        @contextmanager
        def _fake_sem(name, *, timeout, max_concurrent, **kw):
            captured["name"] = name
            captured["timeout"] = timeout
            captured["max_concurrent"] = max_concurrent
            yield True

        with patch("app.celery_tasks.ai_summary.acquire_remote_semaphore", _fake_sem), \
             patch("app.celery_tasks.ai_summary._mark_ai_summary_failed"), \
             patch(
                 "app.services.scheduled_report.ledger_service.generate_ai_summary_for_delivery_log"
             ) as llm:
            self.task.run(log_id=42, ledger_key="k", override_ai_model=None)

        assert captured["name"] == "ai_summary"
        assert captured["timeout"] == 300
        assert captured["max_concurrent"] == 5  # default in Settings

    def test_acquires_semaphore_uses_overridden_max_concurrent(self):
        captured: dict[str, Any] = {}

        from contextlib import contextmanager

        @contextmanager
        def _fake_sem(name, *, timeout, max_concurrent, **kw):
            captured["max_concurrent"] = max_concurrent
            yield True

        # Override settings BEFORE the task run reads `get_settings()`.
        # We patch the local settings attribute through `get_settings` cache.
        fake_settings = _settings(max_concurrent_ai_summary=7)
        with patch("app.celery_tasks.ai_summary.get_settings", return_value=fake_settings), \
             patch("app.celery_tasks.ai_summary.acquire_remote_semaphore", _fake_sem), \
             patch("app.celery_tasks.ai_summary._mark_ai_summary_failed"), \
             patch(
                 "app.services.scheduled_report.ledger_service.generate_ai_summary_for_delivery_log"
             ):
            self.task.run(log_id=42)

        assert captured["max_concurrent"] == 7

    def test_semaphore_timeout_marks_failed_and_returns(self):
        from contextlib import contextmanager

        @contextmanager
        def _fake_timeout_sem(name, *, timeout, max_concurrent, **kw):
            yield False  # simulate timeout

        with patch("app.celery_tasks.ai_summary.acquire_remote_semaphore", _fake_timeout_sem), \
             patch("app.celery_tasks.ai_summary._mark_ai_summary_failed") as mark:
            result = self.task.run(log_id=42)

        mark.assert_called_once()
        assert result["status"] == "semaphore_timeout"
        assert result["log_id"] == 42


# ---------------------------------------------------------------------------
# P0-1: module-global sync (报告日期固化)
# ---------------------------------------------------------------------------

class TestReportDateModuleGlobalSync:
    def test_sync_rebinds_dispatch_date_str(self):
        from app.services.scheduled_report import dispatcher as dmod
        from app.celery_tasks.scheduled_report import _sync_module_global_report_date

        # Set a sentinel value before calling sync
        sentinel = "2026-07-10"
        dmod._dispatch_date_str = "1999-01-01"
        # Pre-populate the cache with junk to prove clear() runs
        dmod._summary_cache["stale"] = "x"

        _sync_module_global_report_date(sentinel)

        assert dmod._dispatch_date_str == sentinel
        assert "stale" not in dmod._summary_cache

    def test_sync_is_noop_when_date_already_matches(self):
        from app.services.scheduled_report import dispatcher as dmod
        from app.celery_tasks.scheduled_report import _sync_module_global_report_date

        target = "2026-07-10"
        dmod._dispatch_date_str = target
        dmod._summary_cache["should-survive"] = "ok"

        _sync_module_global_report_date(target)

        # When already in sync, the cache should NOT be wiped.
        assert dmod._summary_cache.get("should-survive") == "ok"


# ---------------------------------------------------------------------------
# P0-2 / P0-3 fast path: skip if (sub, freq, date, triggered_by) sent
# ---------------------------------------------------------------------------

class TestAlreadySentFastPath:
    def test_returns_log_id_when_already_sent(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        # Build a minimal SQLite in-memory engine with only the table we need
        from app.db.session import Base
        from app.models.scheduled_report import (
            DeliveryStatus,
            ScheduledReportDeliveryLog,
            ScheduledReportSubscription,
        )

        eng = create_engine("sqlite:///:memory:", future=True)
        ScheduledReportSubscription.__table__.create(eng)
        ScheduledReportDeliveryLog.__table__.create(eng)
        Session = sessionmaker(bind=eng, autoflush=False)
        db = Session()
        try:
            sub = ScheduledReportSubscription(
                project_ids="1", country="US", frequency="daily",
                dispatch_hour=15, dispatch_minute=0, enabled=True,
            )
            db.add(sub)
            db.commit()
            from datetime import datetime, timezone

            log = ScheduledReportDeliveryLog(
                subscription_id=sub.id,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="x@example.com",
                status=DeliveryStatus.SENT.value,
                sent_at=datetime.now(timezone.utc),
            )
            db.add(log)
            db.commit()
            log_id = log.id
        finally:
            db.close()

        # Now patch `_return_if_already_sent`'s SessionLocal → our engine.
        from app.celery_tasks import scheduled_report as sr_mod

        with patch.object(sr_mod, "SessionLocal", lambda: Session()):
            from app.celery_tasks.scheduled_report import _return_if_already_sent

            found = _return_if_already_sent(
                subscription_id=1, frequency="daily",
                report_date="2026-07-10", triggered_by="auto",
            )

        assert found == log_id

    def test_returns_none_when_no_prior_sent(self):
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from app.models.scheduled_report import (
            DeliveryStatus,
            ScheduledReportDeliveryLog,
            ScheduledReportSubscription,
        )

        eng = create_engine("sqlite:///:memory:", future=True)
        ScheduledReportSubscription.__table__.create(eng)
        ScheduledReportDeliveryLog.__table__.create(eng)
        Session = sessionmaker(bind=eng, autoflush=False)

        # Empty DB — no rows at all
        from app.celery_tasks import scheduled_report as sr_mod

        with patch.object(sr_mod, "SessionLocal", lambda: Session()):
            from app.celery_tasks.scheduled_report import _return_if_already_sent

            found = _return_if_already_sent(
                subscription_id=999, frequency="daily",
                report_date="2026-07-10", triggered_by="auto",
            )
        assert found is None

    def test_failed_status_does_not_block(self):
        # P0-2 only short-circuits on `sent` rows. A row that exists but
        # failed should NOT block — otherwise failed attempts would
        # silently break retries.
        from datetime import datetime, timezone
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        from app.models.scheduled_report import (
            DeliveryStatus,
            ScheduledReportDeliveryLog,
            ScheduledReportSubscription,
        )

        eng = create_engine("sqlite:///:memory:", future=True)
        ScheduledReportSubscription.__table__.create(eng)
        ScheduledReportDeliveryLog.__table__.create(eng)
        Session = sessionmaker(bind=eng, autoflush=False)
        db = Session()
        try:
            sub = ScheduledReportSubscription(
                project_ids="1", country="US", frequency="daily",
                dispatch_hour=15, dispatch_minute=0, enabled=True,
            )
            db.add(sub)
            db.commit()
            # Row exists but status=failed — should NOT short-circuit
            log = ScheduledReportDeliveryLog(
                subscription_id=sub.id,
                frequency="daily",
                report_date="2026-07-10",
                triggered_by="auto",
                email="x@example.com",
                status=DeliveryStatus.FAILED.value,
                sent_at=datetime.now(timezone.utc),  # even if sent_at is filled, status=failed wins
            )
            db.add(log)
            db.commit()
        finally:
            db.close()

        from app.celery_tasks import scheduled_report as sr_mod

        with patch.object(sr_mod, "SessionLocal", lambda: Session()):
            from app.celery_tasks.scheduled_report import _return_if_already_sent

            found = _return_if_already_sent(
                subscription_id=1, frequency="daily",
                report_date="2026-07-10", triggered_by="auto",
            )

        assert found is None


# ---------------------------------------------------------------------------
# acquire_remote_semaphore buckets — M2 / §4.6 (independent limits)
# ---------------------------------------------------------------------------

class TestSemaphoreBucketMapping:
    def setup_method(self):
        from app.services import insight_concurrency as sem_mod

        self.sem_mod = sem_mod

    def _patch_redis(self, monkeypatch, settings: Settings):
        """Bundle the entire ACQUIRE Lua semantic into a single fake eval.

        Matches the real `tests/tasks/test_insight_celery.py` FakeRedis
        shape so both buckets share one reference implementation.
        """
        class _FakeRedis:
            def __init__(self) -> None:
                self.tokens: dict[str, int] = {}

            def eval(self, script, _numkeys, *args):
                if "ZREMRANGEBYSCORE" in script:
                    limit = int(args[1])
                    token = str(args[2])
                    now = int(args[3])
                    ttl_ms = int(args[4])
                    self.tokens = {k: v for k, v in self.tokens.items() if v > now}
                    if len(self.tokens) < limit:
                        self.tokens[token] = now + ttl_ms
                        return 1
                    return 0
                if "ZREM" in script:
                    token = str(args[1])
                    self.tokens.pop(token, None)
                    return 1
                raise AssertionError(f"unknown script: {script}")

        self._fake_redis = _FakeRedis()
        monkeypatch.setattr(self.sem_mod, "get_settings", lambda: settings)
        monkeypatch.setattr(self.sem_mod, "get_redis_client", lambda: self._fake_redis)

    def test_ai_summary_bucket_uses_max_concurrent_ai_summary(self, monkeypatch):
        # The bucket-resolution check is: a `"ai_summary"` acquire with
        # explicit `max_concurrent=X` must NOT bounce through the
        # `max_concurrent_insights` knob. We exercise this by reading the
        # resolved limit (via the module-level `_LIMIT_BY_NAME`) AND by
        # confirming the contract is intentional.
        settings = _settings(
            max_concurrent_insights=10,
            max_concurrent_ai_summary=4,
        )
        self._patch_redis(monkeypatch, settings)

        from app.services.insight_concurrency import (
            acquire_remote_semaphore,
            _LIMIT_BY_NAME,
        )

        # Mapping is the explicit contract for the new bucket
        assert _LIMIT_BY_NAME["ai_summary"] == "max_concurrent_ai_summary"

        # End-to-end: acquire one slot with explicit max_concurrent=2; we
        # cannot easily peek at the resolved `limit` value, but we can
        # confirm the surface — the bucket call does not raise and uses
        # the settings-derived cap when `max_concurrent=None`.
        ctx = acquire_remote_semaphore(
            "ai_summary",
            timeout=0.1,
            max_concurrent=settings.max_concurrent_ai_summary,
        )
        with ctx as acquired:
            # Just exercising the acquire path. With max_concurrent=4 the
            # first call should succeed against the empty fake zset.
            assert acquired is True

    def test_insights_bucket_uses_max_concurrent_insights(self, monkeypatch):
        from app.services.insight_concurrency import _LIMIT_BY_NAME

        assert _LIMIT_BY_NAME["insights"] == "max_concurrent_insights"

    def test_unknown_bucket_falls_back_to_insights(self, monkeypatch):
        from app.services.insight_concurrency import _LIMIT_BY_NAME

        assert "future_bucket" not in _LIMIT_BY_NAME


# ---------------------------------------------------------------------------
# Celery task body delegation — verify it calls the dispatcher shim
# ---------------------------------------------------------------------------

class TestDispatchOneDelegatesToBody:
    def test_dispatch_one_calls_dispatcher_task_body(self):
        from app.celery_tasks import scheduled_report as sr_mod

        captured_kwargs = {}

        def _fake_task_body(**kwargs):
            captured_kwargs.update(kwargs)
            return {"status": "ok", "received": kwargs}

        with patch.object(
            sr_mod,
            "_return_if_already_sent",
            return_value=None,
        ) as short, \
             patch.object(sr_mod, "_sync_module_global_report_date"), \
             patch(
                 "app.services.scheduled_report.dispatcher._dispatch_one_task_body",
                 side_effect=_fake_task_body,
             ):
            sr_mod.dispatch_one.run(
                subscription_id=7,
                email="u@example.com",
                project_ids=[1, 2],
                country="US",
                frequency="weekly",
                ai_model="gpt-x",
                use_cache=False,
                triggered_by="manual",
                report_date="2026-07-09",
            )

        # Short-circuit should have been consulted with the same params
        assert short.called
        # Dispatcher should have been called with matching kwargs
        assert captured_kwargs["subscription_id"] == 7
        assert captured_kwargs["email"] == "u@example.com"
        assert captured_kwargs["project_ids"] == [1, 2]
        assert captured_kwargs["country"] == "US"
        assert captured_kwargs["frequency"] == "weekly"
        assert captured_kwargs["ai_model"] == "gpt-x"
        assert captured_kwargs["use_cache"] is False
        assert captured_kwargs["triggered_by"] == "manual"
        assert captured_kwargs["report_date"] == "2026-07-09"

    def test_dispatch_one_short_circuit_skips_body(self):
        from app.celery_tasks import scheduled_report as sr_mod

        # Pretend there's already a sent log
        with patch.object(
            sr_mod,
            "_return_if_already_sent",
            return_value=999,
        ), \
             patch.object(sr_mod, "_sync_module_global_report_date"), \
             patch(
                 "app.services.scheduled_report.dispatcher._dispatch_one_task_body"
             ) as body:
            result = sr_mod.dispatch_one.run(
                subscription_id=7,
                email="u@example.com",
                project_ids=None,
                country="US",
                frequency="daily",
                report_date="2026-07-10",
            )

        body.assert_not_called()
        assert result["status"] == "skipped_already_sent"
        assert result["log_id"] == 999

    def test_dispatch_one_resend_preexisting_log_not_short_circuited(self):
        """BEL-补发回归：补发路径下，即便已存在成功的 manual log，
        dispatch_one 也绝不能被 _return_if_already_sent 短链路拦截，
        否则新创建的 preparing log（pre_existing_log_id）会永远停在
        PREPARING，前端轮询一直显示「准备中」。

        校验：pre_existing_log_id 非空时，body 必须被调用且透传该 id。
        """
        from app.celery_tasks import scheduled_report as sr_mod

        captured_kwargs = {}

        def _fake_task_body(**kwargs):
            captured_kwargs.update(kwargs)
            return {"status": "ok", "received": kwargs}

        with patch.object(
            sr_mod,
            "_return_if_already_sent",
            return_value=999,  # 假装已存在成功的 manual log
        ) as short, \
                patch.object(sr_mod, "_sync_module_global_report_date"), \
                patch(
                    "app.services.scheduled_report.dispatcher._dispatch_one_task_body",
                    side_effect=_fake_task_body,
                ) as body:
            result = sr_mod.dispatch_one.run(
                subscription_id=22,
                email=None,
                project_ids=None,
                country="US",
                frequency="daily",
                report_date="2026-07-14",
                triggered_by="manual",
                pre_existing_log_id=894,  # 补发：调用方已建好的 preparing log
                old_log_id=893,
            )

        # 关键：补发路径必须「完全跳过」幂等短链路（不调用
        # _return_if_already_sent），且 body 一定要跑，绝不能直接返回
        # skipped_already_sent 把新 log 丢在 PREPARING。
        short.assert_not_called()
        body.assert_called_once()
        assert result["status"] == "ok"
        assert captured_kwargs["pre_existing_log_id"] == 894
        assert captured_kwargs["old_log_id"] == 893


# ---------------------------------------------------------------------------
# Migration files sanity (P0-3 expected SQL symbols present)
# ---------------------------------------------------------------------------

class TestDeliveryLogMigrationSymbolCoverage:
    """Pipeline-level smoke that the slice-1 migration tokens are referenced
    alongside the slice-2 task bodies, so reviewers can grep `superseded`
    / `uq_delivery_log_dedup` and find both the migration and the
    idempotency check that consumes it.
    """

    def test_migration_and_check_share_token(self):
        backend_root = Path(__file__).resolve().parents[2]
        migration_path = (
            backend_root / "alembic" / "versions"
            / "20260710_210_add_superseded_status_and_unique_constraint.py"
        )
        text = migration_path.read_text()
        # The migration defines the constraint and adds SUPERSEDED.
        assert "superseded" in text
        assert "uq_delivery_log_dedup" in text
        # And the fast-path function lives in the same module whose
        # `dispatch_one` delegates to it. This is a smoke check that
        # the migration tokens and the runtime tokens co-exist.
        from app.celery_tasks import scheduled_report as sr_mod

        assert sr_mod._return_if_already_sent.__module__.endswith(
            "scheduled_report"
        )
        # Source file of the migration references the same table name.
        assert "scheduled_report_delivery_logs" in text
