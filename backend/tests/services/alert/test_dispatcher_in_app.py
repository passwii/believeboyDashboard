"""dispatch_batch 站内通知钩子测试。

验证 in_app_enabled=True 的用户会收到 Notification 行，False 则不写。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


def _make_event(eid=1, project_id=3, severity="critical", message="销售额下降 -12%"):
    e = MagicMock()
    e.id = eid
    e.project_id = project_id
    e.severity = severity
    e.message = message
    return e


def _make_pref(in_app_enabled=True, email_enabled=False, min_severity="warning"):
    p = MagicMock()
    p.in_app_enabled = in_app_enabled
    p.email_enabled = email_enabled
    p.min_severity = min_severity
    p.quiet_hours_start = None
    p.quiet_hours_end = None
    return p


def test_dispatch_batch_writes_in_app_notification():
    from app.services.alert import dispatcher

    event = _make_event()
    db = MagicMock()

    with (
        patch.object(
            dispatcher, "_get_notification_recipients", return_value=[{"id": 7}]
        ),
        patch.object(
            dispatcher, "_get_user_by_id", return_value={"id": 7, "email": None}
        ),
        patch.object(
            dispatcher, "_get_preference", return_value=_make_pref(in_app_enabled=True)
        ),
        patch.object(dispatcher, "send_alert_email") as mock_mail,
        patch.object(dispatcher, "Notification") as mock_notif_cls,
    ):
        dispatcher.dispatch_batch(db, [event])

    # in_app 写入：Notification 被构造且 db.add 被调用
    assert mock_notif_cls.called
    kwargs = mock_notif_cls.call_args.kwargs
    assert kwargs["user_id"] == 7
    assert kwargs["type"] == "alert"
    assert kwargs["data"]["alert_event_id"] == 1
    db.add.assert_called()
    # email_enabled=False，不发邮件
    mock_mail.assert_not_called()


def test_dispatch_batch_skips_in_app_when_disabled():
    from app.services.alert import dispatcher

    event = _make_event()
    db = MagicMock()

    with (
        patch.object(
            dispatcher, "_get_notification_recipients", return_value=[{"id": 7}]
        ),
        patch.object(
            dispatcher, "_get_user_by_id", return_value={"id": 7, "email": None}
        ),
        patch.object(
            dispatcher, "_get_preference", return_value=_make_pref(in_app_enabled=False)
        ),
        patch.object(dispatcher, "Notification") as mock_notif_cls,
    ):
        dispatcher.dispatch_batch(db, [event])

    mock_notif_cls.assert_not_called()
