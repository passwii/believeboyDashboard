"""crm_stale_email Celery 任务 + beat 配置测试（P9-2, BLF-540）。"""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


# ---------- beat 配置 ----------


def test_beat_schedule_registers_crm_stale_email() -> None:
    from app.tasks.celery_app import _build_celery_app

    app = _build_celery_app()
    entry = app.conf.beat_schedule.get("crm-stale-email")
    assert entry is not None
    assert entry["task"] == "crm_stale_email"
    assert "app.celery_tasks.crm_stale_email" in app.conf.include
    assert app.conf.task_routes["crm_stale_email"]["queue"] == "default"


# ---------- 任务体 ----------


def test_task_disabled_when_email_off(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.celery_tasks import crm_stale_email as task_mod
    import app.db.session as session_mod
    import app.services.crm.stale_email_service as svc_mod

    class _FakeDB:
        closed = False

        def close(self):
            self.closed = True

    fake_db = _FakeDB()

    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(
        svc_mod, "send_stale_reminder_emails", lambda db: {"disabled": True}
    )
    assert task_mod.crm_stale_email.run() == "disabled"
    assert fake_db.closed is True


def test_task_sends_and_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.celery_tasks import crm_stale_email as task_mod
    import app.db.session as session_mod
    import app.services.crm.stale_email_service as svc_mod

    class _FakeDB:
        closed = False

        def close(self):
            self.closed = True

    fake_db = _FakeDB()
    captured = {}

    def _fake_send(db):
        captured["db"] = db
        return {
            "disabled": False,
            "emails_sent": 2,
            "customers": 1,
            "leads": 2,
            "owners_emailed": 2,
            "owners_without_email": 1,
        }

    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(svc_mod, "send_stale_reminder_emails", _fake_send)
    result = task_mod.crm_stale_email.run()
    assert result == "emails=2 customers=1 leads=2"
    assert captured["db"] is fake_db
    assert fake_db.closed is True
