"""Persistent ledger service for scheduled report expected deliveries."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import Select, delete, func, select
from sqlalchemy.orm import Session

from app.models.scheduled_report import (
    DeliveryStage,
    DeliveryStatus,
    LedgerStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportLedgerEntry,
    ScheduledReportSubscription,
)
from app.models.project import Project
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


def _project_names_for(db: Session, project_ids: str) -> list[str]:
    if project_ids == "*":
        return ["全部项目"]
    ids = [pid.strip() for pid in project_ids.split(",") if pid.strip()]
    if not ids:
        return []
    id_nums = [int(pid) for pid in ids]
    rows = db.execute(
        select(Project.id, Project.project_name)
        .where(Project.id.in_(id_nums))
        .order_by(Project.sort_order)
    ).all()
    name_by_id = {row.id: row.project_name for row in rows}
    result: list[str] = []
    for pid in ids:
        name = name_by_id.get(int(pid))
        result.append(name if name else f"项目{pid}")
    return result


def _to_item(db: Session, entry: ScheduledReportLedgerEntry) -> LedgerItem:
    screenshot_r2_url = None
    screenshot_r2_thumb_url = None
    ai_summary = None
    effective_status = entry.status
    if entry.latest_delivery_log_id:
        log = db.get(ScheduledReportDeliveryLog, entry.latest_delivery_log_id)
        if log:
            screenshot_r2_url = log.screenshot_r2_url
            screenshot_r2_thumb_url = log.screenshot_r2_thumb_url
            ai_summary = log.ai_summary
            # 自愈逻辑：当 delivery_log 状态与 ledger entry 状态不一致时，
            # 以 delivery_log 为准（delivery_log 是实际执行结果的权威来源）
            live_status = _classify_log(log)
            if live_status != entry.status:
                entry.status = live_status
                entry.sent_at = log.sent_at
                if live_status == LedgerStatus.SENT.value:
                    entry.error_message = None
                effective_status = live_status

    return LedgerItem(
        id=entry.id,
        ledger_key=entry.ledger_key,
        expected_date=entry.expected_date,
        expected_at=entry.expected_at,
        frequency=entry.frequency,
        subscription_id=entry.subscription_id,
        email=entry.email,
        project_ids=entry.project_ids,
        project_names=_project_names_for(db, entry.project_ids),
        country=entry.country,
        status=effective_status,
        latest_delivery_log_id=entry.latest_delivery_log_id,
        error_message=entry.error_message,
        sent_at=entry.sent_at,
        can_resend=effective_status in (LedgerStatus.MISSING.value, LedgerStatus.FAILED.value),
        last_checked_at=entry.last_checked_at,
        screenshot_r2_url=screenshot_r2_url,
        screenshot_r2_thumb_url=screenshot_r2_thumb_url,
        ai_summary=ai_summary,
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
        sub_created_date = sub.created_at.astimezone(SHANGHAI_TZ).date()
        sub_start = max(start, sub_created_date)
        for day in _iter_dates(sub_start, end):
            if _subscription_matches_date(sub, day):
                _upsert_entry(db, ExpectedOccurrence(sub, day, _build_expected_at(sub, day)))
        # 清理订阅创建之前的虚假 ledger 条目
        if sub_created_date > start:
            db.execute(
                delete(ScheduledReportLedgerEntry)
                .where(
                    ScheduledReportLedgerEntry.subscription_id == sub.id,
                    ScheduledReportLedgerEntry.expected_date < sub_created_date.isoformat(),
                )
            )
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
    return LedgerListResponse(items=[_to_item(db, row) for row in rows], total=total, summary=summary)


def resend_ledger_entry_async(db: Session, *, ledger_key: str, ignore_status: bool = False) -> tuple[bool, int | None, str, str]:
    """异步补发:立即创建 delivery_log 并在后台执行发送.

    验证 ledger entry 后,创建 delivery_log(初始 stage = preparing),
    然后启动后台线程执行实际发送.前端通过轮询 delivery_log 状态获取进度.

    Args:
        ignore_status: 为 True 时跳过状态检查,强制补发(管理员强制补发)
    """
    entry = db.execute(
        select(ScheduledReportLedgerEntry).where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
    ).scalars().first()
    if entry is None:
        return False, None, "not_found", "台账记录不存在,请刷新后重试"
    if entry.status == LedgerStatus.SENT.value and not ignore_status:
        return False, entry.latest_delivery_log_id, entry.status, "已成功发送的记录默认不允许重复发送"

    subscription = db.get(ScheduledReportSubscription, entry.subscription_id)
    if subscription is None:
        return False, None, "not_found", "订阅不存在或已删除"

    # 创建 delivery_log(初始 stage = preparing)
    from app.services.scheduled_report.subscription_service import create_delivery_log_with_stage

    # 使用原始预期日期,确保 refresh_ledger 能通过 report_date 匹配到这条 log
    report_date = entry.expected_date
    log = create_delivery_log_with_stage(
        db=db,
        subscription_id=subscription.id,
        frequency=subscription.frequency,
        report_date=report_date,
        report_month=report_date[:7] if subscription.frequency == "monthly" else None,
        email=subscription.email,
        initial_stage=DeliveryStage.PREPARING.value,
    )

    # 更新 ledger entry 指向新的 delivery_log
    entry.latest_delivery_log_id = log.id
    entry.status = LedgerStatus.MISSING.value
    db.commit()

    # 启动后台线程执行实际发送
    import threading
    from app.services.scheduled_report.dispatcher import _dispatch_one_async

    thread = threading.Thread(
        target=_dispatch_one_async,
        args=(
            subscription.id,
            subscription.email,
            subscription.project_id_list or None,
            subscription.country,
            subscription.frequency,
            getattr(subscription, "ai_model", None),
            log.id,
            ledger_key,
            entry.expected_date,
            entry.frequency,
        ),
        daemon=True,
    )
    thread.start()

    return True, log.id, "processing", "补发任务已启动,请在台账中查看进度"


def resend_ledger_entry(db: Session, *, ledger_key: str) -> tuple[bool, int | None, str, str]:
    """同步补发:直接执行发送并等待完成(保留兼容).

    仅用于需要立即知道结果的场景.
    """
    entry = db.execute(
        select(ScheduledReportLedgerEntry).where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
    ).scalars().first()
    if entry is None:
        return False, None, "not_found", "台账记录不存在,请刷新后重试"
    if entry.status == LedgerStatus.SENT.value:
        return False, entry.latest_delivery_log_id, entry.status, "已成功发送的记录默认不允许重复发送"

    subscription = db.get(ScheduledReportSubscription, entry.subscription_id)
    if subscription is None:
        return False, None, "not_found", "订阅不存在或已删除"

    from app.services.scheduled_report.dispatcher import _dispatch_one

    result = _dispatch_one(
        subscription_id=subscription.id,
        email=subscription.email,
        project_ids=subscription.project_id_list or None,
        country=subscription.country,
        frequency=subscription.frequency,
        ai_model=getattr(subscription, "ai_model", None),
    )

    refresh_ledger(
        db,
        start_date=entry.expected_date,
        end_date=entry.expected_date,
        frequency=entry.frequency,
    )
    refreshed = db.execute(
        select(ScheduledReportLedgerEntry).where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
    ).scalars().first()
    delivery_log_id = refreshed.latest_delivery_log_id if refreshed else None
    status = refreshed.status if refreshed else (LedgerStatus.SENT.value if result.get("success") else LedgerStatus.FAILED.value)
    message = "补发成功" if result.get("success") else f"补发失败: {result.get('error') or 'Unknown error'}"
    return bool(result.get("success")), delivery_log_id, status, message
