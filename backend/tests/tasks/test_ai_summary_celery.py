"""BLF-1014：``generate_delivery_summary`` Celery 任务 e2e（不打真实网络）。

任务链路：信号量内提交 Insight run（幂等）→ **提交即返回**；run 终态的回写
由 insights worker 的终态钩子完成（见 ``tests/insight/test_durability.py``）。
任务只在「replay 到已终态 run」时当场同步一次。

为什么任务不再等待：``believeboy-celery`` 是 ``--concurrency=1`` 且同时消费
``insights`` 与 ``ai_summary`` 队列，在任务里轮询会占住唯一槽位，让被等待的
``execute_insight_run`` 永远排不上队（生产实证：run 直到等待方 soft time
limit 自杀后才被接收）。

隔离方式：``app.db.session.SessionLocal`` 被 patch 到测试的内存 SQLite
engine，任务体内开的 session 与测试共享同一份库；LLM 提交入口
（``ledger_service.generate_ai_summary_for_delivery_log``）按场景替换为
真实落行替身——Insight 执行器不进入。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import app.db.session as db_session_mod
from app.db.session import Base
from app.models.insight_run import InsightRun
from app.models.scheduled_report import (
    AiSummaryStatus,
    DeliveryStatus,
    ScheduledReportDeliveryLog,
    ScheduledReportSubscription,
)
from app.schemas.insight import (
    InsightErrorCode,
    InsightOutput,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight.contracts import sha256_hex
from app.services.insight.runs import transition


@pytest.fixture()
def engine() -> Iterator[Any]:
    engine = create_engine(
        "sqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def db(engine: Any) -> Iterator[Session]:
    maker = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = maker()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def patch_session_local(
    engine: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """任务体内的 SessionLocal() 与测试共享同一内存库。"""
    maker = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr(db_session_mod, "SessionLocal", maker)


@pytest.fixture()
def fast_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """兼容占位：任务已不轮询，保留 fixture 以免既有调用点报错。"""
    return None


def _add_subscription(db: Session) -> ScheduledReportSubscription:
    sub = ScheduledReportSubscription(
        user_id=1,
        email="ops@example.com",
        project_ids="15",
        country="US",
        frequency="weekly",
        dispatch_hour=15,
        dispatch_minute=0,
        ai_model=None,
        enabled=True,
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return sub


def _add_sent_log(db: Session, sub: ScheduledReportSubscription) -> ScheduledReportDeliveryLog:
    log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency=sub.frequency,
        report_date="2026-09-07",
        email=sub.email,
        status=DeliveryStatus.SENT.value,
        sent_at=datetime(2026, 9, 8, 15, 0, tzinfo=timezone.utc),
        ai_summary_status=AiSummaryStatus.PENDING.value,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


def _add_queued_run(engine: Any, log_id: int) -> str:
    """独立 session 落 run 行（模拟替身提交），返回 run_id。"""
    maker = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    with maker() as session:
        run = InsightRun(
            run_id=str(uuid4()),
            attempt=1,
            capability="insight",
            use_case="schedule_report_summary.v1",
            project_id=15,
            country="US",
            role_id="schedule_report_summary",
            role_version=1,
            endpoint_id="default",
            model_id="test-model",
            status="queued",
            stage="queued",
            progress_percent=0,
            idempotency_key=f"delivery:{log_id}",
            request_fingerprint="f" * 64,
            slots_json="{}",
            status_timeline_json="[]",
        )
        session.add(run)
        log = session.get(ScheduledReportDeliveryLog, log_id)
        assert log is not None
        log.insight_run_id = run.run_id
        # 真实提交路径会顺手置 generating（adapter._mark_generating），替身对齐。
        log.ai_summary_status = AiSummaryStatus.GENERATING.value
        session.commit()
        return run.run_id


def _advance_run(engine: Any, run_id: str, *, terminal: str, markdown: str = "") -> None:
    """独立 session 把 run 推到指定终态。"""
    maker = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    with maker() as session:
        run = next(
            r for r in session.query(InsightRun).all() if r.run_id == run_id
        )
        transition(session, run, InsightStatus.FINALIZING)
        if terminal == "completed":
            usage = InsightUsage(input_tokens=10, output_tokens=5, total_tokens=15)
            outputs = {
                "main": InsightOutput(
                    content=markdown, content_sha256=sha256_hex(markdown.encode())
                )
            }
            transition(
                session,
                run,
                InsightStatus.COMPLETED,
                usage=usage,
                outputs=outputs,
                content=markdown,
            )
        else:
            transition(
                session,
                run,
                InsightStatus.FAILED,
                error=make_error(
                    InsightErrorCode.UPSTREAM_TIMEOUT,
                    "Insight run timed out repeatedly",
                ),
            )
        session.commit()


def _task():
    from app.celery_tasks.ai_summary import generate_delivery_summary

    return generate_delivery_summary


def _patch_submit(
    monkeypatch: pytest.MonkeyPatch,
    engine: Any,
    *,
    terminal: str | None,
    markdown: str = "",
) -> None:
    """把提交入口替换为真实落行替身；terminal 非 None 时推进到该终态。"""
    from app.services.scheduled_report import ledger_service

    def _submit(*, log_id, ledger_key=None, override_ai_model=None):
        run_id = _add_queued_run(engine, log_id)
        if terminal is not None:
            _advance_run(engine, run_id, terminal=terminal, markdown=markdown)
        return {
            "status": "submitted",
            "log_id": log_id,
            "run_id": run_id,
            "message": "ok",
        }

    monkeypatch.setattr(
        ledger_service, "generate_ai_summary_for_delivery_log", _submit
    )


class TestGenerateDeliverySummaryTask:
    def test_replayed_completed_run_syncs_delivery_log(
        self,
        db: Session,
        engine: Any,
        monkeypatch: pytest.MonkeyPatch,
        patch_session_local: None,
        fast_poll: None,
    ):
        """replay 到已 completed 的 run → 当场回写 done（重复点击立即出摘要）。"""
        _patch_submit(
            monkeypatch, engine, terminal="completed", markdown="销量12单，库存300件"
        )
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)

        outcome = _task().run(log_id=log.id, ledger_key=None, override_ai_model=None)

        assert outcome["status"] == "terminal"
        assert outcome["run_status"] == "completed"
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.DONE.value
        assert log.ai_summary == "销量12单，库存300件"
        assert log.insight_run_id == outcome["run_id"]
        assert log.ai_summary_model == "test-model"

    def test_replayed_failed_run_writes_typed_error(
        self,
        db: Session,
        engine: Any,
        monkeypatch: pytest.MonkeyPatch,
        patch_session_local: None,
        fast_poll: None,
    ):
        """replay 到已 failed 的 run → delivery_log failed + typed error 摘要。"""
        _patch_submit(monkeypatch, engine, terminal="failed")
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)

        outcome = _task().run(log_id=log.id)

        assert outcome["status"] == "terminal"
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.FAILED.value
        assert "UPSTREAM_TIMEOUT" in (log.ai_summary_error or "")

    def test_queued_run_returns_immediately_without_waiting(
        self,
        db: Session,
        engine: Any,
        monkeypatch: pytest.MonkeyPatch,
        patch_session_local: None,
        fast_poll: None,
    ):
        """run 还在排队 → 任务提交即返回（绝不占住 worker 槽位等待）。

        回归生产死锁：concurrency=1 的 worker 同时消费 insights 与
        ai_summary，任务内轮询会让被等待的 run 永远排不上队。
        """
        _patch_submit(monkeypatch, engine, terminal=None)
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)

        outcome = _task().run(log_id=log.id)

        assert outcome["status"] == "submitted"
        assert outcome["run_id"]
        assert "run_status" not in outcome
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.GENERATING.value

    def test_submit_failed_marks_delivery_log_failed(
        self, db: Session, monkeypatch: pytest.MonkeyPatch, patch_session_local: None
    ):
        """提交失败（订阅悬挂等）→ delivery_log 标 failed，任务不抛。"""
        from app.services.scheduled_report import ledger_service

        monkeypatch.setattr(
            ledger_service,
            "generate_ai_summary_for_delivery_log",
            lambda **kw: {
                "status": "submit_failed",
                "log_id": kw["log_id"],
                "run_id": None,
                "message": "订阅不存在或已删除",
            },
        )
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)

        outcome = _task().run(log_id=log.id)

        assert outcome["status"] == "submit_failed"
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.FAILED.value
        assert "订阅" in (log.ai_summary_error or "")


    def test_semaphore_timeout_marks_failed_and_returns(
        self,
        db: Session,
        monkeypatch: pytest.MonkeyPatch,
        patch_session_local: None,
    ):
        """信号量拿不到 → 旧契约：delivery_log 标 failed（可再触发）并返回。

        隔离说明：``_mark_ai_summary_failed`` 走 SessionLocal 落库，
        patch_session_local 让它写进测试内存库，验证真实回写。
        """
        from contextlib import contextmanager

        @contextmanager
        def _timeout_sem(name, *, timeout, max_concurrent, **kw):
            yield False

        monkeypatch.setattr(
            "app.celery_tasks.ai_summary.acquire_remote_semaphore", _timeout_sem
        )
        sub = _add_subscription(db)
        log = _add_sent_log(db, sub)

        outcome = _task().run(log_id=log.id)

        assert outcome["status"] == "semaphore_timeout"
        assert outcome["log_id"] == log.id
        db.refresh(log)
        assert log.ai_summary_status == AiSummaryStatus.FAILED.value
        assert "semaphore timeout" in (log.ai_summary_error or "")
