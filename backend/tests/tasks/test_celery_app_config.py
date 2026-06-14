"""Tests for app.tasks.celery_app — pins the broker/backend auto-derivation
and the explicit override behavior described in BEL-55-P0.

The smoke-test round-trip via a running worker is exercised in
`tests/services/test_celery_ping.py` (integration). This file focuses on the
*configuration* layer so failures point at a single attribute.
"""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _settings(**overrides) -> Settings:
    """Build a Settings instance without going through the lru_cache."""
    return Settings(_env_file=None, **overrides)


def test_default_broker_uses_redis_db_plus_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """With blank CELERY_BROKER_URL, broker URL is redis_db+1."""
    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6380")
    monkeypatch.setenv("REDIS_DB", "3")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    monkeypatch.delenv("CELERY_RESULT_URL", raising=False)
    s = _settings()
    assert s._celery_broker_url_resolved == "redis://redis.local:6380/4"
    assert s._celery_result_url_resolved == "redis://redis.local:6380/5"


def test_explicit_broker_url_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    """When CELERY_BROKER_URL is set, it overrides the auto-derived value."""
    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://other-host:9999/7")
    monkeypatch.setenv("CELERY_RESULT_URL", "redis://other-host:9999/8")
    s = _settings()
    assert s._celery_broker_url_resolved == "redis://other-host:9999/7"
    assert s._celery_result_url_resolved == "redis://other-host:9999/8"


def test_password_is_url_encoded(monkeypatch: pytest.MonkeyPatch) -> None:
    """Special chars in REDIS_PASSWORD must be percent-encoded in the URL."""
    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("REDIS_PASSWORD", "p@ss/w:ord")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    s = _settings()
    # '@', '/', ':' all percent-encoded
    assert s._celery_broker_url_resolved == "redis://:p%40ss%2Fw%3Aord@redis.local:6379/1"


def test_no_password_omits_auth_segment(monkeypatch: pytest.MonkeyPatch) -> None:
    """When REDIS_PASSWORD is empty, URL has no `:<pwd>@` segment."""
    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("REDIS_PASSWORD", "")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    s = _settings()
    assert s._celery_broker_url_resolved == "redis://redis.local:6379/1"


def test_concurrency_default_is_four(monkeypatch: pytest.MonkeyPatch) -> None:
    """CELERY_WORKER_CONCURRENCY defaults to 4 per BEL-55-P0 spec."""
    monkeypatch.delenv("CELERY_WORKER_CONCURRENCY", raising=False)
    s = _settings()
    assert s.celery_worker_concurrency == 4


def test_concurrency_override(monkeypatch: pytest.MonkeyPatch) -> None:
    """CELERY_WORKER_CONCURRENCY override is honored."""
    monkeypatch.setenv("CELERY_WORKER_CONCURRENCY", "8")
    s = _settings()
    assert s.celery_worker_concurrency == 8


def test_celery_app_required_config(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Celery app exposes every config item the BEL-55-P0 spec lists."""
    monkeypatch.setenv("REDIS_HOST", "redis.local")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.delenv("CELERY_BROKER_URL", raising=False)
    monkeypatch.delenv("CELERY_RESULT_URL", raising=False)
    monkeypatch.setenv("CELERY_WORKER_CONCURRENCY", "4")

    # Reset the lru_cache so the singleton reflects the new env.
    from app.core import config as config_mod
    from app.tasks import celery_app as celery_app_mod

    config_mod.get_settings.cache_clear()
    celery_app_mod.celery_app  # ensure module is imported post-reset

    # Rebuild the Celery app from scratch against the cleared Settings.
    fresh = celery_app_mod._build_celery_app()
    conf = fresh.conf
    assert conf.task_acks_late is True
    assert conf.task_reject_on_worker_lost is True
    assert conf.worker_prefetch_multiplier == 1
    assert conf.task_default_queue == "default"
    assert conf.timezone == "Asia/Shanghai"
    assert conf.broker_url == "redis://redis.local:6379/1"
    assert conf.result_backend == "redis://redis.local:6379/2"
    assert conf.worker_concurrency == 4
    assert "app.celery_tasks.ping" in fresh.conf.include
    assert "app.celery_tasks.insights.generate" in fresh.conf.include
    assert fresh.conf.task_routes["generate_insight"]["queue"] == "insights"
