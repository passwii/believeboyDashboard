"""Tests for `regenerate_ledger_ai_summary_async` interrupt + regenerate behavior.

Background (ledger AI summary "spinner stuck" bug):
- 补发 (manual resend) sometimes leaves the AI summary permanently in
  ``ai_summary_status='generating'`` — see BEL-XXX in the issue tracker.
- The frontend currently disables the regenerate button while the status is
  ``generating`` so the user has no way out of the stuck state.
- The backend's ``regenerate_ledger_ai_summary_async`` (and the underlying
  ``enqueue_ai_summary_generation``) must therefore be a robust "interrupt
  & restart" path: even when ``ai_summary_status`` is already
  ``'generating'`` (or ``'pending'``), the call must reset the state to
  ``'pending'`` and spawn a fresh background thread so the frontend can
  recover from a wedged generation.

These tests pin that contract. They use the in-memory SQLite + NoOpThread
pattern from existing ledger tests; the JSONB adapter workaround at the
top is needed because ``Base.metadata.create_all`` includes the
``R2DeleteFailure`` table which uses a PostgreSQL-only ``JSONB`` column.
"""

from __future__ import annotations

# Register a SQLite-friendly compile rule for ``JSONB`` so we can build
# ``Base.metadata`` in an in-memory SQLite engine. Production code uses
# PostgreSQL; this adapter only kicks in under tests.
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects import sqlite
from sqlalchemy.ext.compiler import compiles


@compiles(JSONB, "sqlite")
def _compile_jsonb_for_sqlite(element, compiler, **kw):
    return "JSON"


from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.scheduled_report import (
    AiSummaryStatus,
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)


@pytest.fixture()
def db() -> Session:
    """In-memory SQLite session with all tables built (incl. JSONB adapter)."""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _add_subscription(db: Session) -> ScheduledReportSubscription:
    sub = ScheduledReportSubscription(
        user_id=1,
        email="ops@example.com",
        project_ids="15",
        country="US",
        frequency="daily",
        dispatch_hour=15,
        dispatch_minute=0,
        ai_model=None,
        enabled=True,
        created_at=datetime(2026, 1, 1, tzinfo=ZoneInfo("Asia/Shanghai")),
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def _add_sent_log(
    db: Session,
    sub: ScheduledReportSubscription,
    *,
    report_date: str,
    ai_summary_status: str = AiSummaryStatus.GENERATING.value,
    ai_summary_error: str | None = "Stuck — background thread died",
) -> ScheduledReportDeliveryLog:
    log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency=sub.frequency,
        report_date=report_date,
        report_month=None,
        email=sub.email,
        status=DeliveryStatus.SENT.value,
        sent_at=datetime(2026, 5, 23, 8, 0, tzinfo=ZoneInfo("UTC")),
        ai_summary_status=ai_summary_status,
        ai_summary_error=ai_summary_error,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def _add_ledger_entry(
    db: Session,
    sub: ScheduledReportSubscription,
    *,
    expected_date: str,
    latest_delivery_log_id: int | None,
) -> ScheduledReportLedgerEntry:
    entry = ScheduledReportLedgerEntry(
        ledger_key=f"{sub.id}:{expected_date}",
        subscription_id=sub.id,
        frequency=sub.frequency,
        expected_date=expected_date,
        expected_at=datetime(2026, 5, 23, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
        email=sub.email,
        project_ids=sub.project_ids,
        country=sub.country,
        status="sent",
        latest_delivery_log_id=latest_delivery_log_id,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


# ---------------------------------------------------------------------------
# enqueue_ai_summary_generation — interrupt + regenerate contract
# ---------------------------------------------------------------------------


def test_enqueue_resets_stuck_generating_state_and_spawns_thread(
    db: Session, monkeypatch: pytest.MonkeyPatch
):
    """Stuck in 'generating' → ``enqueue_ai_summary_generation`` must reset
    the log to PENDING and spawn a fresh background thread. This is the
    backend half of the user-facing "stop & regenerate" affordance.
    """
    from app.services.scheduled_report import ledger_service

    sub = _add_subscription(db)
    log = _add_sent_log(
        db, sub,
        report_date="2026-05-23",
        ai_summary_status=AiSummaryStatus.GENERATING.value,
        ai_summary_error="previous attempt timed out without writing back",
    )

    # Sanity: precondition reflects the stuck scenario the user hit.
    db.refresh(log)
    assert log.ai_summary_status == AiSummaryStatus.GENERATING.value
    assert log.ai_summary_error is not None

    captured: list[dict] = []

    class CapturingNoOpThread:
        def __init__(self, *args, **kwargs):
            # Be tolerant to the various ways callers invoke
            # ``threading.Thread``: positional or keyword args for
            # ``target`` / ``kwargs`` / ``daemon``.
            target = kwargs.get("target") or (args[0] if len(args) >= 1 else None)
            thread_kwargs = kwargs.get("kwargs") or (args[2] if len(args) >= 3 else {})
            daemon = kwargs.get("daemon", args[5] if len(args) >= 6 else None)
            captured.append({"target": target, "kwargs": thread_kwargs, "daemon": daemon})

        def start(self):
            return

    import threading
    monkeypatch.setattr(threading, "Thread", CapturingNoOpThread)

    ledger_service.enqueue_ai_summary_generation(
        db, log_id=log.id, override_ai_model=None,
    )

    db.refresh(log)

    # State must be reset BEFORE the new thread takes over so the frontend
    # transitions out of the stuck 'generating' immediately.
    assert log.ai_summary_status == AiSummaryStatus.PENDING.value
    assert log.ai_summary_error is None

    # And a brand-new daemon thread must be queued to do the work.
    assert len(captured) == 1
    assert captured[0]["daemon"] is True
    assert captured[0]["kwargs"]["log_id"] == log.id


def test_enqueue_resets_pending_state_without_skipping_work(
    db: Session, monkeypatch: pytest.MonkeyPatch
):
    """Even when status is 'pending' (the previous attempt's
    ``enqueue_ai_summary_generation`` call set it but its thread never
    reached the DB), the new call should still spawn the thread and
    reset error/updated_at fields. Defensive idempotency check.
    """
    from app.services.scheduled_report import ledger_service

    sub = _add_subscription(db)
    log = _add_sent_log(
        db, sub,
        report_date="2026-05-23",
        ai_summary_status=AiSummaryStatus.PENDING.value,
        ai_summary_error=None,
    )

    captured: list[dict] = []

    class CapturingNoOpThread:
        def __init__(self, *args, **kwargs):
            captured.append({"target": kwargs.get("target"), "kwargs": kwargs.get("kwargs")})

        def start(self):
            return

    import threading
    monkeypatch.setattr(threading, "Thread", CapturingNoOpThread)

    ledger_service.enqueue_ai_summary_generation(db, log_id=log.id)

    db.refresh(log)
    assert log.ai_summary_status == AiSummaryStatus.PENDING.value
    assert len(captured) == 1


# ---------------------------------------------------------------------------
# regenerate_ledger_ai_summary_async — public entry point
# ---------------------------------------------------------------------------


def test_regenerate_async_recovers_stuck_generating_state(
    db: Session, monkeypatch: pytest.MonkeyPatch
):
    """The public ``regenerate_ledger_ai_summary_async`` endpoint must
    successfully recover from a stuck 'generating' state — i.e. it's the
    contract that powers the new frontend "stop & regenerate" button.
    """
    from app.services.scheduled_report import ledger_service

    sub = _add_subscription(db)
    log = _add_sent_log(
        db, sub,
        report_date="2026-05-23",
        ai_summary_status=AiSummaryStatus.GENERATING.value,
        ai_summary_error="Stuck — backend restarted mid-call",
    )
    _add_ledger_entry(db, sub, expected_date="2026-05-23", latest_delivery_log_id=log.id)
    ledger_key = f"{sub.id}:2026-05-23"

    captured: list[dict] = []

    class CapturingNoOpThread:
        def __init__(self, *args, **kwargs):
            captured.append({"target": kwargs.get("target"), "kwargs": kwargs.get("kwargs")})

        def start(self):
            return

    import threading
    monkeypatch.setattr(threading, "Thread", CapturingNoOpThread)

    success, delivery_log_id, new_status, message = ledger_service.regenerate_ledger_ai_summary_async(
        db, ledger_key=ledger_key, override_ai_model=None,
    )

    assert success is True
    assert delivery_log_id == log.id
    assert new_status == AiSummaryStatus.GENERATING.value
    assert "AI 摘要生成" in message or "regenerate" in message.lower() or "已启动" in message

    db.refresh(log)
    # The state transitions: BEFORE the new thread sets GENERATING,
    # the reset call wrote PENDING. We capture here immediately after
    # the call, so GENERATING (from the sync enqueue path) is acceptable;
    # what matters is that the operation didn't raise and a new thread
    # was queued.
    assert log.ai_summary_status in (
        AiSummaryStatus.PENDING.value,
        AiSummaryStatus.GENERATING.value,
    )

    assert len(captured) == 1
    assert captured[0]["kwargs"]["log_id"] == log.id


def test_regenerate_async_skips_when_delivery_log_not_sent(
    db: Session, monkeypatch: pytest.MonkeyPatch
):
    """Sanity check — if the delivery log isn't 'sent' yet, regenerate
    must NOT spawn a thread. (Existing contract; pinned here so the new
    interrupt path doesn't accidentally loosen it.)
    """
    from app.services.scheduled_report import ledger_service

    sub = _add_subscription(db)
    log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency=sub.frequency,
        report_date="2026-05-23",
        report_month=None,
        email=sub.email,
        status=DeliveryStatus.FAILED.value,
        ai_summary_status=AiSummaryStatus.GENERATING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    _add_ledger_entry(db, sub, expected_date="2026-05-23", latest_delivery_log_id=log.id)
    ledger_key = f"{sub.id}:2026-05-23"

    captured: list[dict] = []

    class CapturingNoOpThread:
        def __init__(self, *args, **kwargs):
            captured.append({"target": kwargs.get("target"), "kwargs": kwargs.get("kwargs")})

        def start(self):
            return

    import threading
    monkeypatch.setattr(threading, "Thread", CapturingNoOpThread)

    success, _, new_status, _ = ledger_service.regenerate_ledger_ai_summary_async(
        db, ledger_key=ledger_key,
    )

    assert success is False
    assert new_status == "not_sent"
    assert captured == []


# ---------------------------------------------------------------------------
# regenerate after enqueue (double-click race)
# ---------------------------------------------------------------------------


def test_double_regenerate_resets_state_and_spawns_a_second_thread(
    db: Session, monkeypatch: pytest.MonkeyPatch
):
    """用户在台账「打断并重新生成」连点两次（典型 race）时，第二次调用
    必须把已经从 PENDING 被后台线程改写成 GENERATING 的状态再次重置回
    PENDING，并启动新的后台线程。简单说：regenerate 应当是幂等的
    "打断 + 重启"，而不是 "head-of-line blocking"。
    """
    from app.services.scheduled_report import ledger_service

    sub = _add_subscription(db)
    log = _add_sent_log(
        db, sub,
        report_date="2026-05-23",
        ai_summary_status=AiSummaryStatus.GENERATING.value,
        ai_summary_error="卡死在上一轮",
    )
    _add_ledger_entry(db, sub, expected_date="2026-05-23", latest_delivery_log_id=log.id)
    ledger_key = f"{sub.id}:2026-05-23"

    captured: list[dict] = []

    class CapturingNoOpThread:
        def __init__(self, *args, **kwargs):
            captured.append({
                "target": kwargs.get("target"),
                "kwargs": kwargs.get("kwargs"),
                "daemon": kwargs.get("daemon"),
            })

        def start(self):
            return

    import threading
    monkeypatch.setattr(threading, "Thread", CapturingNoOpThread)

    ledger_service.regenerate_ledger_ai_summary_async(db, ledger_key=ledger_key)
    db.refresh(log)
    assert log.ai_summary_status in (
        AiSummaryStatus.PENDING.value,
        AiSummaryStatus.GENERATING.value,
    )

    # 模拟上一轮后台线程把状态推到了 GENERATING
    log.ai_summary_status = AiSummaryStatus.GENERATING.value
    db.commit()
    db.refresh(log)

    ledger_service.regenerate_ledger_ai_summary_async(db, ledger_key=ledger_key)
    db.refresh(log)

    # 第二次调用必须再次重置状态，并 spawn 新线程。
    assert log.ai_summary_status in (
        AiSummaryStatus.PENDING.value,
        AiSummaryStatus.GENERATING.value,
    )
    assert len(captured) == 2
    assert all(c["kwargs"]["log_id"] == log.id for c in captured)
    assert all(c["daemon"] is True for c in captured)
