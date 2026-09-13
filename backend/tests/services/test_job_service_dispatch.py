"""Tests for `app.services.job_service` (Celery dispatch + idempotency).

Covers:
* `enqueue_job` dispatches to Celery via
  `app.celery_tasks.run_job.run_job.delay`.
* `enqueue_job` falls back to a synchronous in-process run when the
  Celery broker is unreachable (kombu `OperationalError`) or when
  `self.retry()` surfaces a `celery.exceptions.Retry` in-process
  (BEL-2026-06-17 follow-up to the 09:22 monthly-report 500).
* `mark_job_running` is idempotent: a second call on a job already in
  the `running` state returns the existing `JobRun` instead of
  creating a duplicate.
* `mark_job_failed` accumulates retry history in `error_message` (so
  operators can see all 3 attempts, not just the last one).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


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


def test_enqueue_job_dispatches_to_celery(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`enqueue_job` calls `run_job.delay` with the new job id."""
    from app.services import job_service
    from app.models import Job, JobStatus

    delay_called = {"count": 0, "args": None}

    def _fake_delay(job_id: int) -> None:
        delay_called["count"] += 1
        delay_called["args"] = (job_id,)

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _fake_delay, raising=False
    )

    job = job_service.enqueue_job(
        db,
        {"job_type": "product_analysis", "file_id": "abc", "params": {}},
        operator="tester",
    )

    assert isinstance(job, Job)
    assert job.status == JobStatus.pending
    assert job.id is not None
    assert delay_called["count"] == 1
    assert delay_called["args"] == (job.id,)


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


# ---------------------------------------------------------------------------
# BEL-2026-06-17 follow-up: broker-unavailable sync-fallback tests
# ---------------------------------------------------------------------------
# On 2026-06-17 09:22, a monthly report POST hit
# `kombu.exceptions.OperationalError: [Errno 111] Connection refused` because
# the Celery broker was unreachable; the synchronous `.delay()` call bubbled
# the exception back to the FastAPI handler as a 500. We now catch that (and
# `celery.exceptions.Retry` from in-process `self.retry()`) in `enqueue_job`
# and fall back to a synchronous `celery_run_job.run()` so the request
# completes. The three tests below pin the contract.


def test_enqueue_job_falls_back_to_sync_when_broker_unavailable(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`OperationalError` from `.delay()` triggers sync `.run()` instead of bubbling 500."""
    from app.services import job_service
    from app.models import Job, JobStatus
    from kombu.exceptions import OperationalError

    delay_calls = {"count": 0}
    run_calls = {"count": 0, "args": None}

    def _raise_op_error(_job_id: int) -> None:
        delay_calls["count"] += 1
        raise OperationalError("Connection refused")

    def _fake_run_succeeds(job_id: int) -> None:
        # Simulate the sync fallback finishing cleanly. We have to write the
        # terminal status ourselves because the real `run_job` body is
        # bypassed by this monkeypatch.
        run_calls["count"] += 1
        run_calls["args"] = (job_id,)
        job = job_service.get_job(db, job_id)
        run = job_service.get_latest_run(db, job_id)
        job_service.mark_job_success(
            db, job, run, result_path="/tmp/sync_fallback.xlsx",
            log_excerpt="sync fallback (test stub)",
        )

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _raise_op_error, raising=False
    )
    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.run", _fake_run_succeeds, raising=False
    )

    job = job_service.enqueue_job(
        db,
        {"job_type": "product_analysis", "file_id": "abc", "params": {}},
        operator="tester",
    )

    assert isinstance(job, Job)
    assert delay_calls["count"] == 1
    assert run_calls["count"] == 1
    assert run_calls["args"] == (job.id,)
    db.refresh(job)
    assert job.status == JobStatus.success


def test_enqueue_job_marks_failed_when_broker_unavailable_and_sync_retry_exhausted(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sync fallback that exhausts retries (Retry exception) marks the job FAILED, no re-raise."""
    from app.services import job_service
    from app.models import Job, JobRun, JobStatus
    from kombu.exceptions import OperationalError
    from celery.exceptions import Retry

    def _raise_op_error(_job_id: int) -> None:
        raise OperationalError("Connection refused")

    def _raise_retry(_job_id: int) -> None:
        # In the real sync path, `self.retry()` raises Retry when the retry
        # budget is exhausted (synchronously we don't reschedule — we surface
        # it as a FAILED job so the operator poll endpoint still answers).
        raise Retry("exhausted")

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _raise_op_error, raising=False
    )
    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.run", _raise_retry, raising=False
    )

    # Must not raise: the whole point of the fallback is that the operator's
    # monthly-report request keeps making progress even if the broker is dead.
    job = job_service.enqueue_job(
        db,
        {"job_type": "product_analysis", "file_id": "abc", "params": {}},
        operator="tester",
    )

    db.refresh(job)
    assert job.status == JobStatus.failed
    run = (
        db.query(JobRun)
        .filter(JobRun.job_id == job.id)
        .order_by(JobRun.id.desc())
        .first()
    )
    assert run is not None
    assert run.error_message is not None
    assert "broker_unavailable_sync_fallback_retry_exhausted" in run.error_message


def test_enqueue_job_does_not_swallow_business_exceptions_in_sync_fallback(
    db, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The sync fallback must not paper over real business exceptions — they still 500."""
    from app.services import job_service
    from kombu.exceptions import OperationalError

    def _raise_op_error(_job_id: int) -> None:
        raise OperationalError("Connection refused")

    def _raise_runtime_error(_job_id: int) -> None:
        # Distinct from Retry: this is a genuine handler bug, not a transient
        # broker / network condition. The operator must see a 500 here.
        raise RuntimeError("real business exception")

    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.delay", _raise_op_error, raising=False
    )
    monkeypatch.setattr(
        "app.celery_tasks.run_job.run_job.run", _raise_runtime_error, raising=False
    )

    with pytest.raises(RuntimeError, match="real business exception"):
        job_service.enqueue_job(
            db,
            {"job_type": "product_analysis", "file_id": "abc", "params": {}},
            operator="tester",
        )
