"""Tests for `app.celery_tasks.run_job` (BEL-55-P1).

Runs the Celery task body in `task_always_eager=True` mode so we don't
need a live broker for unit tests. The integration round-trip via a
real worker is exercised in `test_celery_ping_round_trip.py`; this file
focuses on the task body, the route registration, and the idempotency
guarantees the PR description claims.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Force Celery into eager mode BEFORE the task module is imported so the
# `bind=True` task body runs synchronously inside the test process.
pytest.importorskip("celery")


@pytest.fixture()
def eager_celery_app(monkeypatch: pytest.MonkeyPatch):
    """Configure the singleton Celery app for eager (synchronous) execution.

    The `bind=True` task body still has a real `self.request.id` in eager
    mode (it's a UUID string), so assertions on `task_id` in
    `log_excerpt` work the same as they would in a real worker.
    """
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://x:x@localhost:5432/x")
    monkeypatch.setenv("REDIS_HOST", "localhost")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("CELERY_RESULT_URL", "redis://localhost:6379/2")
    monkeypatch.setenv("ENABLE_CELERY_DISPATCH", "true")

    # Reset the lru-cached Settings + rebuild the Celery app so the
    # eager-mode flag takes effect.
    from app.core import config as config_mod
    from app.tasks import celery_app as celery_app_mod

    config_mod.get_settings.cache_clear()
    fresh = celery_app_mod._build_celery_app()
    fresh.conf.task_always_eager = True
    celery_app_mod.celery_app = fresh
    return fresh


@pytest.fixture()
def db():
    """SQLite in-memory session bound to the Job/JobRun tables."""
    from app.db.session import Base
    from app.models import Job, JobRun, JobStatus  # noqa: F401 — register tables

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_run_job_is_registered(eager_celery_app) -> None:
    """The task name is the public contract: workers route by it."""
    from app.celery_tasks.run_job import run_job

    assert run_job.name == "app.celery_tasks.run_job.run_job"


def test_run_job_is_routed_to_reports_queue(eager_celery_app) -> None:
    """The route entry exists in the Celery app conf so `reports` workers receive it."""
    routes = eager_celery_app.conf.task_routes or {}
    assert routes.get("app.celery_tasks.run_job.run_job", {}).get("queue") == "reports"


def test_run_job_early_exit_when_already_success(
    eager_celery_app,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """If the broker redelivers a job that already succeeded, the handler must not re-run.

    This protects against the `task_acks_late` redelivery case: a worker
    finished the job but the ack was lost, so a second worker picks up
    the same message. Without the early-exit, the handler would
    overwrite `result_path` and re-persist monthly_report rows.
    """
    from app.celery_tasks import run_job as run_job_mod
    from app.celery_tasks.run_job import run_job
    from app.db.session import SessionLocal
    from app.models import Job, JobStatus

    # Patch `SessionLocal` to use the in-memory SQLite session bound above.
    monkeypatch.setattr(run_job_mod, "SessionLocal", lambda: db)
    monkeypatch.setattr(run_job_mod.job_service, "SessionLocal", lambda: db, raising=False)

    job = Job(
        job_type="product_analysis",
        status=JobStatus.success,
        payload_json={"job_type": "product_analysis", "file_id": "abc", "params": {}},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # If the early-exit didn't fire, the handler would call
    # `SCRIPT_HANDLERS["product_analysis"]` and likely raise. We
    # additionally assert the script was never invoked by stubbing it.
    handler_called = {"count": 0}

    def _spy_handler(*_args, **_kwargs):
        handler_called["count"] += 1
        return {"result_path": str(tmp_path / "should-not-exist.xlsx")}

    monkeypatch.setitem(run_job_mod.SCRIPT_HANDLERS, "product_analysis", _spy_handler)

    result = run_job.apply(args=[job.id]).get()

    assert result == {"status": "already_done", "job_id": job.id}
    assert handler_called["count"] == 0


def test_run_job_missing_job_returns_missing_status(
    eager_celery_app,
    db,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`run_job` for a non-existent job_id returns a structured 'missing' status, not an error."""
    from app.celery_tasks import run_job as run_job_mod
    from app.celery_tasks.run_job import run_job

    monkeypatch.setattr(run_job_mod, "SessionLocal", lambda: db)

    result = run_job.apply(args=[999_999]).get()
    assert result == {"status": "missing"}


def test_run_job_writes_task_id_into_log_excerpt(
    eager_celery_app,
    db,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Every progress payload emitted from the Celery path carries `self.request.id`."""
    from app.celery_tasks import run_job as run_job_mod
    from app.celery_tasks.run_job import run_job
    from app.models import Job, JobRun, JobStatus

    monkeypatch.setattr(run_job_mod, "SessionLocal", lambda: db)
    monkeypatch.setattr(run_job_mod.job_service, "SessionLocal", lambda: db, raising=False)

    job = Job(
        job_type="product_analysis",
        status=JobStatus.pending,
        payload_json={"job_type": "product_analysis", "file_id": "abc", "params": {}},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    def _fake_handler(input_path: str, output_dir: str, params: dict) -> dict:
        output = Path(output_dir) / "result.xlsx"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("ok")
        return {"result_path": str(output)}

    monkeypatch.setitem(run_job_mod.SCRIPT_HANDLERS, "product_analysis", _fake_handler)

    # Stub out resolve_upload_path so the job doesn't need a real upload file.
    monkeypatch.setattr(
        run_job_mod.job_service,
        "resolve_upload_path",
        lambda _settings, _file_id: tmp_path / "fake-input.csv",
    )

    result = run_job.apply(args=[job.id]).get()
    assert result["status"] == "success"

    # The latest run should exist; the terminal `completed` log_excerpt
    # is what carries the task_id.
    run = db.query(JobRun).order_by(JobRun.id.desc()).first()
    assert run is not None
    assert run.finished_at is not None
    assert run.error_message is None
    assert run.result_path is not None

    log = json.loads(run.log_excerpt)
    assert log["stage"] == "completed"
    assert log["progress"] == 100
    assert "task_id" in log
    # `self.request.id` in eager mode is a UUID-shaped string.
    assert isinstance(log["task_id"], str) and len(log["task_id"]) >= 8
