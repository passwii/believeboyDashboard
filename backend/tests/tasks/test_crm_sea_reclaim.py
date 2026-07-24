"""crm_sea_reclaim Celery 任务 + beat 配置测试（P3a）。"""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


# ---------- settings ----------


def test_reclaim_days_default_15(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CRM_SEA_RECLAIM_DAYS", raising=False)
    assert _settings().crm_sea_reclaim_days == 15


def test_reclaim_days_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRM_SEA_RECLAIM_DAYS", "7")
    assert _settings().crm_sea_reclaim_days == 7


# ---------- beat 配置 ----------


def test_beat_schedule_registers_crm_sea_reclaim() -> None:
    from app.tasks.celery_app import _build_celery_app

    app = _build_celery_app()
    entry = app.conf.beat_schedule.get("crm-sea-reclaim")
    assert entry is not None
    assert entry["task"] == "crm_sea_reclaim"
    assert "app.celery_tasks.crm_sea_reclaim" in app.conf.include
    assert app.conf.task_routes["crm_sea_reclaim"]["queue"] == "default"


# ---------- 任务体 ----------


def test_task_disabled_when_days_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.celery_tasks import crm_sea_reclaim as task_mod
    import app.core.config as config_mod

    monkeypatch.setenv("CRM_SEA_RECLAIM_DAYS", "0")
    config_mod.get_settings.cache_clear()
    try:
        assert task_mod.crm_sea_reclaim.run() == "disabled"
    finally:
        config_mod.get_settings.cache_clear()


def test_task_reclaims_and_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.celery_tasks import crm_sea_reclaim as task_mod
    import app.core.config as config_mod
    import app.db.session as session_mod

    class _FakeDB:
        closed = False

        def close(self):
            self.closed = True

    fake_db = _FakeDB()
    captured = {}

    def _fake_reclaim(db, *, days):
        captured["days"] = days
        captured["db"] = db
        return {"customers": 2, "leads": 3}

    monkeypatch.setenv("CRM_SEA_RECLAIM_DAYS", "15")
    config_mod.get_settings.cache_clear()
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(
        "app.services.crm.sea_reclaim_service.reclaim_stale_to_sea", _fake_reclaim
    )

    try:
        result = task_mod.crm_sea_reclaim.run()
    finally:
        config_mod.get_settings.cache_clear()
    assert result == "reclaimed customers=2 leads=3"
    assert captured["days"] == 15
    assert fake_db.closed is True
