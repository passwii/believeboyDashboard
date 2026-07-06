"""Subscription CRUD service for scheduled reports."""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import ScheduledReportSubscription, ScheduledReportDeliveryLog
from app.models.scheduled_report import DeliveryStatus, DeliveryStage
from app.schemas.scheduled_report import SubscriptionCreate, SubscriptionUpdate
from app.services.r2_lifecycle import record_delete_failure
from app.services.r2_service import try_delete_file_from_r2

logger = logging.getLogger(__name__)


def get_subscriptions_by_user(
    db: Session,
    user_id: int | None,
    frequency: str | None = None,
    enabled_only: bool = False,
) -> list[ScheduledReportSubscription]:
    """获取指定用户的所有订阅。"""
    query = select(ScheduledReportSubscription)
    if user_id is not None:
        query = query.where(ScheduledReportSubscription.user_id == user_id)
    if frequency:
        query = query.where(ScheduledReportSubscription.frequency == frequency)
    if enabled_only:
        query = query.where(ScheduledReportSubscription.enabled == True)
    query = query.order_by(ScheduledReportSubscription.created_at.desc())
    result = db.execute(query)
    return list(result.scalars().all())


def get_active_subscriptions(
    db: Session,
    frequency: str,
) -> list[ScheduledReportSubscription]:
    """获取指定频率的所有启用订阅。"""
    query = (
        select(ScheduledReportSubscription)
        .where(ScheduledReportSubscription.frequency == frequency)
        .where(ScheduledReportSubscription.enabled == True)
    )
    result = db.execute(query)
    return list(result.scalars().all())


def create_subscription(
    db: Session,
    user_id: int | None,
    data: SubscriptionCreate,
) -> ScheduledReportSubscription:
    """创建新订阅。"""
    subscription = ScheduledReportSubscription(
        user_id=user_id,
        email=data.email,
        project_ids=data.project_ids,
        country=data.country,
        frequency=data.frequency,
        dispatch_hour=data.dispatch_hour,
        dispatch_minute=data.dispatch_minute,
        dispatch_weekday=data.dispatch_weekday,
        dispatch_day=data.dispatch_day,
        ai_model=data.ai_model,
        enabled=True,
    )
    db.add(subscription)
    db.commit()
    db.refresh(subscription)
    logger.info(f"Created subscription id={subscription.id} for email={data.email}")
    return subscription


def update_subscription(
    db: Session,
    subscription_id: int,
    data: SubscriptionUpdate,
) -> Optional[ScheduledReportSubscription]:
    """更新订阅配置。"""
    subscription = db.get(ScheduledReportSubscription, subscription_id)
    if not subscription:
        return None
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        if value is not None:
            setattr(subscription, key, value)
    db.commit()
    db.refresh(subscription)
    logger.info(f"Updated subscription id={subscription_id}")
    return subscription


def delete_subscription(
    db: Session,
    subscription_id: int,
) -> bool:
    """删除订阅 + 清理该订阅所有 delivery_log 引用的 R2 对象。

    Lifecycle:
      1. 收集所有 delivery_log 的 screenshot_r2_key / screenshot_r2_thumb_key
         （在 ORM cascade 触发删除前）
      2. db.delete(subscription) -> cascade 自动 DB-delete 所有 log 行
      3. db.commit()
      4. commit 后**同步**调 try_delete_file_from_r2 删 R2 对象。
         失败 -> 写 r2_delete_failures 表，不阻塞业务。

    双层防御:
      P2 ORM hook（after_commit）也会扫到这些 keys（通过 session.deleted 事件），
      会自动清理。P1 这里 explicit 重复清理是 idempotent（set 去重），
      即便 P2 没上线也能保证不漏。
    """
    subscription = db.get(ScheduledReportSubscription, subscription_id)
    if not subscription:
        return False

    # 1) 在 db.delete() 之前 collect keys（cascade 触发后 session.deleted 才包含 logs）
    r2_keys = _collect_subscription_r2_keys(db, subscription_id)

    # 2-3) DB 级联删
    db.delete(subscription)
    db.commit()

    # 4) R2 sync-delete（failures via dead-letter table）
    if r2_keys:
        _cleanup_r2_keys(r2_keys, source="subscription_delete",
                         context={"subscription_id": subscription_id})

    logger.info(f"Deleted subscription id={subscription_id} "
                f"(cleaned {len(r2_keys)} R2 objects)")
    return True


def _collect_subscription_r2_keys(db: Session, subscription_id: int) -> set[str]:
    """Collect screenshot_r2_key + screenshot_r2_thumb_key from all delivery logs
    belonging to a subscription. Returns deduplicated set of R2 keys."""
    rows = db.execute(
        select(
            ScheduledReportDeliveryLog.screenshot_r2_key,
            ScheduledReportDeliveryLog.screenshot_r2_thumb_key,
        ).where(ScheduledReportDeliveryLog.subscription_id == subscription_id)
    ).all()
    keys: set[str] = set()
    for main_key, thumb_key in rows:
        for k in (main_key, thumb_key):
            if isinstance(k, str):
                stripped = k.strip()
                if stripped:
                    keys.add(stripped)
    return keys


def _cleanup_r2_keys(keys: set[str], *, source: str, context: dict | None = None) -> None:
    """Sync-delete the given R2 keys. Failures land in r2_delete_failures.

    Failures never propagate (record_delete_failure swallows its own errors
    to avoid polluting caller tx). Logger.warning on each failure.

    Even if a single key raises unexpectedly (e.g. boto3 bug), we keep going
    through the rest. The function is total — it never raises.
    """
    settings = get_settings()
    for key in sorted(keys):
        try:
            result = try_delete_file_from_r2(settings, key, log_failure=False)
        except Exception:
            logger.exception(
                "[r2] _cleanup_r2_keys raised for key=%s (source=%s)",
                key, source,
            )
            continue

        if not result.success:
            logger.warning(
                "[r2] failed to delete %s (source=%s err=%s) - recorded as dead-letter",
                key, source, result.error_class,
            )
            record_delete_failure(
                key, result,
                source=source,
                context=context,
            )


def get_delivery_logs(
    db: Session,
    user_id: int | None = None,
    subscription_id: int | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[ScheduledReportDeliveryLog], int]:
    """获取推送日志。"""
    query = select(ScheduledReportDeliveryLog)
    if subscription_id:
        query = query.where(ScheduledReportDeliveryLog.subscription_id == subscription_id)
    elif user_id is not None:
        sub_ids = select(ScheduledReportSubscription.id).where(
            ScheduledReportSubscription.user_id == user_id
        )
        query = query.where(ScheduledReportDeliveryLog.subscription_id.in_(sub_ids))
    if status:
        query = query.where(ScheduledReportDeliveryLog.status == status)
    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar() or 0
    query = query.order_by(ScheduledReportDeliveryLog.created_at.desc())
    query = query.limit(limit).offset(offset)
    result = db.execute(query)
    return list(result.scalars().all()), total


def create_delivery_log(
    db: Session,
    subscription_id: int,
    frequency: str,
    report_date: str,
    report_month: str | None,
    email: str,
) -> ScheduledReportDeliveryLog:
    """创建推送日志记录。"""
    log = ScheduledReportDeliveryLog(
        subscription_id=subscription_id,
        frequency=frequency,
        report_date=report_date,
        report_month=report_month,
        email=email,
        status=DeliveryStatus.PENDING.value,
        stage=DeliveryStage.PENDING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def create_delivery_log_with_stage(
    db: Session,
    subscription_id: int,
    frequency: str,
    report_date: str,
    report_month: str | None,
    email: str,
    initial_stage: str = DeliveryStage.PENDING.value,
    triggered_by: str = "auto",
) -> ScheduledReportDeliveryLog:
    """创建推送日志记录（带指定初始阶段）。

    Args:
        triggered_by: auto=自动调度；manual=人工补发/重跑（包括 admin force-resend）。
            默认 auto 是为了向后兼容；调用方应显式传入以确保数据可追溯。
    """
    log = ScheduledReportDeliveryLog(
        subscription_id=subscription_id,
        frequency=frequency,
        report_date=report_date,
        report_month=report_month,
        email=email,
        triggered_by=triggered_by,
        status=DeliveryStatus.PENDING.value,
        stage=initial_stage,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def update_delivery_log_stage(db: Session, log_id: int, stage: str) -> None:
    """更新推送日志的处理阶段。"""
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.stage = stage
        db.commit()


def mark_delivery_success(db: Session, log_id: int, resend_id: str | None = None) -> None:
    """标记推送成功。"""
    from datetime import datetime, timezone
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.status = DeliveryStatus.SENT.value
        log.sent_at = datetime.now(timezone.utc)
        db.commit()


def mark_delivery_failed(db: Session, log_id: int, error_message: str) -> None:
    """标记推送失败。"""
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.status = DeliveryStatus.FAILED.value
        log.error_message = error_message
        db.commit()


def update_delivery_log_screenshot(
    db: Session,
    log_id: int,
    screenshot_r2_key: str,
    screenshot_r2_url: str,
    screenshot_r2_thumb_key: str | None = None,
    screenshot_r2_thumb_url: str | None = None,
) -> None:
    """更新推送日志的截图 R2 信息（含缩略图）。"""
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.screenshot_r2_key = screenshot_r2_key
        log.screenshot_r2_url = screenshot_r2_url
        log.screenshot_r2_thumb_key = screenshot_r2_thumb_key
        log.screenshot_r2_thumb_url = screenshot_r2_thumb_url
        db.commit()
        logger.info(f"Updated screenshot for delivery log id={log_id}")


def update_delivery_log_ai_summary(
    db: Session,
    log_id: int,
    ai_summary: str,
) -> None:
    """更新推送日志的 AI 报表总结文案。"""
    log = db.get(ScheduledReportDeliveryLog, log_id)
    if log:
        log.ai_summary = ai_summary
        db.commit()
        logger.info(f"Updated ai_summary for delivery log id={log_id}")
