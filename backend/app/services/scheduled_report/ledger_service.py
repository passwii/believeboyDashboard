"""Persistent ledger service for scheduled report expected deliveries."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.scheduled_report import (
    DeliveryStatus,
    LedgerStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.schemas.scheduled_report import LedgerItem, LedgerListResponse, LedgerSummary

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True)
class ExpectedOccurrence:
    subscription: ScheduledReportSubscription
    expected_date: date
    expected_at: datetime


def build_ledger_key(subscription_id: int, expected_date: str) -> str:
    return f"{subscription_id}:{expected_date}"


def parse_ledger_key(ledger_key: str) -> tuple[int, str]:
    subscription_id_text, expected_date = ledger_key.split(":", 1)
    return int(subscription_id_text), expected_date


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def _iter_dates(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current = date.fromordinal(current.toordinal() + 1)


def _subscription_matches_date(sub: ScheduledReportSubscription, day: date) -> bool:
    if sub.frequency == "daily":
        return True
    if sub.frequency == "weekly":
        expected_weekday = sub.dispatch_weekday if sub.dispatch_weekday is not None else 0
        return day.weekday() == expected_weekday
    if sub.frequency == "monthly":
        expected_day = sub.dispatch_day if sub.dispatch_day is not None else 2
        return day.day == expected_day
    return False


def _build_expected_at(sub: ScheduledReportSubscription, day: date) -> datetime:
    minute = getattr(sub, "dispatch_minute", 0) or 0
    expected_time = time(hour=sub.dispatch_hour, minute=minute)
    return datetime.combine(day, expected_time, tzinfo=SHANGHAI_TZ)


def _latest_log_for(db: Session, sub: ScheduledReportSubscription, expected_date: str) -> ScheduledReportDeliveryLog | None:
    query = (
        select(ScheduledReportDeliveryLog)
        .where(ScheduledReportDeliveryLog.subscription_id == sub.id)
        .where(ScheduledReportDeliveryLog.frequency == sub.frequency)
        .where(ScheduledReportDeliveryLog.report_date == expected_date)
        .order_by(ScheduledReportDeliveryLog.created_at.desc(), ScheduledReportDeliveryLog.id.desc())
    )
    return db.execute(query).scalars().first()


def _classify_log(log: ScheduledReportDeliveryLog | None) -> str:
    if log is None:
        return LedgerStatus.MISSING.value
    if log.status == DeliveryStatus.SENT.value:
        return LedgerStatus.SENT.value
    if log.status == DeliveryStatus.FAILED.value:
        return LedgerStatus.FAILED.value
    return LedgerStatus.MISSING.value


def _upsert_entry(db: Session, occurrence: ExpectedOccurrence) -> ScheduledReportLedgerEntry:
    sub = occurrence.subscription
    expected_date = occurrence.expected_date.isoformat()
    ledger_key = build_ledger_key(sub.id, expected_date)
    latest_log = _latest_log_for(db, sub, expected_date)
    status = _classify_log(latest_log)
    now = datetime.now(timezone.utc)

    entry = db.execute(
        select(ScheduledReportLedgerEntry).where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
    ).scalars().first()
    if entry is None:
        entry = ScheduledReportLedgerEntry(
            ledger_key=ledger_key,
            subscription_id=sub.id,
            frequency=sub.frequency,
            expected_date=expected_date,
            expected_at=occurrence.expected_at,
            email=sub.email,
            project_ids=sub.project_ids,
            country=sub.country,
        )
        db.add(entry)

    entry.frequency = sub.frequency
    entry.expected_date = expected_date
    entry.expected_at = occurrence.expected_at
    entry.email = sub.email
    entry.project_ids = sub.project_ids
    entry.country = sub.country
    entry.status = status
    entry.latest_delivery_log_id = latest_log.id if latest_log else None
    entry.error_message = latest_log.error_message if latest_log else None
    entry.sent_at = latest_log.sent_at if latest_log else None
    entry.last_checked_at = now
    return entry


def _project_names_for(project_ids: str) -> list[str]:
    if project_ids == "*":
        return ["全部项目"]
    return [f"项目{pid.strip()}" for pid in project_ids.split(",") if pid.strip()]


def _to_item(entry: ScheduledReportLedgerEntry) -> LedgerItem:
    return LedgerItem(
        id=entry.id,
        ledger_key=entry.ledger_key,
        expected_date=entry.expected_date,
        expected_at=entry.expected_at,
        frequency=entry.frequency,
        subscription_id=entry.subscription_id,
        email=entry.email,
        project_ids=entry.project_ids,
        project_names=_project_names_for(entry.project_ids),
        country=entry.country,
        status=entry.status,
        latest_delivery_log_id=entry.latest_delivery_log_id,
        error_message=entry.error_message,
        sent_at=entry.sent_at,
        can_resend=entry.status in (LedgerStatus.MISSING.value, LedgerStatus.FAILED.value),
        last_checked_at=entry.last_checked_at,
    )


def _base_query(
    *,
    start_date: str,
    end_date: str,
    frequency: str | None,
    status: str | None,
    project_id: int | None,
    email: str | None,
) -> Select[tuple[ScheduledReportLedgerEntry]]:
    query = select(ScheduledReportLedgerEntry).where(
        ScheduledReportLedgerEntry.expected_date >= start_date,
        ScheduledReportLedgerEntry.expected_date <= end_date,
    )
    if frequency and frequency != "all":
        query = query.where(ScheduledReportLedgerEntry.frequency == frequency)
    if status and status != "all":
        query = query.where(ScheduledReportLedgerEntry.status == status)
    if email:
        query = query.where(ScheduledReportLedgerEntry.email.ilike(f"%{email}%"))
    if project_id is not None:
        project_text = str(project_id)
        query = query.where(
            (ScheduledReportLedgerEntry.project_ids == "*") |
            (ScheduledReportLedgerEntry.project_ids == project_text) |
            (ScheduledReportLedgerEntry.project_ids.like(f"{project_text},%")) |
            (ScheduledReportLedgerEntry.project_ids.like(f"%,{project_text},%")) |
            (ScheduledReportLedgerEntry.project_ids.like(f"%,{project_text}"))
        )
    return query


def _summary_for(db: Session, query: Select[tuple[ScheduledReportLedgerEntry]]) -> LedgerSummary:
    rows = db.execute(query).scalars().all()
    sent = sum(1 for row in rows if row.status == LedgerStatus.SENT.value)
    failed = sum(1 for row in rows if row.status == LedgerStatus.FAILED.value)
    missing = sum(1 for row in rows if row.status == LedgerStatus.MISSING.value)
    return LedgerSummary(
        expected=len(rows),
        sent=sent,
        failed=failed,
        missing=missing,
        resendable=failed + missing,
    )


def refresh_ledger(
    db: Session,
    *,
    start_date: str,
    end_date: str,
    frequency: str | None = None,
    status: str | None = None,
    project_id: int | None = None,
    email: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> LedgerListResponse:
    start = _parse_date(start_date)
    end = _parse_date(end_date)
    if end < start:
        raise ValueError("end_date must be greater than or equal to start_date")

    sub_query = select(ScheduledReportSubscription).where(ScheduledReportSubscription.enabled == True)
    if frequency and frequency != "all":
        sub_query = sub_query.where(ScheduledReportSubscription.frequency == frequency)
    subscriptions = list(db.execute(sub_query).scalars().all())

    for sub in subscriptions:
        for day in _iter_dates(start, end):
            if _subscription_matches_date(sub, day):
                _upsert_entry(db, ExpectedOccurrence(sub, day, _build_expected_at(sub, day)))
    db.commit()

    query = _base_query(
        start_date=start_date,
        end_date=end_date,
        frequency=frequency,
        status=status,
        project_id=project_id,
        email=email,
    )
    total = db.execute(select(func.count()).select_from(query.subquery())).scalar() or 0
    summary = _summary_for(db, query)
    rows = db.execute(
        query.order_by(ScheduledReportLedgerEntry.expected_at.desc(), ScheduledReportLedgerEntry.id.desc())
        .limit(limit)
        .offset(offset)
    ).scalars().all()
    return LedgerListResponse(items=[_to_item(row) for row in rows], total=total, summary=summary)
