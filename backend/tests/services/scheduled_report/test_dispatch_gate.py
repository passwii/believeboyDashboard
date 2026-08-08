"""BLF-533 门禁接入测试：auto 调度无写文件动作 → 不推进（failed log），manual 放行。

通过直接调用 `dispatcher._dispatch_one_task_body` 并 stub 掉下游 builder/sender：
- auto + 无写动作：创建 failed delivery_log、不调用 builder/sender、返回 no_write_action；
- auto + 有写动作：正常调用 builder/sender 流程；
- manual（补发）：即使无写动作也放行（用户手动操作可能已补传数据）。
"""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.project import Project
from app.models.report_upload_log import ReportUploadLog
from app.models.scheduled_report import (
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportSubscription,
)


@pytest.fixture()
def db(monkeypatch):
    """内存库 + 让 dispatcher/ledger 的 SessionLocal 指向同一引擎。"""
    import app.services.scheduled_report.dispatcher as dispatcher_mod
    import app.services.scheduled_report.ledger_service as ledger_mod

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr(dispatcher_mod, "SessionLocal", factory)
    session = factory()
    try:
        yield session
    finally:
        session.close()


def _seed(
    db, *, project_ids: str = "15", country: str = "US", frequency: str = "daily"
) -> ScheduledReportSubscription:
    proj = Project(id=15, project_name="测试店铺A", sort_order=15)
    db.add(proj)
    sub = ScheduledReportSubscription(
        user_id=1,
        email="ops@example.com",
        project_ids=project_ids,
        country=country,
        frequency=frequency,
        dispatch_hour=15,
        dispatch_minute=0,
        enabled=True,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def _add_upload_log(db, *, project_id: int = 15, country: str = "US") -> None:
    db.add(
        ReportUploadLog(
            project_id=project_id,
            report_type="sales_report",
            country=country,
            upload_date=date(2026, 8, 8),
            has_real_data=True,
        )
    )
    db.commit()


@pytest.fixture(autouse=True)
def _patch_downstream(monkeypatch):
    """Stub out the heavy downstream so tests don't render/send/AI."""
    import app.services.scheduled_report.dispatcher as dispatcher_mod

    def fake_build(*args, **kwargs):
        return {"sales": {}, "country": "US", "log_id": kwargs.get("log_id")}

    monkeypatch.setattr(dispatcher_mod, "_build_report_with_throttle", fake_build)
    monkeypatch.setattr(dispatcher_mod, "_build_multi_country_report", fake_build)

    def fake_send(*args, **kwargs):
        return True, "fake-resend-id"

    monkeypatch.setattr(dispatcher_mod, "send_scheduled_report_email", fake_send)
    monkeypatch.setattr(dispatcher_mod, "send_weekly_report_email", fake_send)
    monkeypatch.setattr(dispatcher_mod, "send_monthly_report_email", fake_send)

    # AI summary Celery spawn — no broker in unit test
    monkeypatch.setattr(
        "app.celery_tasks.ai_summary.generate_delivery_summary",
        type("Fake", (), {"delay": lambda *a, **k: None})(),
    )


def _call_body(db, sub, triggered_by="auto"):
    from app.services.scheduled_report.dispatcher import _dispatch_one_task_body

    return _dispatch_one_task_body(
        subscription_id=sub.id,
        email=sub.email,
        project_ids=sub.project_id_list or None,
        country=sub.country,
        frequency=sub.frequency,
        triggered_by=triggered_by,
        report_date="2026-08-08",
    )


def test_auto_no_write_action_creates_failed_log_and_skips(db):
    sub = _seed(db)

    with patch(
        "app.services.scheduled_report.data_gate.has_write_action",
        return_value=False,
    ):
        result = _call_body(db, sub, triggered_by="auto")

    assert result["success"] is False
    assert result["skipped"] is True
    assert result["skipped_reason"] == "no_write_action"

    logs = db.query(ScheduledReportDeliveryLog).all()
    assert len(logs) == 1
    assert logs[0].status == DeliveryStatus.FAILED.value
    assert "当日无数据写入动作" in (logs[0].error_message or "")


def test_auto_with_write_action_proceeds(db):
    sub = _seed(db)

    with patch(
        "app.services.scheduled_report.data_gate.has_write_action",
        return_value=True,
    ):
        result = _call_body(db, sub, triggered_by="auto")

    assert result["success"] is True
    logs = db.query(ScheduledReportDeliveryLog).all()
    assert len(logs) == 1
    assert logs[0].status == DeliveryStatus.SENT.value


def test_manual_bypasses_gate_even_without_write_action(db):
    """补发路径（triggered_by=manual）即使无写动作也放行。"""
    sub = _seed(db)

    with patch(
        "app.services.scheduled_report.data_gate.has_write_action",
        return_value=False,
    ):
        result = _call_body(db, sub, triggered_by="manual")

    assert result["success"] is True
    logs = db.query(ScheduledReportDeliveryLog).all()
    assert len(logs) == 1
    assert logs[0].status == DeliveryStatus.SENT.value
