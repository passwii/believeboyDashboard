from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.scheduled_report import (
    DeliveryStatus,
    LedgerStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.models.project import Project


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def add_subscription(
    db: Session,
    *,
    frequency: str,
    dispatch_hour: int = 15,
    dispatch_minute: int = 0,
    dispatch_weekday: int | None = None,
    dispatch_day: int | None = None,
    email: str = "ops@example.com",
    project_ids: str = "15",
) -> ScheduledReportSubscription:
    sub = ScheduledReportSubscription(
        user_id=1,
        email=email,
        project_ids=project_ids,
        country="US",
        frequency=frequency,
        dispatch_hour=dispatch_hour,
        dispatch_minute=dispatch_minute,
        dispatch_weekday=dispatch_weekday,
        dispatch_day=dispatch_day,
        enabled=True,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def test_refresh_ledger_creates_daily_missing_entries(db: Session):
    from app.services.scheduled_report.ledger_service import refresh_ledger

    sub = add_subscription(db, frequency="daily")

    result = refresh_ledger(
        db,
        start_date="2026-05-22",
        end_date="2026-05-24",
    )

    assert result.summary.expected == 3
    assert result.summary.missing == 3
    assert [item.expected_date for item in result.items] == ["2026-05-24", "2026-05-23", "2026-05-22"]
    assert {item.ledger_key for item in result.items} == {
        f"{sub.id}:2026-05-22",
        f"{sub.id}:2026-05-23",
        f"{sub.id}:2026-05-24",
    }

    rows = db.query(ScheduledReportLedgerEntry).all()
    assert len(rows) == 3
    assert all(row.status == LedgerStatus.MISSING.value for row in rows)


def test_refresh_ledger_classifies_sent_and_failed(db: Session):
    from app.services.scheduled_report.ledger_service import refresh_ledger

    sub = add_subscription(db, frequency="daily")
    sent_log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency="daily",
        report_date="2026-05-23",
        report_month=None,
        email=sub.email,
        status=DeliveryStatus.SENT.value,
        sent_at=datetime(2026, 5, 23, 8, 0, tzinfo=ZoneInfo("UTC")),
    )
    failed_log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency="daily",
        report_date="2026-05-24",
        report_month=None,
        email=sub.email,
        status=DeliveryStatus.FAILED.value,
        error_message="SMTP timeout",
    )
    db.add_all([sent_log, failed_log])
    db.commit()

    result = refresh_ledger(db, start_date="2026-05-23", end_date="2026-05-24")

    by_date = {item.expected_date: item for item in result.items}
    assert by_date["2026-05-23"].status == LedgerStatus.SENT.value
    assert by_date["2026-05-23"].latest_delivery_log_id == sent_log.id
    assert by_date["2026-05-23"].can_resend is False
    assert by_date["2026-05-24"].status == LedgerStatus.FAILED.value
    assert by_date["2026-05-24"].latest_delivery_log_id == failed_log.id
    assert by_date["2026-05-24"].error_message == "SMTP timeout"
    assert by_date["2026-05-24"].can_resend is True
    assert result.summary.sent == 1
    assert result.summary.failed == 1
    assert result.summary.resendable == 1


def test_refresh_ledger_respects_weekly_and_monthly_rules(db: Session):
    from app.services.scheduled_report.ledger_service import refresh_ledger

    add_subscription(db, frequency="weekly", dispatch_weekday=0, email="weekly@example.com")
    add_subscription(db, frequency="monthly", dispatch_day=24, email="monthly@example.com")

    # 2026-05-18 is Monday (weekday=0), 2026-05-24 is Saturday (day=24)
    result = refresh_ledger(db, start_date="2026-05-18", end_date="2026-05-24")

    rows = {(item.email, item.expected_date) for item in result.items}
    assert ("weekly@example.com", "2026-05-18") in rows
    assert ("monthly@example.com", "2026-05-24") in rows
    assert result.summary.expected == 2


def test_refresh_ledger_resolves_project_names_from_db(db: Session):
    from app.services.scheduled_report.ledger_service import refresh_ledger

    # Create two projects in the DB
    p1 = Project(project_name="创酷", sort_order=1)
    p2 = Project(project_name="玥涵", sort_order=2)
    db.add_all([p1, p2])
    db.commit()

    sub = add_subscription(db, frequency="daily", project_ids=f"{p1.id},{p2.id}")

    result = refresh_ledger(db, start_date="2026-05-23", end_date="2026-05-23")

    assert len(result.items) == 1
    item = result.items[0]
    assert item.project_ids == f"{p1.id},{p2.id}"
    assert "创酷" in item.project_names
    assert "玥涵" in item.project_names
    assert len(item.project_names) == 2


def test_resend_async_refreshes_ledger_after_success(db: Session, monkeypatch: pytest.MonkeyPatch):
    from app.models.scheduled_report import DeliveryStage
    from app.services.scheduled_report.ledger_service import refresh_ledger, resend_ledger_entry_async
    import app.services.scheduled_report.ledger_service as ledger_service
    import app.services.scheduled_report.dispatcher as dispatcher

    sub = add_subscription(db, frequency="daily")
    ledger = refresh_ledger(db, start_date="2026-05-23", end_date="2026-05-23")
    ledger_key = ledger.items[0].ledger_key

    class FixedDate(date):
        @classmethod
        def today(cls):
            return cls(2026, 5, 23)

    monkeypatch.setattr(ledger_service, "date", FixedDate)
    class CloseAwareSession:
        def __init__(self, wrapped: Session):
            self.wrapped = wrapped
            self.closed = False

        def close(self):
            self.closed = True

        def __getattr__(self, name: str):
            if self.closed:
                raise RuntimeError("session is closed")
            return getattr(self.wrapped, name)

    monkeypatch.setattr(dispatcher, "SessionLocal", lambda: CloseAwareSession(db))
    monkeypatch.setattr(dispatcher, "_build_report_with_throttle", lambda *args, **kwargs: {"ai_summary": "ok"})
    monkeypatch.setattr(dispatcher, "send_scheduled_report_email", lambda *args, **kwargs: (True, "resend-id"))

    started = []

    class ImmediateThread:
        def __init__(self, target, args, daemon):
            self.target = target
            self.args = args
            self.daemon = daemon

        def start(self):
            started.append(True)
            self.target(*self.args)

    import threading
    monkeypatch.setattr(threading, "Thread", ImmediateThread)

    success, delivery_log_id, new_status, message = resend_ledger_entry_async(db, ledger_key=ledger_key)

    assert success is True
    assert delivery_log_id is not None
    assert new_status == "processing"
    assert started == [True]

    log = db.get(ScheduledReportDeliveryLog, delivery_log_id)
    assert log is not None
    assert log.status == DeliveryStatus.SENT.value
    assert log.stage == DeliveryStage.DONE.value

    refreshed_entry = db.query(ScheduledReportLedgerEntry).filter_by(ledger_key=ledger_key).one()
    assert refreshed_entry.status == LedgerStatus.SENT.value
    assert refreshed_entry.latest_delivery_log_id == delivery_log_id
    assert refreshed_entry.sent_at is not None

