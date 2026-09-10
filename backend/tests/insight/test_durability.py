"""BLF-1011 review regressions: durability, concurrency, dispatch, retryability.

Each test reproduces a finding from the BLF-1011 review with two
independent sessions on one shared database:

* worker-kill durability — a phase checkpoint must survive a rollback
  after ``RetryableFailure`` (finding 1);
* stale worker vs cancel — a worker holding a pre-cancel snapshot must
  not overwrite ``cancelled`` (finding 2a);
* stale attempt vs retry — a task carrying an old attempt must not
  disturb the newer attempt (finding 2b);
* dispatch visibility — the row must be queryable from another session
  before ``enqueue`` runs (finding 3);
* provider retryability — non-retryable causes must fail, never
  redeliver (finding 4a);
* retry exhaustion — the task must park the typed error instead of
  raising out of the worker (finding 4b).
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.schemas.insight import (
    InsightErrorCode,
    InsightRunRequest,
    InsightStatus,
    make_error,
)
from app.services.insight.executor import (
    LLMResult,
    RetryableFailure,
    execute_run,
    is_retryable,
    map_provider_error,
    start_run,
)
from app.services.insight.provider import (
    InsightModelSelection,
    InsightProviderError,
    InsightProviderErrorCode,
)
from app.services.insight.roles import InsightRoleDefinition
from app.services.insight.runs import (
    cancel_run,
    create_run,
    get_run,
    retry_run,
)
from app.services.insight.validator import fingerprint_of
from tests.insight.conftest import allow_all, make_request


@pytest.fixture()
def engine(tmp_path):
    """One file DB per test: sessions hold separate connections, so only
    committed rows are visible across sessions (like Postgres)."""

    from app.db.session import Base

    eng = create_engine(f"sqlite:///{tmp_path}/durability.db", future=True)
    Base.metadata.create_all(eng)
    try:
        yield eng
    finally:
        eng.dispose()


def _session(engine) -> Session:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()


def _request(**overrides) -> InsightRunRequest:
    return InsightRunRequest.model_validate(make_request(**overrides))


def _create(db: Session, **overrides):
    request = _request(**overrides)
    run, replayed = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    assert replayed is False
    return run


def _resolve(endpoint_id: str, model_id: str, role: InsightRoleDefinition, settings: Any):
    return InsightModelSelection(endpoint_id="default", model_id="fake-model", model=None)  # type: ignore[arg-type]


def _ok_generate(calls: list[str]):
    def _generate(agent: Any, prompt: str) -> LLMResult:
        calls.append(prompt)
        return LLMResult(markdown="# ok\n\nbody", input_tokens=3, output_tokens=5)

    return _generate


def _fresh(engine, run_id: str):
    probe = _session(engine)
    try:
        return get_run(probe, run_id)
    finally:
        probe.close()


def test_checkpoint_survives_worker_kill(engine) -> None:
    db = _session(engine)
    run = _create(db, idempotency_key="blf-1011-durable-1")
    db.commit()
    run_id = run.run_id
    limited = InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_RATE_LIMITED,
        "rate limited",
        retryable=True,
        retry_after=5,
    )

    def _flaky(agent: Any, prompt: str) -> LLMResult:
        raise limited

    with pytest.raises(RetryableFailure):
        execute_run(db=db, run_id=run_id, attempt=1, resolve=_resolve, generate=_flaky)
    db.rollback()  # worker kill: everything not yet committed is lost
    db.close()

    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.GENERATING.value


def test_stale_worker_cannot_overwrite_cancel(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)  # worker snapshot cached in its identity map

    cancel_run(user, run_id)
    user.commit()

    calls: list[str] = []
    out = execute_run(
        db=worker, run_id=run_id, attempt=1, resolve=_resolve,
        generate=_ok_generate(calls),
    )
    assert out.status == InsightStatus.CANCELLED.value
    assert calls == []
    worker.commit()  # must not resurrect the run past cancelled
    worker.close()
    user.close()

    assert _fresh(engine, run_id).status == InsightStatus.CANCELLED.value


def test_stale_checkpoint_cannot_overwrite_cancel(engine) -> None:
    """A worker holding a pre-cancel snapshot must not promote past it.

    Drives the phase checkpoint directly: without a refresh guard the
    stale object transitions to ``aggregating`` and the commit overwrites
    the user's ``cancelled``.
    """
    from app.schemas.insight import InsightStage
    from app.services.insight.executor import NullEventSink, _advance

    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2b")
    worker.commit()
    run_id = run.run_id
    stale = get_run(worker, run_id)  # QUEUED snapshot in the worker session

    cancel_run(user, run_id)
    user.commit()

    assert (
        _advance(
            worker,
            stale,
            InsightStatus.AGGREGATING,
            attempt=1,
            stage=InsightStage.AGGREGATING,
            progress=10,
            sink=NullEventSink(),
        )
        is False
    )
    worker.commit()
    worker.close()
    user.close()

    assert _fresh(engine, run_id).status == InsightStatus.CANCELLED.value



def test_old_attempt_cannot_advance_after_retry(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-3")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)  # stale attempt-1 snapshot in the worker session

    cancel_run(user, run_id)
    retry_run(user, run_id)  # attempt 2, queued
    user.commit()

    calls: list[str] = []
    out = execute_run(
        db=worker, run_id=run_id, attempt=1, resolve=_resolve,
        generate=_ok_generate(calls),
    )
    assert out.attempt == 2
    assert calls == []
    worker.commit()
    worker.close()
    user.close()

    stored = _fresh(engine, run_id)
    assert stored.attempt == 2
    assert stored.status == InsightStatus.QUEUED.value


def test_start_run_row_visible_before_enqueue(engine) -> None:
    db = _session(engine)
    seen: dict[str, str] = {}

    def _enqueue(run_id: str, attempt: int) -> None:
        seen["status"] = get_run(_session(engine), run_id).status

    run, replayed = start_run(
        db=db,
        raw=make_request(idempotency_key="blf-1011-durable-4"),
        scope_authorizer=allow_all,
        resolve=_resolve,
        enqueue=_enqueue,
    )
    assert replayed is False
    assert run.status == InsightStatus.QUEUED.value
    assert seen.get("status") == InsightStatus.QUEUED.value

def test_provider_not_configured_is_not_retryable() -> None:
    mapped = map_provider_error(
        InsightProviderError(
            InsightProviderErrorCode.PROVIDER_NOT_CONFIGURED,
            "not configured",
            retryable=False,
        )
    )
    assert mapped.code == InsightErrorCode.PROVIDER_UNAVAILABLE
    assert mapped.retryable is False
    assert not is_retryable(mapped)


def test_upstream_4xx_is_not_retryable() -> None:
    mapped = map_provider_error(
        InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_ERROR, "bad request", retryable=False
        )
    )
    assert mapped.code == InsightErrorCode.PROVIDER_UNAVAILABLE
    assert not is_retryable(mapped)


def test_upstream_5xx_stays_retryable() -> None:
    mapped = map_provider_error(
        InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_ERROR, "boom", retryable=True
        )
    )
    assert is_retryable(mapped)


def test_not_configured_fails_run_without_retry(engine) -> None:
    db = _session(engine)
    run = _create(db, idempotency_key="blf-1011-durable-5")
    db.commit()
    calls: list[str] = []

    def _resolve_missing(endpoint_id: str, model_id: str, role, settings):
        raise InsightProviderError(
            InsightProviderErrorCode.PROVIDER_NOT_CONFIGURED,
            "missing credentials",
            retryable=False,
        )

    def _generate(agent: Any, prompt: str) -> LLMResult:
        calls.append(prompt)
        return LLMResult(markdown="# x", input_tokens=1, output_tokens=1)

    failed = execute_run(
        db=db, run_id=run.run_id, attempt=1,
        resolve=_resolve_missing, generate=_generate,
    )
    assert failed.status == InsightStatus.FAILED.value
    assert calls == []
    db.close()

    from app.services.insight.runs import to_detail

    error = to_detail(_fresh(engine, run.run_id)).error
    assert error is not None
    assert error.code == InsightErrorCode.PROVIDER_UNAVAILABLE
    assert error.retryable is False


class _FakeRequest:
    def __init__(self, retries: int) -> None:
        self.retries = retries


class _FakeSelf:
    def __init__(self, retries: int, max_retries: int | None) -> None:
        self.request = _FakeRequest(retries)
        self.max_retries = max_retries

    def retry(self, exc=None, countdown=None):
        raise AssertionError("exhausted budget must park, not retry")


def _patch_task_db(monkeypatch: pytest.MonkeyPatch, engine) -> None:
    import app.db.session as session_mod

    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    monkeypatch.setattr(session_mod, "SessionLocal", factory)

def _call_task(task_mod, task_self, run_id: str, attempt: int):
    """Invoke the bound Celery task with a stub ``self`` (no broker)."""
    run = task_mod.execute_insight_run.run
    func = getattr(run, "__func__", run)
    return func(task_self, run_id, attempt)


def test_retry_exhaustion_parks_typed_error(engine, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1011-durable-6")
    seed.commit()
    run_id, attempt = run.run_id, run.attempt
    seed.close()

    typed = make_error(InsightErrorCode.RATE_LIMITED, "rate limited")

    def _boom(**kwargs) -> None:
        raise RetryableFailure(typed)

    monkeypatch.setattr(task_mod, "execute_run", _boom)
    out = _call_task(task_mod, _FakeSelf(3, 3), run_id, attempt)
    assert out["status"] == InsightStatus.FAILED.value

    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.FAILED.value
    from app.services.insight.runs import to_detail

    assert to_detail(stored).error is not None
    assert to_detail(stored).error.code == InsightErrorCode.RATE_LIMITED  # type: ignore[union-attr]


def test_retryable_below_budget_still_requeues(engine, monkeypatch: pytest.MonkeyPatch) -> None:
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1011-durable-7")
    seed.commit()
    run_id, attempt = run.run_id, run.attempt
    seed.close()

    class _SignalRetry(Exception):
        pass

    class _RequeueSelf(_FakeSelf):
        def retry(self, exc=None, countdown=None):
            raise _SignalRetry(countdown)

    def _boom(**kwargs) -> None:
        raise RetryableFailure(make_error(InsightErrorCode.RATE_LIMITED, "limited"))

    monkeypatch.setattr(task_mod, "execute_run", _boom)
    with pytest.raises(_SignalRetry):
        _call_task(task_mod, _RequeueSelf(0, 3), run_id, attempt)

    assert _fresh(engine, run_id).status == InsightStatus.QUEUED.value


def test_stale_attempt_park_leaves_newer_attempt_alone(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1011-durable-8")
    seed.commit()
    run_id = run.run_id
    cancel_run(seed, run_id)
    retry_run(seed, run_id)  # attempt 2, queued
    seed.commit()
    seed.close()

    out = task_mod._park_failed(
        run_id, 1, make_error(InsightErrorCode.RATE_LIMITED, "limited")
    )
    assert out["attempt"] == 2
    assert out["status"] == InsightStatus.QUEUED.value
    assert _fresh(engine, run_id).status == InsightStatus.QUEUED.value
