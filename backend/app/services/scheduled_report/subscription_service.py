"""Subscription CRUD service for scheduled reports."""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.models import ScheduledReportSubscription, ScheduledReportDeliveryLog
from app.models.scheduled_report import DeliveryStatus, DeliveryStage
from app.schemas.scheduled_report import SubscriptionCreate, SubscriptionUpdate

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
    """删除订阅。"""
    subscription = db.get(ScheduledReportSubscription, subscription_id)
    if not subscription:
        return False
    db.delete(subscription)
    db.commit()
    logger.info(f"Deleted subscription id={subscription_id}")
    return True


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
) -> ScheduledReportDeliveryLog:
    """创建推送日志记录（带指定初始阶段）。"""
    log = ScheduledReportDeliveryLog(
        subscription_id=subscription_id,
        frequency=frequency,
        report_date=report_date,
        report_month=report_month,
        email=email,
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
