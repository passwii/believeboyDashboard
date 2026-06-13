from __future__ import annotations

import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings


def _settings(*, enable_celery_dispatch: bool) -> Settings:
    return Settings(
        _env_file=None,
        database_url="postgresql+psycopg://x:x@localhost:5432/x",
        redis_host="localhost",
        redis_port=6379,
        redis_db=0,
        enable_celery_dispatch=enable_celery_dispatch,
    )


@pytest.fixture()
def db(monkeypatch: pytest.MonkeyPatch):
    from app.db.session import Base
    from app.models import Job, JobRun, JobStatus, MonthlyReport  # noqa: F401

    from app.services import monthly_report_runtime_service as runtime_service

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    monkeypatch.setattr(runtime_service, "SessionLocal", lambda: session)
    try:
        yield session
    finally:
        session.close()


def test_create_task_creates_job_payload_and_dispatches(db, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.models import Job
    from app.services import monthly_report_runtime_service as runtime_service

    settings = _settings(enable_celery_dispatch=False)
    thread_calls = {"count": 0, "target": None, "args": None}

    def _fake_thread(*args, **kwargs):
        thread_calls["count"] += 1
        thread_calls["target"] = kwargs.get("target")
        thread_calls["args"] = kwargs.get("args")

        class _StubThread:
            def start(self) -> None:
                return None

        return _StubThread()

    monkeypatch.setattr(threading, "Thread", _fake_thread, raising=True)

    task = runtime_service.create_task(
        settings,
        project_id=7,
        project_name="测试项目",
        country="US",
        report_month="2026-06",
        transaction_file_id="txn.csv",
        summary_pdf_file_id="summary.pdf",
        resolved_file_paths={"transaction_report": "/tmp/txn.csv", "monthly_summary_pdf": "/tmp/summary.pdf"},
        db=db,
        operator="tester",
    )

    job = db.query(Job).one()
    assert task.id == job.id
    assert task.status.value == "pending"
    assert job.job_type == "monthly_report"
    assert job.operator == "tester"
    assert job.payload_json == {
        "job_type": "monthly_report",
        "file_id": "txn.csv",
        "params": {
            "project_id": 7,
            "project_name": "测试项目",
            "country": "US",
            "report_month": "2026-06",
            "file_ids": {"transaction_report": "txn.csv", "monthly_summary_pdf": "summary.pdf"},
            "resolved_file_paths": {
                "transaction_report": "/tmp/txn.csv",
                "monthly_summary_pdf": "/tmp/summary.pdf",
            },
        },
    }
    assert thread_calls["count"] == 1
    assert thread_calls["args"] == (job.id,)


def test_get_task_reads_progress_from_latest_job_run_and_persistence_from_monthly_report(db) -> None:
    from app.models import Job, JobRun, JobStatus, MonthlyReport
    from app.services import monthly_report_runtime_service as runtime_service

    now = datetime.now(UTC)
    job = Job(
        job_type="monthly_report",
        status=JobStatus.running,
        payload_json={
            "job_type": "monthly_report",
            "params": {
                "project_id": 7,
                "project_name": "测试项目",
                "country": "US",
                "report_month": "2026-06",
                "file_ids": {"transaction_report": "txn.csv"},
                "resolved_file_paths": {"transaction_report": "/tmp/txn.csv"},
            },
        },
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    run = JobRun(
        job_id=job.id,
        started_at=now,
        log_excerpt=json.dumps(
            {
                "stage": "building_accounting",
                "progress": 42,
                "message": "正在核算",
                "task_id": "celery-task-id",
            },
            ensure_ascii=False,
        ),
        result_path="/tmp/result.xlsx",
    )
    report = MonthlyReport(
        project_id=7,
        project_name="测试项目",
        country="US",
        report_month="2026-06",
        version=1,
        is_current=True,
        transaction_file_id="txn.csv",
        transaction_file_path="/tmp/txn.csv",
        status=JobStatus.running,
        calculation_version=1,
        created_at=now,
        updated_at=now,
    )
    db.add(run)
    db.add(report)
    db.commit()
    db.refresh(job)
    db.refresh(run)

    task = runtime_service.get_task(job.id)

    assert task is not None
    assert task.id == job.id
    assert task.status == JobStatus.running
    assert task.stage == "building_accounting"
    assert task.progress == 42
    assert task.message == "正在核算"
    assert task.result_path == "/tmp/result.xlsx"
    assert task.persistence_status == "running"
    assert task.persistence_message == "后台同步中：正在写入数据库"


def test_get_task_returns_none_for_jobs_older_than_24_hours(db) -> None:
    from app.models import Job, JobStatus
    from app.services import monthly_report_runtime_service as runtime_service

    old = datetime.now(UTC) - timedelta(hours=25)
    job = Job(
        job_type="monthly_report",
        status=JobStatus.pending,
        payload_json={
            "job_type": "monthly_report",
            "params": {
                "project_id": 7,
                "project_name": "测试项目",
                "country": "US",
                "report_month": "2026-06",
                "file_ids": {"transaction_report": "txn.csv"},
                "resolved_file_paths": {"transaction_report": "/tmp/txn.csv"},
            },
        },
        created_at=old,
        updated_at=old,
    )
    db.add(job)
    db.commit()

    assert runtime_service.get_task(job.id) is None


def test_get_task_uses_result_path_when_no_log_excerpt_exists(db, tmp_path: Path) -> None:
    from app.models import Job, JobRun, JobStatus
    from app.services import monthly_report_runtime_service as runtime_service

    now = datetime.now(UTC)
    job = Job(
        job_type="monthly_report",
        status=JobStatus.success,
        payload_json={
            "job_type": "monthly_report",
            "params": {
                "project_id": 7,
                "project_name": "测试项目",
                "country": "US",
                "report_month": "2026-06",
                "file_ids": {"transaction_report": "txn.csv"},
                "resolved_file_paths": {"transaction_report": "/tmp/txn.csv"},
            },
        },
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    db.flush()
    result_path = str(tmp_path / "result.xlsx")
    run = JobRun(job_id=job.id, started_at=now, finished_at=now, result_path=result_path)
    db.add(run)
    db.commit()

    task = runtime_service.get_task(job.id)

    assert task is not None
    assert task.status == JobStatus.success
    assert task.stage == "completed"
    assert task.progress == 100
    assert task.result_path == result_path
    assert task.persistence_status == "idle"
