"""站内通知端点。

用户识别走 X-User-Id header（代理从 session 注入），与 alerts preferences 一致。
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, protected
from app.models.notification import Notification
from app.schemas.notification import (
    NotificationItem,
    NotificationListResponse,
    UnreadCountResponse,
)

router = APIRouter(
    prefix="/notifications", tags=["notifications"], dependencies=[Depends(protected)]
)


def _require_user_id(x_user_id: str | None) -> int:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="X-User-Id required")
    try:
        return int(x_user_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid X-User-Id")


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    type: str | None = Query(default=None),
    read: bool | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> NotificationListResponse:
    user_id = _require_user_id(x_user_id)
    q = db.query(Notification).filter(Notification.user_id == user_id)
    if type:
        q = q.filter(Notification.type == type)
    if read is not None:
        q = q.filter(Notification.read == read)
    total = q.count()
    offset = (page - 1) * page_size
    items = (
        q.order_by(Notification.created_at.desc()).offset(offset).limit(page_size).all()
    )
    return NotificationListResponse(
        items=items, total=total, page=page, page_size=page_size
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
def unread_count(
    db: Session = Depends(get_read_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> UnreadCountResponse:
    user_id = _require_user_id(x_user_id)
    count = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read == False)  # noqa: E712
        .count()
    )
    return UnreadCountResponse(count=count)


@router.post("/{notification_id}/read", response_model=NotificationItem)
def mark_read(
    notification_id: int,
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> Notification:
    user_id = _require_user_id(x_user_id)
    notif = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.read = True
    notif.read_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(notif)
    return notif


@router.post("/read-all", response_model=UnreadCountResponse)
def mark_all_read(
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> UnreadCountResponse:
    user_id = _require_user_id(x_user_id)
    updated = (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read == False)  # noqa: E712
        .update(
            {Notification.read: True, Notification.read_at: datetime.now(timezone.utc)},
            synchronize_session=False,
        )
    )
    db.commit()
    return UnreadCountResponse(count=updated)


@router.delete("/{notification_id}", status_code=204)
def delete_notification(
    notification_id: int,
    db: Session = Depends(get_primary_db_session),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
):
    user_id = _require_user_id(x_user_id)
    notif = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if not notif:
        raise HTTPException(status_code=404, detail="Notification not found")
    db.delete(notif)
    db.commit()
