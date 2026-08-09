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

    class _FakeSettings:
        exempt_ratings = "A"
        rating_b_days = 7
        rating_c_days = 7
        rating_d_days = None

    fake_db = _FakeDB()
    captured = {}

    def _fake_reclaim(db, *, days, exempt_ratings=None, rating_days=None):
        captured["days"] = days
        captured["db"] = db
        captured["exempt_ratings"] = exempt_ratings
        captured["rating_days"] = rating_days
        return {"customers": 2, "leads": 3}

    monkeypatch.setenv("CRM_SEA_RECLAIM_DAYS", "15")
    config_mod.get_settings.cache_clear()
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr(
        "app.services.crm.sea_reclaim_service.reclaim_stale_to_sea", _fake_reclaim
    )
    monkeypatch.setattr(
        "app.services.crm.sea_reclaim_service.get_reclaim_settings",
        lambda db: _FakeSettings(),
    )

    try:
        result = task_mod.crm_sea_reclaim.run()
    finally:
        config_mod.get_settings.cache_clear()
    assert result == "reclaimed customers=2 leads=3"
    assert captured["days"] == 15
    assert captured["exempt_ratings"] == {"A"}
    assert captured["rating_days"] == {"B": 7, "C": 7}
    assert fake_db.closed is True


def test_task_passes_rating_overrides_from_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.celery_tasks import crm_sea_reclaim as task_mod
    import app.core.config as config_mod
    import app.db.session as session_mod

    class _FakeDB:
        def close(self):
            pass

    class _FakeSettings:
        exempt_ratings = "A,S"
        rating_b_days = None
        rating_c_days = 10
        rating_d_days = 3

    captured = {}

    def _fake_reclaim(db, *, days, exempt_ratings=None, rating_days=None):
        captured.update(
            days=days, exempt_ratings=exempt_ratings, rating_days=rating_days
        )
        return {"customers": 0, "leads": 0}

    monkeypatch.setenv("CRM_SEA_RECLAIM_DAYS", "15")
    config_mod.get_settings.cache_clear()
    monkeypatch.setattr(session_mod, "SessionLocal", lambda: _FakeDB())
    monkeypatch.setattr(
        "app.services.crm.sea_reclaim_service.reclaim_stale_to_sea", _fake_reclaim
    )
    monkeypatch.setattr(
        "app.services.crm.sea_reclaim_service.get_reclaim_settings",
        lambda db: _FakeSettings(),
    )

    try:
        task_mod.crm_sea_reclaim.run()
    finally:
        config_mod.get_settings.cache_clear()
    assert captured["days"] == 15
    assert captured["exempt_ratings"] == {"A", "S"}
    # NULL 的档位不进入 rating_days（回落全局阈值）；其余覆盖生效
    assert captured["rating_days"] == {"C": 10, "D": 3}
