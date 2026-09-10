"""BLF-1011: durable run repository — idempotency, state machine, snapshots."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.insight_run import InsightRun
from app.schemas.insight import (
    InsightErrorCode,
    InsightOutput,
    InsightRunRequest,
    InsightStage,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight.contracts import sha256_hex
from app.services.insight.lifecycle import LifecycleError
from app.services.insight.runs import (
    IdempotencyConflict,
    RunNotFound,
    cancel_run,
    create_run,
    get_run,
    retry_run,
    to_detail,
    transition,
)
from app.services.insight.validator import fingerprint_of
from tests.insight.conftest import make_request


@pytest.fixture()
def db() -> Iterator[Session]:
    from app.db.session import Base

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()
    try:
        yield session
    finally:
        session.close()


def _request(**overrides) -> InsightRunRequest:
    return InsightRunRequest.model_validate(make_request(**overrides))


def _create(db: Session, **overrides):
    request = _request(**overrides)
    return create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )


def _fail(db: Session, run: InsightRun) -> InsightRun:
    transition(
        db,
        run,
        InsightStatus.FAILED,
        error=make_error(InsightErrorCode.PROVIDER_UNAVAILABLE, "boom"),
    )
    return run


def test_create_then_replay_same_key(db: Session) -> None:
    run, replayed = _create(db)
    assert replayed is False
    assert run.attempt == 1
    assert run.status == InsightStatus.QUEUED.value

    same, replayed = _create(db)
    assert replayed is True
    assert same.id == run.id
    assert db.scalar(select(func.count()).select_from(InsightRun)) == 1


def test_conflict_same_key_different_payload(db: Session) -> None:
    _create(db)
    # client_request_id is excluded from the fingerprint on purpose; only a
    # real payload difference conflicts.
    _create(db, client_request_id="11111111-1111-4111-8111-111111111111")
    with pytest.raises(IdempotencyConflict):
        _create(db, role_version=2)


def test_scope_isolates_idempotency_key(db: Session) -> None:
    first, _ = _create(db)
    second, replayed = _create(db, project_id=43)
    assert replayed is False
    assert second.id != first.id


def test_happy_path_writes_terminal_artifacts_once(db: Session) -> None:
    run, _ = _create(db)
    transition(db, run, InsightStatus.GENERATING, stage=InsightStage.GENERATING)
    assert run.content_markdown is None  # no per-phase content writes

    markdown = "# Weekly\n\nbody"
    usage = InsightUsage(input_tokens=10, output_tokens=20, total_tokens=30)
    outputs = {
        "main": InsightOutput(
            format="markdown",
            content=markdown,
            content_sha256=sha256_hex(markdown.encode()),
        )
    }
    transition(db, run, InsightStatus.FINALIZING, stage=InsightStage.FINALIZING)
    transition(
        db,
        run,
        InsightStatus.COMPLETED,
        progress=100,
        usage=usage,
        outputs=outputs,
        content=markdown,
    )

    assert run.completed_at is not None
    assert run.duration_ms is not None and run.duration_ms >= 0
    # COMPLETED keeps the last active stage (no completed stage member).
    assert run.stage == InsightStage.FINALIZING.value

    detail = to_detail(run)
    assert detail.status == InsightStatus.COMPLETED
    assert detail.usage == usage
    assert detail.outputs["main"].content == markdown
    assert detail.role_id == "schedule_report_summary"
    assert detail.role_version == 1
    assert detail.resume.current_attempt == 1


def test_illegal_rollback_rejected(db: Session) -> None:
    run, _ = _create(db)
    transition(db, run, InsightStatus.GENERATING, stage=InsightStage.GENERATING)
    with pytest.raises(LifecycleError) as exc:
        transition(db, run, InsightStatus.AGGREGATING)
    assert exc.value.code == InsightErrorCode.INVALID_STATE_TRANSITION


def test_terminal_write_once(db: Session) -> None:
    run, _ = _create(db)
    transition(db, run, InsightStatus.FINALIZING, stage=InsightStage.FINALIZING)
    transition(db, run, InsightStatus.COMPLETED, progress=100)
    with pytest.raises(LifecycleError) as exc:
        transition(db, run, InsightStatus.FAILED)
    assert exc.value.code == InsightErrorCode.RUN_TERMINAL
    with pytest.raises(LifecycleError):
        transition(db, run, InsightStatus.COMPLETED)
    stored = db.get(InsightRun, run.id)
    assert stored is not None
    assert stored.status == InsightStatus.COMPLETED.value


def test_cancel_is_idempotent(db: Session) -> None:
    run, _ = _create(db)
    cancelled, replayed = cancel_run(db, run.run_id)
    assert replayed is False
    assert cancelled.status == InsightStatus.CANCELLED.value

    same, replayed = cancel_run(db, run.run_id)
    assert replayed is True
    assert same.status == InsightStatus.CANCELLED.value

    completed, _ = _create(db, project_id=44)
    transition(db, completed, InsightStatus.FINALIZING)
    transition(db, completed, InsightStatus.COMPLETED)
    same, replayed = cancel_run(db, completed.run_id)
    assert replayed is True  # terminal cancel is a no-op, never overwrites
    assert same.status == InsightStatus.COMPLETED.value


def test_retry_bumps_attempt_and_clears_terminal_state(db: Session) -> None:
    run, _ = _create(db)
    _fail(db, run)
    retried = retry_run(db, run.run_id)
    assert retried.attempt == 2
    assert retried.status == InsightStatus.QUEUED.value
    assert retried.error_json is None
    assert retried.started_at is None
    assert retried.completed_at is None
    # Stored slots survive for the new attempt.
    assert "report.context" in retried.slots_json

    with pytest.raises(LifecycleError) as exc:
        retry_run(db, retried.run_id)  # active runs are not retryable
    assert exc.value.code == InsightErrorCode.INVALID_STATE_TRANSITION


def test_retry_completed_rejected(db: Session) -> None:
    run, _ = _create(db)
    transition(db, run, InsightStatus.FINALIZING)
    transition(db, run, InsightStatus.COMPLETED)
    with pytest.raises(LifecycleError) as exc:
        retry_run(db, run.run_id)
    assert exc.value.code == InsightErrorCode.RUN_TERMINAL


def test_get_run_not_found(db: Session) -> None:
    with pytest.raises(RunNotFound):
        get_run(db, "not-a-uuid")
    with pytest.raises(RunNotFound):
        get_run(db, "11111111-1111-4111-8111-111111111111")
