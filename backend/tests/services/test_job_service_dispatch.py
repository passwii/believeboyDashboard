"""Tests for `app.services.job_service` (BEL-55-P1 dispatch + idempotency).

Covers:
* `enqueue_job` dispatches to Celery when `enable_celery_dispatch=True`
  and to the legacy thread when `False`.
* `mark_job_running` is idempotent: a second call on a job already in
  the `running` state returns the existing `JobRun` instead of
  creating a duplicate.
* `mark_job_failed` accumulates retry history in `error_message` (so
  operators can see all 3 attempts, not just the last one).
"""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings


def _settings(*, enable_celery_dispatch: bool) -> Settings:
    """Build a Settings instance with the dispatch switch set explicitly."""
    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://x:x@localhost:5432/x",
        redis_host="localhost",
        redis_port=6379,
        redis_db=0,
        enable_celery_dispatch=enable_celery_dispatch,
    )


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


def test_enqueue_job_dispatches_to_celery_when_enabled(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With `enable_celery_dispatch=True`, `enqueue_job.delay` is called and no thread is started."""
    from app.services import job_service
    from app.models import Job, JobStatus

    settings = _settings(enable_celery_dispatch=True)

    delay_called = {"count": 0, "args": None}

    def _fake_delay(job_id: int) -> None:
        delay_called["count"] += 1
        delay_called["args"] = (job_id,)

    def _fake_thread(*_args, **_kwargs):
        raise AssertionError("threading.Thread should not be used when Celery dispatch is enabled")

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _fake_delay, raising=False
    )
    monkeypatch.setattr(threading, "Thread", _fake_thread, raising=True)

    job = job_service.enqueue_job(
        db,
        settings,
        {"job_type": "product_analysis", "file_id": "abc", "params": {}},
        operator="tester",
    )

    assert isinstance(job, Job)
    assert job.status == JobStatus.pending
    assert job.id is not None
    assert delay_called["count"] == 1
    assert delay_called["args"] == (job.id,)


def test_enqueue_job_falls_back_to_thread_when_disabled(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With `enable_celery_dispatch=False`, `enqueue_job` starts a daemon thread."""
    from app.services import job_service
    from app.models import Job, JobStatus

    settings = _settings(enable_celery_dispatch=False)

    delay_called = {"count": 0}
    thread_calls = {"count": 0, "target": None, "args": None}

    def _fake_delay(_job_id: int) -> None:
        delay_called["count"] += 1

    def _fake_thread(*args, **kwargs):
        thread_calls["count"] += 1
        thread_calls["target"] = kwargs.get("target")
        thread_calls["args"] = kwargs.get("args")

        class _StubThread:
            def start(self) -> None:
                # Don't actually run the target; the test only verifies
                # the dispatch path was taken, not the run itself.
                return None

        return _StubThread()

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _fake_delay, raising=False
    )
    monkeypatch.setattr(threading, "Thread", _fake_thread, raising=True)

    job = job_service.enqueue_job(
        db,
        settings,
        {"job_type": "product_analysis", "file_id": "abc", "params": {}},
        operator="tester",
    )

    assert isinstance(job, Job)
    assert job.status == JobStatus.pending
    assert delay_called["count"] == 0
    assert thread_calls["count"] == 1
    assert thread_calls["args"] == (job.id,)


def test_mark_job_running_is_idempotent(db) -> None:
    """Calling `mark_job_running` twice on a `running` job returns the same JobRun."""
    from app.services import job_service
    from app.models import Job, JobRun, JobStatus

    job = Job(
        job_type="product_analysis",
        status=JobStatus.pending,
        payload_json={"job_type": "product_analysis", "file_id": "abc", "params": {}},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    first = job_service.mark_job_running(db, job, operator="tester")
    second = job_service.mark_job_running(db, job, operator="tester")

    # The second call must not create a new JobRun.
    assert first.id == second.id
    run_count = db.query(JobRun).filter(JobRun.job_id == job.id).count()
    assert run_count == 1


def test_mark_job_running_creates_new_run_after_success(db) -> None:
    """If a previous run finished (success or failed), a new `mark_job_running` creates a new row."""
    from app.services import job_service
    from app.models import Job, JobRun, JobStatus

    job = Job(
        job_type="product_analysis",
        status=JobStatus.pending,
        payload_json={"job_type": "product_analysis", "file_id": "abc", "params": {}},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    first = job_service.mark_job_running(db, job, operator="tester")
    job_service.mark_job_success(db, job, first, result_path="/tmp/out.xlsx", log_excerpt="done")
    assert job.status == JobStatus.success

    # A new attempt (e.g. operator-triggered re-run) is allowed.
    second = job_service.mark_job_running(db, job, operator="tester")
    assert second.id != first.id
    run_count = db.query(JobRun).filter(JobRun.job_id == job.id).count()
    assert run_count == 2


def test_mark_job_failed_accumulates_error_message(db) -> None:
    """On Celery retry, `mark_job_failed` appends the new error to the previous one."""
    from app.services import job_service
    from app.models import Job, JobRun, JobStatus

    job = Job(
        job_type="product_analysis",
        status=JobStatus.pending,
        payload_json={"job_type": "product_analysis", "file_id": "abc", "params": {}},
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    run = job_service.mark_job_running(db, job, operator="tester")
    job_service.mark_job_failed(db, job, run, "attempt 1: connection refused")
    job_service.mark_job_failed(db, job, run, "attempt 2: timeout after 30s")
    job_service.mark_job_failed(db, job, run, "attempt 3: handler raised ValueError")

    db.refresh(run)
    assert run.error_message is not None
    assert "attempt 1" in run.error_message
    assert "attempt 2" in run.error_message
    assert "attempt 3" in run.error_message
    # All three attempts preserved, separated by the delimiter.
    assert run.error_message.count("\n---\n") == 2
