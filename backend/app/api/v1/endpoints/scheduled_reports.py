"""Scheduled Reports API endpoints."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.scheduled_report import (
    DeliveryLogItem,
    DeliveryLogListResponse,
    SubscriptionCreate,
    SubscriptionItem,
    SubscriptionListResponse,
    SubscriptionUpdate,
    TestEmailRequest,
    TestEmailResponse,
    TriggerReportResponse,
)
from app.services.scheduled_report import (
    create_subscription,
    delete_subscription,
    get_delivery_logs,
    get_subscriptions_by_user,
    update_subscription,
)
from app.services.scheduled_report.email_sender import send_test_report_email

router = APIRouter(dependencies=[Depends(protected)])


def _get_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> int | None:
    if x_user_id is None:
        return None
    try:
        return int(x_user_id.strip())
    except (ValueError, TypeError):
        return None


@router.get("/scheduled-reports/subscriptions", response_model=SubscriptionListResponse)
def list_subscriptions(
    frequency: str | None = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    subscriptions = get_subscriptions_by_user(db, user_id, frequency=frequency)
    return SubscriptionListResponse(
        items=[SubscriptionItem.model_validate(s) for s in subscriptions],
        total=len(subscriptions),
    )


@router.post("/scheduled-reports/subscriptions", response_model=SubscriptionItem, status_code=status.HTTP_201_CREATED)
def create_subscription_endpoint(
    data: SubscriptionCreate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    subscription = create_subscription(db, user_id, data)
    return SubscriptionItem.model_validate(subscription)


@router.put("/scheduled-reports/subscriptions/{subscription_id}", response_model=SubscriptionItem)
def update_subscription_endpoint(
    subscription_id: int,
    data: SubscriptionUpdate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    subscription = update_subscription(db, subscription_id, data)
    if not subscription:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    return SubscriptionItem.model_validate(subscription)


@router.delete("/scheduled-reports/subscriptions/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subscription_endpoint(
    subscription_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    deleted = delete_subscription(db, subscription_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")


@router.get("/scheduled-reports/delivery-logs", response_model=DeliveryLogListResponse)
def list_delivery_logs(
    status_filter: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    logs, total = get_delivery_logs(db, user_id=user_id, status=status_filter, limit=limit, offset=offset)
    return DeliveryLogListResponse(
        items=[DeliveryLogItem.model_validate(l) for l in logs],
        total=total,
    )


@router.post("/scheduled-reports/test-email", response_model=TestEmailResponse)
def test_email(
    data: TestEmailRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    success, error = send_test_report_email(data.email, data.frequency)
    if success:
        return TestEmailResponse(success=True, message=f"测试邮件已发送到 {data.email}", resend_id=error)
    return TestEmailResponse(success=False, message=f"发送失败: {error}")
