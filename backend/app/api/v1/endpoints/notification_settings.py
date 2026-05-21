"""Notification Settings API endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models.notification_subscription import NotificationSubscription
from app.schemas.notification import (
    SubscriptionCreate,
    SubscriptionItem,
    SubscriptionListResponse,
    SubscriptionUpdate,
    TestEmailRequest,
    TestEmailResponse,
)
from app.services import project_service
from app.services.notification_service import (
    create_subscription,
    delete_subscription,
    get_subscriptions_by_project,
    update_subscription,
)
from app.services.scheduled_report.email_sender import send_test_report_email

router = APIRouter(prefix="/notification-settings", tags=["notification-settings"], dependencies=[Depends(protected)])


def _get_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> int | None:
    if x_user_id is None:
        return None
    try:
        return int(x_user_id.strip())
    except (ValueError, TypeError):
        return None


@router.get("/subscriptions", response_model=SubscriptionListResponse)
def list_subscriptions(
    project_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> SubscriptionListResponse:
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    subs = get_subscriptions_by_project(db, project_id)
    return SubscriptionListResponse(
        items=[SubscriptionItem.model_validate(s) for s in subs],
        total=len(subs),
    )


@router.post("/subscriptions", response_model=SubscriptionItem, status_code=201)
def create_subscription_endpoint(
    data: SubscriptionCreate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> SubscriptionItem:
    project_service.ensure_project_access(db, data.project_id, operator=operator, is_admin=bool(is_admin))
    user_id = _get_user_id()
    sub = create_subscription(db, data, user_id)
    return SubscriptionItem.model_validate(sub)


@router.put("/subscriptions/{subscription_id}", response_model=SubscriptionItem)
def update_subscription_endpoint(
    subscription_id: int,
    data: SubscriptionUpdate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> SubscriptionItem:
    sub = update_subscription(db, subscription_id, data)
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    project_service.ensure_project_access(db, sub.project_id, operator=operator, is_admin=bool(is_admin))
    return SubscriptionItem.model_validate(sub)


@router.delete("/subscriptions/{subscription_id}", status_code=204)
def delete_subscription_endpoint(
    subscription_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    sub = db.query(NotificationSubscription).filter(NotificationSubscription.id == subscription_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")
    project_service.ensure_project_access(db, sub.project_id, operator=operator, is_admin=bool(is_admin))
    delete_subscription(db, subscription_id)


@router.post("/subscriptions/{subscription_id}/test", response_model=TestEmailResponse)
def test_subscription_email(
    subscription_id: int,
    data: TestEmailRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> TestEmailResponse:
    sub = db.query(NotificationSubscription).filter(NotificationSubscription.id == subscription_id).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Subscription not found")

    recipients = data.test_recipients or sub.recipients
    if not recipients:
        return TestEmailResponse(success=False, message="无收件人配置")

    success, resend_id = send_test_report_email(recipients[0], sub.frequency)
    if success:
        return TestEmailResponse(success=True, message=f"测试邮件已发送到 {recipients[0]}", resend_id=resend_id)
    return TestEmailResponse(success=False, message=f"发送失败: {resend_id}")