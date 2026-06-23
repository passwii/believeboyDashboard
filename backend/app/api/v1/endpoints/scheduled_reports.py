"""Scheduled Reports API endpoints."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.models.scheduled_report import ScheduledReportSubscription
from app.schemas.scheduled_report import (
    DeliveryLogItem,
    DeliveryLogListResponse,
    LedgerListResponse,
    LedgerResendResponse,
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
from app.services.scheduled_report.email_sender_daily import send_scheduled_report_email, send_test_report_email
from app.services.scheduled_report.email_sender_weekly import send_weekly_report_email
from app.services.scheduled_report.report_builder_daily import build_report_email_data
from app.services.scheduled_report.report_builder_weekly import build_weekly_report_data

router = APIRouter(dependencies=[Depends(protected)])


def _get_user_id(x_user_id: str | None = Header(default=None, alias="X-User-Id")) -> int | None:
    if x_user_id is None:
        return None
    try:
        return int(x_user_id.strip())
    except (ValueError, TypeError):
        return None


def require_admin(is_admin: bool = Header(default=False, alias="X-Is-Admin")) -> bool:
    """管理员专属依赖：手动触发调度、ledger 补发等。"""
    if not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="需要管理员权限")
    return True


def assert_subscription_owner(
    subscription: "ScheduledReportSubscription | None",
    user_id: int | None,
    is_admin: bool,
) -> None:
    """订阅归属校验：admin 可跨用户操作；operator 仅能管理自己的订阅。

    非 admin 看不到、也改不了他人订阅，统一返回 404 防枚举。
    """
    if is_admin:
        return
    if subscription is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    if user_id is None or subscription.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")


@router.get("/scheduled-reports/subscriptions", response_model=SubscriptionListResponse)
def list_subscriptions(
    frequency: str | None = None,
    db: Session = Depends(get_read_db_session),
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
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    existing = db.get(ScheduledReportSubscription, subscription_id)
    assert_subscription_owner(existing, user_id, is_admin)
    subscription = update_subscription(db, subscription_id, data)
    if not subscription:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")
    return SubscriptionItem.model_validate(subscription)


@router.delete("/scheduled-reports/subscriptions/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subscription_endpoint(
    subscription_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _get_user_id(x_user_id)
    existing = db.get(ScheduledReportSubscription, subscription_id)
    assert_subscription_owner(existing, user_id, is_admin)
    deleted = delete_subscription(db, subscription_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subscription not found")


@router.get("/scheduled-reports/delivery-logs", response_model=DeliveryLogListResponse)
def list_delivery_logs(
    status_filter: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_read_db_session),
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    # Parse project_ids
    project_ids: list[int] | None = None
    if data.project_ids and data.project_ids != "*":
        try:
            project_ids = [int(pid.strip()) for pid in data.project_ids.split(",") if pid.strip()]
        except ValueError:
            project_ids = None

    # Parse country list — support multi-country subscriptions
    parsed_countries = [c.strip().upper() for c in data.country.split(",") if c.strip()]

    # Aggregate real data from the database
    try:
        if len(parsed_countries) > 1:
            from app.services.scheduled_report.dispatcher import _build_multi_country_report
            report_data = _build_multi_country_report(
                project_ids=project_ids,
                country_list=parsed_countries,
                frequency=data.frequency,
                ai_model=data.ai_model,
            )
        elif data.frequency == "weekly":
            report_data = build_weekly_report_data(
                db=db,
                project_ids=project_ids,
                country=parsed_countries[0] if parsed_countries else "US",
            )
        else:
            report_data = build_report_email_data(
                db=db,
                project_ids=project_ids,
                country=parsed_countries[0] if parsed_countries else "US",
                frequency=data.frequency,
                ai_model=data.ai_model,
            )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"数据聚合失败: {e}",
        )

    # Send full report email with real data
    if data.frequency == "weekly":
        success, error = send_weekly_report_email(data.email, report_data)
    else:
        success, error = send_scheduled_report_email(data.email, data.frequency, report_data)
    if success:
        return TestEmailResponse(success=True, message=f"测试报告已发送到 {data.email}（含真实数据）", resend_id=error)
    return TestEmailResponse(success=False, message=f"发送失败: {error}")


@router.get("/scheduled-reports/ledger", response_model=LedgerListResponse)
def get_scheduled_report_ledger(
    start_date: str,
    end_date: str,
    frequency: str = "all",
    status_filter: str = "all",
    project_id: int | None = None,
    email: str | None = None,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    if frequency not in ("all", "daily", "weekly", "monthly"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="frequency 参数无效")
    if status_filter not in ("all", "sent", "failed", "missing"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="status_filter 参数无效")
    if limit < 1 or limit > 500:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="limit 必须在 1-500 之间")

    from app.services.scheduled_report.ledger_service import refresh_ledger

    try:
        return refresh_ledger(
            db,
            start_date=start_date,
            end_date=end_date,
            frequency=frequency,
            status=status_filter,
            project_id=project_id,
            email=email,
            limit=limit,
            offset=offset,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


@router.post("/scheduled-reports/ledger/{ledger_key}/resend", response_model=LedgerResendResponse)
def resend_scheduled_report_ledger_entry(
    ledger_key: str,
    force: bool = False,
    ai_model: Optional[str] = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    _: bool = Depends(require_admin),
):
    from app.services.scheduled_report.ledger_service import resend_ledger_entry_async

    # 前端可临时覆盖订阅预设模型；为空或纯空白则使用订阅预设
    override_ai_model = ai_model.strip() if ai_model else None

    success, delivery_log_id, new_status, message = resend_ledger_entry_async(
        db, ledger_key=ledger_key, ignore_status=force, override_ai_model=override_ai_model
    )
    if new_status == "not_found":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=message)
    if not success and new_status == "sent":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=message)
    return LedgerResendResponse(
        success=success,
        ledger_key=ledger_key,
        delivery_log_id=delivery_log_id,
        status=new_status,
        message=message,
    )


@router.post("/scheduled-reports/trigger", response_model=TriggerReportResponse)
def trigger_report_dispatch(
    frequency: str = "daily",
    operator: str | None = Depends(get_request_operator),
    _: bool = Depends(require_admin),
):
    """手动触发指定频率的报告调度（仅管理员）。

    用于测试或补发，会走完整的 dispatcher 流程（限流 + 缓存）。
    """
    if frequency not in ("daily", "weekly", "monthly"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="frequency 必须为 daily/weekly/monthly")

    import threading
    from app.services.scheduled_report.dispatcher import dispatch_reports

    # Run in background thread to avoid blocking the request
    thread = threading.Thread(target=dispatch_reports, args=(frequency,), daemon=True)
    thread.start()

    return TriggerReportResponse(
        success=True,
        frequency=frequency,
        subscriptions_affected=0,
        message=f"{frequency} 报告调度已启动（后台执行中），请查看日志或推送记录确认结果。",
    )
