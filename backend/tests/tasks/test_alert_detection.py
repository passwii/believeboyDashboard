"""alert_detect Celery 任务单测：mock 检测器与分发器，验证调用链与提交。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


def test_alert_detect_no_events_skips_dispatch():
    from app.celery_tasks.alert_detection import alert_detect

    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch(
            "app.celery_tasks.alert_detection.detect_anomalies", return_value=[]
        ) as mock_detect,
        patch("app.celery_tasks.alert_detection.dispatch_batch") as mock_dispatch,
    ):
        db = MagicMock()
        mock_sl.return_value = db
        result = alert_detect()

    mock_detect.assert_called_once_with(db)
    db.commit.assert_called_once()
    mock_dispatch.assert_not_called()
    db.close.assert_called_once()
    assert "events=0" in result


def test_alert_detect_with_events_dispatches():
    from app.celery_tasks.alert_detection import alert_detect

    fake_events = [MagicMock(), MagicMock()]
    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch(
            "app.celery_tasks.alert_detection.detect_anomalies",
            return_value=fake_events,
        ),
        patch("app.celery_tasks.alert_detection.dispatch_batch") as mock_dispatch,
    ):
        db = MagicMock()
        mock_sl.return_value = db
        result = alert_detect()

    mock_dispatch.assert_called_once_with(db, fake_events)
    db.close.assert_called_once()
    assert "events=2" in result


def test_alert_detect_closes_db_on_error():
    from app.celery_tasks.alert_detection import alert_detect

    with (
        patch("app.celery_tasks.alert_detection.SessionLocal") as mock_sl,
        patch(
            "app.celery_tasks.alert_detection.detect_anomalies",
            side_effect=RuntimeError("boom"),
        ),
    ):
        db = MagicMock()
        mock_sl.return_value = db
        try:
            alert_detect()
        except RuntimeError:
            pass

    db.close.assert_called_once()
