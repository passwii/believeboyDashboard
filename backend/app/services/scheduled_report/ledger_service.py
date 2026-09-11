"""Persistent ledger service for scheduled report expected deliveries."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any

from sqlalchemy import Select, delete, func, select
from sqlalchemy.orm import Session

from app.models.scheduled_report import (
    AiSummaryStatus,
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


def build_ledger_key(subscription_id: int, expected_date: str, **_kwargs) -> str:
    """Build a unique ledger key per (subscription, expected_date).

    Multi-country subscriptions produce one combined report, so they
    get one ledger entry — not one per country.
    """
    return f"{subscription_id}:{expected_date}"


def parse_ledger_key(ledger_key: str) -> tuple[int, str]:
    """Parse ledger key into (subscription_id, expected_date).

    Handles both the current format ``{id}:{date}`` and the legacy
    multi-country format ``{id}:{date}:{country}``.
    """
    parts = ledger_key.split(":", 2)
    return int(parts[0]), parts[1]


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


def find_successful_manual_log(
    db: Session,
    *,
    subscription_id: int,
    frequency: str,
    report_date: str,
) -> ScheduledReportDeliveryLog | None:
    """Find a manual successful delivery for the same subscription period."""
    query = (
        select(ScheduledReportDeliveryLog)
        .where(ScheduledReportDeliveryLog.subscription_id == subscription_id)
        .where(ScheduledReportDeliveryLog.frequency == frequency)
        .where(ScheduledReportDeliveryLog.report_date == report_date)
        .where(ScheduledReportDeliveryLog.triggered_by == "manual")
        .where(ScheduledReportDeliveryLog.status == DeliveryStatus.SENT.value)
        .order_by(ScheduledReportDeliveryLog.created_at.desc(), ScheduledReportDeliveryLog.id.desc())
    )
    return db.execute(query).scalars().first()


def _resolve_effective_ai_model(
    subscription: ScheduledReportSubscription,
    override_ai_model: str | None = None,
) -> str | None:
    if override_ai_model:
        normalized = override_ai_model.strip()
        if normalized:
            return normalized
    return getattr(subscription, "ai_model", None)


def _summary_reference_date(expected_date: str, frequency: str) -> date:
    if frequency in ("weekly", "monthly"):
        return date.fromisoformat(expected_date)
    return date.fromisoformat(expected_date) - timedelta(days=1)


def _classify_log(log: ScheduledReportDeliveryLog | None) -> str:
    if log is None:
        return LedgerStatus.MISSING.value
    if log.status == DeliveryStatus.SENT.value:
        return LedgerStatus.SENT.value
    if log.status == DeliveryStatus.FAILED.value:
        return LedgerStatus.FAILED.value
    return LedgerStatus.MISSING.value


def _upsert_entry(
    db: Session,
    occurrence: ExpectedOccurrence,
) -> ScheduledReportLedgerEntry:
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
    ai_summary_status = AiSummaryStatus.PENDING.value
    ai_summary_error = None
    ai_summary_model = None
    ai_summary_run_id = None
    ai_summary_updated_at = None
    effective_status = entry.status
    if entry.latest_delivery_log_id:
        log = db.get(ScheduledReportDeliveryLog, entry.latest_delivery_log_id)
        if log:
            screenshot_r2_url = log.screenshot_r2_url
            screenshot_r2_thumb_url = log.screenshot_r2_thumb_url
            ai_summary = log.ai_summary
            ai_summary_status = log.ai_summary_status
            ai_summary_error = log.ai_summary_error
            ai_summary_model = log.ai_summary_model
            ai_summary_run_id = log.ai_summary_run_id
            ai_summary_updated_at = log.ai_summary_updated_at
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
        ai_summary_status=ai_summary_status,
        ai_summary_error=ai_summary_error,
        ai_summary_model=ai_summary_model,
        ai_summary_run_id=ai_summary_run_id,
        ai_summary_updated_at=ai_summary_updated_at,
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


def generate_ai_summary_for_delivery_log(
    *,
    log_id: int,
    ledger_key: str | None = None,
    override_ai_model: str | None = None,
) -> dict[str, Any]:
    """为 delivery_log 提交 schedule summary Insight run（BLF-1014）。

    旧实现在本函数里同步调 LLM；现在它是 Insight adapter 的薄包装：
    worker 侧由 Celery ``generate_delivery_summary`` 调用，提交 run 后
    立即返回，LLM 在 Insight 执行器里进行。幂等键 ``delivery:{log_id}``
    保证同一 delivery 只扣一次费。
    """
    from app.db.session import SessionLocal
    from app.services.scheduled_report.insight_adapter.submit import (
        submit_run_for_delivery,
    )

    db = SessionLocal()
    try:
        submitted, run_id, message = submit_run_for_delivery(
            db,
            log_id=log_id,
            ledger_key=ledger_key,
            override_ai_model=override_ai_model,
            scope_authorizer=_admin_scope_authorizer(db),
        )
        return {
            "status": "submitted" if submitted else "submit_failed",
            "log_id": log_id,
            "run_id": run_id,
            "message": message,
        }
    finally:
        db.close()


def _admin_scope_authorizer(db: Session):
    """Celery 侧 scope 校验：管理员视角（调度任务代表系统运行）。"""

    def authorizer(project_id: int, country: str) -> None:
        from app.services.project_service import ensure_project_access

        row = ensure_project_access(db, project_id, operator=None, is_admin=True)
        if row.country != country:
            from app.services.insight.validator import ScopeError
            from app.schemas.insight import InsightErrorCode

            raise ScopeError(
                InsightErrorCode.COUNTRY_MISMATCH,
                f"Project country is {row.country}, requested {country}",
            )

    return authorizer


def enqueue_ai_summary_generation(
    db: Session,
    *,
    log_id: int,
    ledger_key: str | None = None,
    override_ai_model: str | None = None,
) -> None:
    """把 AI 摘要生成派发到 Celery（原 threading.Thread 路径，BLF-1014 收口）。

    状态先重置为 pending（打断卡死的 generating），再派发
    ``generate_delivery_summary``；真正提交 Insight run 的是 worker。
    """
    from app.services.scheduled_report.subscription_service import (
        update_delivery_log_ai_summary_status,
    )

    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log is None:
        return
    subscription = db.get(ScheduledReportSubscription, log.subscription_id)
    effective_ai_model = (
        _resolve_effective_ai_model(subscription, override_ai_model)
        if subscription
        else None
    )
    update_delivery_log_ai_summary_status(
        db,
        log_id,
        AiSummaryStatus.PENDING.value,
        error_message=None,
        ai_model=effective_ai_model,
    )

    from app.celery_tasks.ai_summary import generate_delivery_summary

    generate_delivery_summary.delay(
        log_id=log_id,
        ledger_key=ledger_key,
        override_ai_model=override_ai_model,
    )


def regenerate_ledger_ai_summary_async(
    db: Session,
    *,
    ledger_key: str,
    override_ai_model: str | None = None,
) -> tuple[bool, int | None, str, str]:
    entry = db.execute(
        select(ScheduledReportLedgerEntry).where(ScheduledReportLedgerEntry.ledger_key == ledger_key)
    ).scalars().first()
    if entry is None:
        return False, None, "not_found", "台账记录不存在,请刷新后重试"
    if entry.latest_delivery_log_id is None:
        return False, None, "missing_log", "暂无可补充摘要的报告记录,请先补发或生成报告"

    log = db.get(ScheduledReportDeliveryLog, entry.latest_delivery_log_id)
    if log is None:
        return False, None, "missing_log", "对应的报告记录不存在,请先补发或生成报告"
    if log.status != DeliveryStatus.SENT.value:
        return False, log.id, "not_sent", "报告尚未成功发送,请先补发或生成报告"

    enqueue_ai_summary_generation(
        db,
        log_id=log.id,
        ledger_key=ledger_key,
        override_ai_model=override_ai_model,
    )
    return True, log.id, AiSummaryStatus.GENERATING.value, "AI 摘要生成已启动"


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
                expected_date = day.isoformat()
                # 清理该 subscription 在该日期的旧记录
                # 包括旧格式的多国家拆分条目（ledger_key 含国家后缀）
                db.execute(
                    delete(ScheduledReportLedgerEntry)
                    .where(
                        ScheduledReportLedgerEntry.subscription_id == sub.id,
                        ScheduledReportLedgerEntry.expected_date == expected_date,
                    )
                )
                occurrence = ExpectedOccurrence(sub, day, _build_expected_at(sub, day))
                _upsert_entry(db, occurrence)
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
    query_sub = query.subquery()
    total = db.execute(select(func.count()).select_from(query_sub)).scalar() or 0
    summary = _summary_for(db, query)

    # ── 按天分页：limit / offset 解释为「最近多少天 / 跳过多少天」。
    #    先取范围内去重后的日期（倒序），再拉取这些日期的全部记录，
    #    保证返回的每一天都是完整的——不会再因单行上限把某一天整段截断，
    #    避免出现「选了近14天却只显示不到10天」的问题。 ──
    day_query = (
        select(query_sub.c.expected_date).distinct().order_by(query_sub.c.expected_date.desc())
    )
    if offset:
        day_query = day_query.offset(offset)
    day_query = day_query.limit(limit)
    selected_days = list(db.execute(day_query).scalars().all())

    if selected_days:
        rows = db.execute(
            query.where(ScheduledReportLedgerEntry.expected_date.in_(selected_days)).order_by(
                ScheduledReportLedgerEntry.expected_at.desc(),
                ScheduledReportLedgerEntry.id.desc(),
            )
        ).scalars().all()
    else:
        rows = []

    return LedgerListResponse(items=[_to_item(db, row) for row in rows], total=total, summary=summary)


def resend_ledger_entry_async(
    db: Session,
    *,
    ledger_key: str,
    ignore_status: bool = False,
    override_ai_model: str | None = None,
) -> tuple[bool, int | None, str, str]:
    """异步补发:立即创建 delivery_log 并在后台执行发送.

    验证 ledger entry 后,创建 delivery_log(初始 stage = preparing),
    然后启动后台线程执行实际发送.前端通过轮询 delivery_log 状态获取进度.

    Args:
        ignore_status: 为 True 时跳过状态检查,强制补发(管理员强制补发)
        override_ai_model: 临时覆盖订阅预设模型,为 None/空时使用订阅本身的 ai_model
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
        triggered_by="manual",
    )

    # 更新 ledger entry 指向新的 delivery_log（先保存旧 log id 供补发成功后清理截图）
    old_log_id = entry.latest_delivery_log_id
    entry.latest_delivery_log_id = log.id
    entry.status = LedgerStatus.MISSING.value
    db.commit()

    # 解析实际使用的 AI 模型：override 优先（自动去除首尾空白），否则用订阅预设
    if override_ai_model:
        normalized_override = override_ai_model.strip()
        effective_ai_model = normalized_override or getattr(subscription, "ai_model", None)
    else:
        effective_ai_model = getattr(subscription, "ai_model", None)

    # 派发到 Celery（切片 3）：复用与定时/手动 trigger 同一 task body，
    # 通过 `pre_existing_log_id` 跳过 body 内 CREATE（这样前台能在
    # `resend_ledger_entry_async` 返回时立刻拿到 `log.id` 轮询进度）。
    # 旧路径 `_dispatch_one_async` 仍存在于 dispatcher.py 作回滚形态或
    # 旧测试引用，但不再被新代码调用（M4 决议）。
    from app.celery_tasks.scheduled_report import dispatch_one as dispatch_one_task

    async_result = dispatch_one_task.delay(
        subscription_id=subscription.id,
        email=subscription.email,
        project_ids=subscription.project_id_list or None,
        country=subscription.country,
        frequency=subscription.frequency,
        ai_model=effective_ai_model,
        use_cache=False,
        triggered_by="manual",
        report_date=entry.expected_date,
        pre_existing_log_id=log.id,
        old_log_id=old_log_id,
    )

    # 用 _async_result 与旧 log 截图清理（仅用于 observability；旧截图清理
    # 仍由 task body / 后续任务推进时通过 SubscriptionService 完成）。
    _ = async_result.id

    return True, log.id, "processing", "补发任务已派发到 Celery scheduled 队列,请在台账中查看进度"


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
        use_cache=False,
        triggered_by="manual",
        report_date=entry.expected_date,
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
