"""Tests for AI insight Celery migration (BEL-55-P2)."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta

import pytest
from app.core.config import Settings
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@contextmanager
def _yield_context(value: bool):
    yield value


@pytest.fixture()
def eager_celery_app(monkeypatch: pytest.MonkeyPatch):
    """Configure Celery for synchronous task-body tests."""
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://x:x@localhost:5432/x")
    monkeypatch.setenv("REDIS_HOST", "localhost")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("CELERY_RESULT_URL", "redis://localhost:6379/2")

    from app.core import config as config_mod
    from app.tasks import celery_app as celery_app_mod

    config_mod.get_settings.cache_clear()
    fresh = celery_app_mod._build_celery_app()
    fresh.conf.task_always_eager = True
    celery_app_mod.celery_app = fresh
    return fresh


@pytest.fixture()
def db():
    """SQLite in-memory session bound to insight tables."""
    from app.db.session import Base
    from app.models import AIInsight, InsightSchedule, Project  # noqa: F401

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_insight_task_is_registered_and_routed_to_insights_queue(eager_celery_app) -> None:
    """The insight task is the public Celery contract and lands on the insights queue."""
    from app.celery_tasks.insights.generate import generate_insight

    assert generate_insight.name == "generate_insight"

    routes = eager_celery_app.conf.task_routes or {}
    assert routes.get("generate_insight", {}).get("queue") == "insights"


def test_generate_insight_creates_insight_from_schedule_in_eager_mode(
    eager_celery_app,
    db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Scheduled generation only sends an insight id; the task restores schedule data from DB."""
    from app.celery_tasks import insights as insights_mod
    from app.celery_tasks.insights.generate import generate_insight
    from app.models import InsightSchedule, Project

    project_id = 10
    project = Project(id=project_id, project_name="Demo", sort_order=0)
    project_name = project.project_name
    schedule = InsightSchedule(
        id=7,
        project_id=project.id,
        country="US",
        insight_type="daily",
        cron_expression="0 7 * * *",
        date_range_strategy="yesterday",
        model="demo-model",
        is_active=True,
        created_by="tester",
    )
    db.add(project)
    db.add(schedule)
    db.commit()

    called = {}

    def fake_run_insight_generation(insight_id: int, settings, payload: dict, operator: str) -> bool:
        called["insight_id"] = insight_id
        called["payload"] = payload
        called["operator"] = operator
        return True

    monkeypatch.setattr(insights_mod.generate, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(insights_mod.generate, "acquire_remote_semaphore", lambda *_args, **_kwargs: _yield_context(True))
    monkeypatch.setattr(insights_mod.generate, "run_insight_generation", fake_run_insight_generation)

    result = generate_insight.apply(args=[schedule.id]).get()

    assert result["status"] == "completed"
    assert result["insight_id"] is not None
    assert called["insight_id"] == result["insight_id"]
    yesterday = date.today() - timedelta(days=1)
    assert called["payload"] == {
        "project_id": project_id,
        "project_name": project_name,
        "country": "US",
        "start_date": yesterday.isoformat(),
        "end_date": yesterday.isoformat(),
        "model": "demo-model",
        "insight_type": "daily",
    }
    assert called["operator"] == "scheduler:7"

    db.refresh(schedule)
    assert schedule.last_insight_id == result["insight_id"]
    assert schedule.run_count == 1


def test_run_scheduled_insight_enqueues_celery_after_remote_semaphore(
    db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """APScheduler only records the schedule id; Celery restores DB state in the worker."""
    from app.services import insight_schedule_service as service_mod
    from app.models import InsightSchedule

    schedule = InsightSchedule(
        id=9,
        project_id=1,
        country="US",
        insight_type="daily",
        cron_expression="0 7 * * *",
        date_range_strategy="yesterday",
        is_active=True,
        created_by="tester",
    )
    db.add(schedule)
    db.commit()

    delay_called = []

    def fake_delay(schedule_id: int) -> None:
        delay_called.append(schedule_id)

    @contextmanager
    def fake_acquire(*_args, **_kwargs):
        yield True

    def fake_thread(*_args, **_kwargs):
        raise AssertionError("APScheduler should not start an in-process thread")

    monkeypatch.setattr(service_mod, "acquire_remote_semaphore", fake_acquire)
    monkeypatch.setattr("app.celery_tasks.insights.generate.generate_insight.delay", fake_delay)
    monkeypatch.setattr("threading.Thread", fake_thread, raising=True)

    service_mod.run_scheduled_insight(schedule.id)

    assert delay_called == [schedule.id]


def test_run_scheduled_insight_skips_when_remote_semaphore_is_full(
    db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the distributed semaphore is full, the scheduler skips instead of enqueueing."""
    from app.services import insight_schedule_service as service_mod
    from app.models import InsightSchedule

    schedule = InsightSchedule(
        id=9,
        project_id=1,
        country="US",
        insight_type="daily",
        cron_expression="0 7 * * *",
        date_range_strategy="yesterday",
        is_active=True,
        created_by="tester",
    )
    db.add(schedule)
    db.commit()

    @contextmanager
    def fake_acquire(*_args, **_kwargs):
        yield False

    def fake_delay(_schedule_id: int) -> None:
        raise AssertionError("Celery should not be called when semaphore is full")

    monkeypatch.setattr(service_mod, "acquire_remote_semaphore", fake_acquire)
    monkeypatch.setattr("app.celery_tasks.insights.generate.generate_insight.delay", fake_delay)

    service_mod.run_scheduled_insight(schedule.id)


def test_redis_insight_semaphore_limits_concurrent_slots(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Redis semaphore script enforces the configured limit without a live broker."""
    from app.services import insight_concurrency as sem_mod

    class FakeRedis:
        def __init__(self) -> None:
            self.tokens: dict[str, int] = {}

        def eval(self, script: str, _numkeys: int, *args) -> int:
            if "ZREMRANGEBYSCORE" in script:
                limit = int(args[1])
                token = str(args[2])
                now = int(args[3])
                ttl_ms = int(args[4])
                self.tokens = {existing: score for existing, score in self.tokens.items() if score > now}
                if len(self.tokens) < limit:
                    self.tokens[token] = now + ttl_ms
                    return 1
                return 0
            if "ZREM" in script:
                token = str(args[1])
                self.tokens.pop(token, None)
                return 1
            raise AssertionError(script)

    settings = Settings(
        _env_file=None,
        database_url="postgresql+psycopg://x:x@localhost:5432/x",
        redis_host="localhost",
        redis_port=6379,
        redis_db=0,
        max_concurrent_insights=1,
    )
    client = FakeRedis()

    monkeypatch.setattr(sem_mod, "get_settings", lambda: settings)
    monkeypatch.setattr(sem_mod, "get_redis_client", lambda: client)

    first = sem_mod.acquire_remote_semaphore("insights", timeout=0.1)
    second = sem_mod.acquire_remote_semaphore("insights", timeout=0.1)

    with first as acquired:
        assert acquired is True
        assert len(client.tokens) == 1

        with second as acquired_again:
            assert acquired_again is False

    assert len(client.tokens) == 0
