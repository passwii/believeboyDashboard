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
  raising out of the worker (finding 4b);
* atomic state writes — every write must be decided by the write itself
  (compare-and-swap), not by a refresh that a competing writer can
  overtake before the UPDATE is sent (re-review finding 1).

The concurrency tests interleave the competing commit *inside* the
writer's window (just before its UPDATE is sent), so the race is
deterministic instead of timing-dependent.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from app.schemas.insight import (
    InsightErrorCode,
    InsightRunRequest,
    InsightStage,
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
    StaleRunWrite,
    cancel_run,
    create_run,
    get_run,
    retry_run,
    to_detail,
    transition,
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


def _commit_before_update(engine, action, *, when=None):
    """Run ``action`` on its own session inside a writer's write window.

    The listener fires just before an ``UPDATE insight_runs`` is sent, i.e.
    after the writer read its snapshot and before the row is written — the
    only window a row lock cannot close on every backend. ``when`` selects
    the triggering UPDATE from its compiled parameters (default: the first).
    Returns the listener remover.
    """

    stopped = {"fired": False}

    def _hook(conn, cursor, statement, parameters, context, executemany):
        if stopped["fired"]:
            return
        if not statement.lstrip().upper().startswith("UPDATE"):
            return
        if "insight_runs" not in statement:
            return
        compiled = (context.compiled_parameters or [{}])[0]
        if when is not None and not when(compiled):
            return
        stopped["fired"] = True  # the interleave's own writes must not re-enter
        action()

    event.listen(engine, "before_cursor_execute", _hook)
    return lambda: event.remove(engine, "before_cursor_execute", _hook)


def test_transition_write_is_atomic_against_concurrent_cancel(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2c")
    worker.commit()
    run_id = run.run_id
    stale = get_run(worker, run_id)  # snapshot taken, cancel not yet committed

    def _cancel() -> None:
        cancel_run(user, run_id)
        user.commit()

    remove = _commit_before_update(engine, _cancel)
    try:
        with pytest.raises(StaleRunWrite):
            transition(
                worker,
                stale,
                InsightStatus.AGGREGATING,
                stage=InsightStage.AGGREGATING,
                progress=10,
            )
    finally:
        remove()
    worker.close()
    user.close()

    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.CANCELLED.value
    assert stored.stage == InsightStage.QUEUED.value
    assert stored.progress_percent == 0
    assert [entry["status"] for entry in json.loads(stored.status_timeline_json)] == [
        InsightStatus.QUEUED.value,
        InsightStatus.CANCELLED.value,
    ]


def test_checkpoint_write_is_atomic_against_concurrent_cancel(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2d")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)

    def _cancel() -> None:
        cancel_run(user, run_id)
        user.commit()

    calls: list[str] = []
    remove = _commit_before_update(engine, _cancel)
    try:
        out = execute_run(
            db=worker, run_id=run_id, attempt=1, resolve=_resolve,
            generate=_ok_generate(calls),
        )
        returned = out.status  # read before the session closes
    finally:
        remove()
    worker.commit()
    worker.close()
    user.close()

    assert returned == InsightStatus.CANCELLED.value
    assert calls == []  # the cancel won the checkpoint: no LLM call
    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.CANCELLED.value
    assert stored.content_markdown is None
    assert json.loads(stored.status_timeline_json)[-1]["status"] == (
        InsightStatus.CANCELLED.value
    )


def test_completion_write_is_atomic_against_concurrent_cancel(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2e")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)

    def _cancel() -> None:
        cancel_run(user, run_id)
        user.commit()

    calls: list[str] = []
    remove = _commit_before_update(
        engine,
        _cancel,
        when=lambda params: params.get("status") == InsightStatus.COMPLETED.value,
    )
    try:
        out = execute_run(
            db=worker, run_id=run_id, attempt=1, resolve=_resolve,
            generate=_ok_generate(calls),
        )
        returned = out.status  # read before the session closes
    finally:
        remove()
    worker.commit()
    worker.close()
    user.close()

    assert len(calls) == 1  # the LLM ran; the terminal write must still lose
    assert returned == InsightStatus.CANCELLED.value
    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.CANCELLED.value
    assert stored.content_markdown is None
    assert stored.usage_json is None  # the cancel's terminal write stands alone


def test_failure_write_is_atomic_against_concurrent_cancel(engine) -> None:
    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2f")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)

    def _resolve_denied(endpoint_id: str, model_id: str, role, settings):
        raise InsightProviderError(
            InsightProviderErrorCode.ENDPOINT_NOT_ALLOWED, "nope", retryable=False
        )

    def _cancel() -> None:
        cancel_run(user, run_id)
        user.commit()

    remove = _commit_before_update(engine, _cancel)
    try:
        failed = execute_run(
            db=worker, run_id=run_id, attempt=1, resolve=_resolve_denied,
            generate=_ok_generate([]),
        )
        returned = failed.status  # read before the session closes
    finally:
        remove()
    worker.commit()
    worker.close()
    user.close()

    assert returned == InsightStatus.CANCELLED.value
    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.CANCELLED.value
    error = to_detail(stored).error
    assert error is not None
    # the cancel's own error stands; the resolver failure never overwrote it
    assert error.code == InsightErrorCode.CANCELLED


def test_park_failed_cannot_overwrite_concurrent_cancel(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1011-durable-2g")
    seed.commit()
    run_id = run.run_id
    seed.close()

    user = _session(engine)

    def _cancel() -> None:
        cancel_run(user, run_id)
        user.commit()

    remove = _commit_before_update(engine, _cancel)
    try:
        out = task_mod._park_failed(
            run_id, 1, make_error(InsightErrorCode.RATE_LIMITED, "limited")
        )
    finally:
        remove()
    user.close()

    assert out["status"] == InsightStatus.CANCELLED.value
    stored = _fresh(engine, run_id)
    assert stored.status == InsightStatus.CANCELLED.value
    error = to_detail(stored).error
    assert error is not None
    # the cancel's own error stands; the parked failure never overwrote it
    assert error.code == InsightErrorCode.CANCELLED


def test_cancel_losing_to_retry_still_cancels_the_live_attempt(engine) -> None:
    """A cancel overtaken by cancel+retry must cancel the newer attempt.

    The worker's snapshot is attempt 1; by the time its UPDATE is sent the
    row is attempt 2 (queued), so the write must re-target the live attempt
    instead of resurrecting attempt 1 or silently reporting success.
    """

    worker = _session(engine)
    user = _session(engine)
    run = _create(worker, idempotency_key="blf-1011-durable-2h")
    worker.commit()
    run_id = run.run_id
    get_run(worker, run_id)

    def _cancel_then_retry() -> None:
        cancel_run(user, run_id)
        retry_run(user, run_id)  # attempt 2, queued
        user.commit()

    remove = _commit_before_update(engine, _cancel_then_retry)
    try:
        cancelled, replayed = cancel_run(worker, run_id)
    finally:
        remove()
    cancelled_attempt = cancelled.attempt
    cancelled_status = cancelled.status  # read before the session closes
    worker.commit()
    worker.close()
    user.close()

    assert replayed is False
    assert cancelled_attempt == 2
    assert cancelled_status == InsightStatus.CANCELLED.value
    stored = _fresh(engine, run_id)
    assert stored.attempt == 2
    assert stored.status == InsightStatus.CANCELLED.value


# ---------------------------------------------------------------------------
# BLF-1014：insight worker 到终态后的业务回写
#
# 生产实证：``generate_delivery_summary`` 在任务体内轮询等待 run 终态，
# 而 ``believeboy-celery`` 是 ``--concurrency=1`` 且同吃 insights /
# ai_summary 队列——等待方占住唯一槽位，被等待的 execute_insight_run
# 永远排不上队，只能等等待方 soft_time_limit 自杀。改为 worker 终态钩子后，
# 交付不再依赖任何等待方。
# ---------------------------------------------------------------------------


def _bind_delivery_log(engine, run_id: str) -> int:
    """落一条已发送的 delivery_log，并把它绑到 run 上（回写目标）。"""
    from app.models.scheduled_report import (
        AiSummaryStatus,
        DeliveryStatus,
        ScheduledReportDeliveryLog,
        ScheduledReportSubscription,
    )

    db = _session(engine)
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
    log = ScheduledReportDeliveryLog(
        subscription_id=sub.id,
        frequency="weekly",
        report_date="2026-09-07",
        email=sub.email,
        status=DeliveryStatus.SENT.value,
        ai_summary_status=AiSummaryStatus.PENDING.value,
        insight_run_id=run_id,
    )
    db.add(log)
    db.commit()
    log_id = log.id
    db.close()
    return log_id


def _complete_run(engine, run_id: str, content: str):
    """独立 session 把 run 推到 completed（模拟 executor 的终态写入）。"""
    from app.schemas.insight import InsightOutput, InsightUsage
    from app.services.insight.contracts import sha256_hex

    db = _session(engine)
    run = get_run(db, run_id)
    transition(db, run, InsightStatus.FINALIZING)
    transition(
        db,
        run,
        InsightStatus.COMPLETED,
        usage=InsightUsage(input_tokens=3, output_tokens=5, total_tokens=8),
        outputs={
            "main": InsightOutput(
                content=content, content_sha256=sha256_hex(content.encode())
            )
        },
        content=content,
    )
    db.commit()
    db.close()


def test_terminal_run_writes_back_to_bound_delivery_log(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """run 到终态 → 绑定的 delivery_log 被回写 done（无等待方参与）。"""
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1014-writeback-1")
    seed.commit()
    run_id, attempt = run.run_id, run.attempt
    seed.close()
    log_id = _bind_delivery_log(engine, run_id)
    content = "### 销售表现\n- 本周销量 48 件"

    def _completed(**kwargs):
        _complete_run(engine, run_id, content)
        return _fresh(engine, run_id)

    monkeypatch.setattr(task_mod, "execute_run", _completed)

    out = _call_task(task_mod, _FakeSelf(0, 3), run_id, attempt)

    assert out["status"] == InsightStatus.COMPLETED.value
    from app.models.scheduled_report import (
        AiSummaryStatus,
        ScheduledReportDeliveryLog,
    )

    check = _session(engine)
    log = check.get(ScheduledReportDeliveryLog, log_id)
    assert log is not None
    assert log.ai_summary_status == AiSummaryStatus.DONE.value
    assert log.ai_summary == content
    check.close()


def test_terminal_run_without_delivery_log_is_a_noop(
    engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    """没有业务绑定的 run（如广告洞察）到终态时不得报错。"""
    import app.celery_tasks.insights.run as task_mod

    _patch_task_db(monkeypatch, engine)
    seed = _session(engine)
    run = _create(seed, idempotency_key="blf-1014-writeback-2")
    seed.commit()
    run_id, attempt = run.run_id, run.attempt
    seed.close()

    def _completed(**kwargs):
        _complete_run(engine, run_id, "### 无绑定")
        return _fresh(engine, run_id)

    monkeypatch.setattr(task_mod, "execute_run", _completed)

    out = _call_task(task_mod, _FakeSelf(0, 3), run_id, attempt)

    assert out["status"] == InsightStatus.COMPLETED.value
