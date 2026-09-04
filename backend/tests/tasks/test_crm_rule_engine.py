"""crm_rule_engine Celery 任务 + beat 配置测试（P9-6, BLF-544）。"""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, **overrides)


# ---------- settings ----------


def test_rule_engine_enabled_default_true(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CRM_RULE_ENGINE_ENABLED", raising=False)
    assert _settings().crm_rule_engine_enabled is True


def test_rule_engine_enabled_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRM_RULE_ENGINE_ENABLED", "false")
    assert _settings().crm_rule_engine_enabled is False


# ---------- beat 配置 ----------


def test_beat_schedule_registers_crm_rule_engine() -> None:
    from app.tasks.celery_app import _build_celery_app

    app = _build_celery_app()
    entry = app.conf.beat_schedule.get("crm-rule-engine")
    assert entry is not None
    assert entry["task"] == "crm_rule_engine"
    assert "app.celery_tasks.crm_rule_engine" in app.conf.include
    assert app.conf.task_routes["crm_rule_engine"]["queue"] == "default"


# ---------- 任务体 ----------


def test_task_disabled_when_flag_false(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.config as config_mod
    from app.celery_tasks import crm_rule_engine as task_mod

    monkeypatch.setenv("CRM_RULE_ENGINE_ENABLED", "false")
    config_mod.get_settings.cache_clear()
    try:
        assert task_mod.crm_rule_engine.run() == "disabled"
    finally:
        config_mod.get_settings.cache_clear()


def test_task_calls_scan_rules_and_reports(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.core.config as config_mod
    import app.db.session as session_mod
    from app.celery_tasks import crm_rule_engine as task_mod

    class _FakeDB:
        closed = False
        committed = False

        def close(self):
            self.closed = True

        def commit(self):
            self.committed = True

    fake_db = _FakeDB()
    captured = {}

    def _fake_scan(db, *, now=None):
        captured["db"] = db
        return {
            "rules_evaluated": 2,
            "rules_skipped_unsupported": 0,
            "entities_matched": 3,
            "notify_created": 2,
            "notify_skipped_active": 1,
            "notify_skipped_no_owner": 0,
        }

    monkeypatch.setattr(session_mod, "SessionLocal", lambda: fake_db)
    monkeypatch.setattr("app.services.crm.rule_engine_service.scan_rules", _fake_scan)
    config_mod.get_settings.cache_clear()
    try:
        result = task_mod.crm_rule_engine.run()
    finally:
        config_mod.get_settings.cache_clear()

    assert result == "rules=2 skipped=0 matched=3 created=2"
    assert captured["db"] is fake_db
    assert fake_db.committed is True  # scan_rules 只 flush，任务统一 commit 防回滚
    assert fake_db.closed is True
