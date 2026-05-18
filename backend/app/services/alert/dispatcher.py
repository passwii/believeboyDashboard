"""Alert dispatcher — sends notifications for triggered events."""

from __future__ import annotations

import logging
from datetime import datetime, time
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import AlertEvent, AlertPreference
from app.services.alert.email_service import send_alert_email

logger = logging.getLogger(__name__)


def dispatch_alert(db: Session, event: AlertEvent) -> None:
    """Dispatch a single alert event to appropriate channels."""
    users = _get_notification_recipients(db, event.project_id)
    if not users:
        logger.warning(f"No users to notify for alert event {event.id}")
        return

    for user in users:
        pref = _get_preference(db, user["id"])
        if not pref:
            pref = _create_default_preference(db, user["id"])

        if not pref.email_enabled:
            continue

        if not _meets_severity_threshold(event.severity, pref.min_severity):
            continue

        if _in_quiet_hours(pref):
            continue

        if user.get("email"):
            success = send_alert_email(user["email"], [event])
            if success:
                logger.info(f"Alert {event.id} dispatched to {user['email']}")
            else:
                logger.warning(f"Failed to dispatch alert {event.id} to {user['email']}")


def dispatch_batch(db: Session, events: list[AlertEvent]) -> None:
    """Dispatch multiple events in batch, grouped by user."""
    from collections import defaultdict
    by_user: dict[int, list[AlertEvent]] = defaultdict(list)

    for event in events:
        users = _get_notification_recipients(db, event.project_id)
        for user in users:
            by_user[user["id"]].append(event)

    for user_id, user_events in by_user.items():
        user_row = _get_user_by_id(db, user_id)
        if not user_row or not user_row.get("email"):
            continue

        pref = _get_preference(db, user_id) or _create_default_preference(db, user_id)
        if not pref.email_enabled:
            continue

        filtered = [e for e in user_events if _meets_severity_threshold(e.severity, pref.min_severity)]
        filtered = [e for e in filtered if not _in_quiet_hours(pref)]

        if filtered and user_row.get("email"):
            send_alert_email(user_row["email"], filtered)


def _get_notification_recipients(db: Session, project_id: int) -> list[dict[str, Any]]:
    """Get users associated with a project (operators + admins) via raw SQL."""
    project_op_row = db.execute(
        text(
            "SELECT operator_id FROM projects WHERE id = :pid"
        ),
        {"pid": project_id}
    ).fetchone()

    recipients: list[dict[str, Any]] = []
    seen: set[int] = set()

    if project_op_row and project_op_row[0]:
        op_id = int(project_op_row[0])
        user = _get_user_by_id(db, op_id)
        if user:
            recipients.append(user)
            seen.add(op_id)

    admins = db.execute(
        text("SELECT id, name, email, operator_name_zh FROM users WHERE is_admin = true")
    ).fetchall()
    for row in admins:
        uid = int(row[0])
        if uid not in seen:
            seen.add(uid)
            recipients.append({"id": uid, "name": row[1], "email": row[2], "operator_name_zh": row[3]})

    return recipients


def _get_user_by_id(db: Session, user_id: int) -> dict[str, Any] | None:
    row = db.execute(
        text("SELECT id, name, email, operator_name_zh FROM users WHERE id = :uid"),
        {"uid": user_id}
    ).fetchone()
    if row:
        return {"id": int(row[0]), "name": row[1], "email": row[2], "operator_name_zh": row[3]}
    return None


def _get_preference(db: Session, user_id: int) -> AlertPreference | None:
    return db.query(AlertPreference).filter(AlertPreference.user_id == user_id).first()


def _create_default_preference(db: Session, user_id: int) -> AlertPreference:
    pref = AlertPreference(
        user_id=user_id,
        email_enabled=True,
        in_app_enabled=True,
        min_severity="warning",
    )
    db.add(pref)
    db.flush()
    return pref


def _meets_severity_threshold(severity: str, min_severity: str) -> bool:
    order = {"info": 0, "warning": 1, "critical": 2}
    return order.get(severity, 0) >= order.get(min_severity, 1)


def _in_quiet_hours(pref: AlertPreference) -> bool:
    if not pref.quiet_hours_start or not pref.quiet_hours_end:
        return False
    now = datetime.now().time()
    start = pref.quiet_hours_start
    end = pref.quiet_hours_end
    if start <= end:
        return start <= now <= end
    else:
        return now >= start or now <= end