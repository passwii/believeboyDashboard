"""Notification service - business logic for subscriptions."""

from sqlalchemy.orm import Session

from app.models.notification_subscription import NotificationSubscription
from app.schemas.notification import (
    SubscriptionCreate,
    SubscriptionUpdate,
)


def get_subscriptions_by_project(db: Session, project_id: int) -> list[NotificationSubscription]:
    return db.query(NotificationSubscription).filter(
        NotificationSubscription.project_id == project_id
    ).order_by(NotificationSubscription.created_at.desc()).all()


def create_subscription(db: Session, data: SubscriptionCreate, user_id: int | None) -> NotificationSubscription:
    sub = NotificationSubscription(
        **data.model_dump(),
        created_by=user_id,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def update_subscription(db: Session, sub_id: int, data: SubscriptionUpdate) -> NotificationSubscription | None:
    sub = db.query(NotificationSubscription).filter(NotificationSubscription.id == sub_id).first()
    if not sub:
        return None
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(sub, field, value)
    db.commit()
    db.refresh(sub)
    return sub


def delete_subscription(db: Session, sub_id: int) -> bool:
    sub = db.query(NotificationSubscription).filter(NotificationSubscription.id == sub_id).first()
    if not sub:
        return False
    db.delete(sub)
    db.commit()
    return True