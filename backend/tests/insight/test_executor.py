"""BLF-1011: executor — attempt boundaries, retries, cancel, terminal writes."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.schemas.insight import InsightErrorCode, InsightRunRequest, InsightStatus
from app.services.insight.executor import (
    ListEventSink,
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
    IdempotencyConflict,
    cancel_run,
    create_run,
    retry_run,
    to_detail,
    transition,
)
from app.services.insight.validator import fingerprint_of
from tests.insight.conftest import allow_all, make_request


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


def _selection() -> InsightModelSelection:
    return InsightModelSelection(endpoint_id="default", model_id="fake-model", model=None)  # type: ignore[arg-type]


def _resolve(endpoint_id: str, model_id: str, role: InsightRoleDefinition, settings: Any):
    assert endpoint_id in ("", "default")
    return _selection()


def _ok_generate(calls: list[str]):
    def _generate(agent: Any, prompt: str) -> LLMResult:
        calls.append(prompt)
        return LLMResult(markdown="# Weekly\n\nbody", input_tokens=10, output_tokens=20)

    return _generate


def _create_run(db: Session, **overrides):
    request = _request(**overrides)
    run, _ = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    return run


def test_success_writes_terminal_snapshot_once(db: Session) -> None:
    run = _create_run(db)
    calls: list[str] = []
    sink = ListEventSink()
    done = execute_run(
        db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
        generate=_ok_generate(calls), sink=sink,
    )
    assert done.status == InsightStatus.COMPLETED.value
    assert calls and len(calls) == 1
    assert done.attempt == 1
    assert done.duration_ms is not None

    detail = to_detail(done)
    assert detail.status == InsightStatus.COMPLETED
    assert detail.outputs["main"].content == "# Weekly\n\nbody"
    assert detail.usage is not None and detail.usage.total_tokens == 30
    assert detail.role_id == "schedule_report_summary"
    assert detail.role_version == 1
    assert len(sink.terminals) == 1
    assert [stage for _, stage, _ in sink.statuses] == [
        "aggregating", "generating", "finalizing",
    ]
    assert sink.deltas and sink.deltas[0][0] == "main"


def test_terminal_redelivery_never_calls_llm_again(db: Session) -> None:
    run = _create_run(db)
    calls: list[str] = []
    execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                generate=_ok_generate(calls))
    again = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                        generate=_ok_generate(calls))
    assert again.status == InsightStatus.COMPLETED.value
    assert len(calls) == 1


def test_stale_attempt_returns_untouched(db: Session) -> None:
    run = _create_run(db)
    transition(db, run, InsightStatus.FAILED)
    retry_run(db, run.run_id)  # attempt is now 2, queued
    calls: list[str] = []
    stale = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                        generate=_ok_generate(calls))
    assert stale.attempt == 2
    assert stale.status == InsightStatus.QUEUED.value
    assert calls == []


def test_retryable_failure_resumes_same_attempt(db: Session) -> None:
    run = _create_run(db)
    limited = InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_RATE_LIMITED,
        "rate limited",
        retryable=True,
        retry_after=5,
    )

    def _flaky(agent: Any, prompt: str) -> LLMResult:
        raise limited

    sink = ListEventSink()
    with pytest.raises(RetryableFailure) as exc:
        execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                    generate=_flaky, sink=sink)
    assert exc.value.error.code == InsightErrorCode.RATE_LIMITED
    assert exc.value.retry_after == 5
    assert not sink.terminals  # no terminal write on the retry path
    assert run.status == InsightStatus.GENERATING.value  # progress kept, resumable

    calls: list[str] = []
    done = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                       generate=_ok_generate(calls), sink=sink)
    assert done.status == InsightStatus.COMPLETED.value
    assert done.attempt == 1
    assert len(sink.terminals) == 1  # exactly one terminal write across deliveries


def test_non_retryable_failure_goes_terminal(db: Session) -> None:
    run = _create_run(db)
    denied = InsightProviderError(
        InsightProviderErrorCode.MODEL_NOT_ALLOWED, "not allowed", retryable=False
    )
    calls: list[str] = []

    def _denied(agent: Any, prompt: str) -> LLMResult:
        calls.append(prompt)
        raise denied

    failed = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                         generate=_denied)
    assert failed.status == InsightStatus.FAILED.value
    detail = to_detail(failed)
    assert detail.error is not None
    assert detail.error.code == InsightErrorCode.MODEL_NOT_ALLOWED

    execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                generate=_denied)
    assert len(calls) == 1  # terminal runs never re-enter the LLM


def test_timeout_maps_to_retryable_upstream_timeout(db: Session) -> None:
    run = _create_run(db)

    def _timeout(agent: Any, prompt: str) -> LLMResult:
        raise InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_TIMEOUT, "timed out", retryable=True
        )

    with pytest.raises(RetryableFailure) as exc:
        execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                    generate=_timeout)
    assert exc.value.error.code == InsightErrorCode.UPSTREAM_TIMEOUT
    assert is_retryable(exc.value.error)


def test_cancelled_run_never_calls_llm(db: Session) -> None:
    run = _create_run(db)
    cancel_run(db, run.run_id)
    calls: list[str] = []
    out = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                      generate=_ok_generate(calls))
    assert out.status == InsightStatus.CANCELLED.value
    assert calls == []


def test_resolve_failure_before_first_transition(db: Session) -> None:
    run = _create_run(db)

    def _resolve_denied(endpoint_id: str, model_id: str, role, settings):
        raise InsightProviderError(
            InsightProviderErrorCode.ENDPOINT_NOT_ALLOWED, "nope", retryable=False
        )

    failed = execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve_denied,
                         generate=_ok_generate([]))
    assert failed.status == InsightStatus.FAILED.value
    assert to_detail(failed).error.code == InsightErrorCode.MODEL_NOT_ALLOWED


def test_empty_content_fails_without_terminal_overwrite(db: Session) -> None:
    run = _create_run(db)

    def _empty(agent: Any, prompt: str) -> LLMResult:
        return LLMResult(markdown="  ", input_tokens=1, output_tokens=0)

    with pytest.raises(RetryableFailure):
        execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                    generate=_empty)


def test_start_run_enqueues_only_fresh_runs(db: Session) -> None:
    enqueued: list[tuple[str, int]] = []
    raw = make_request(idempotency_key="blf-1011-start-1")
    run, replayed = start_run(
        db=db, raw=raw, scope_authorizer=allow_all, resolve=_resolve,
        enqueue=lambda rid, att: enqueued.append((rid, att)),
    )
    assert replayed is False
    assert run.status == InsightStatus.QUEUED.value

    same, replayed = start_run(
        db=db, raw=raw, scope_authorizer=allow_all, resolve=_resolve,
        enqueue=lambda rid, att: enqueued.append((rid, att)),
    )
    assert replayed is True
    assert same.id == run.id
    assert len(enqueued) == 1  # replay never enqueues a second LLM call


def test_start_run_conflict_on_reused_key(db: Session) -> None:
    raw = make_request(idempotency_key="blf-1011-start-2")
    start_run(db=db, raw=raw, scope_authorizer=allow_all, resolve=_resolve,
              enqueue=lambda rid, att: None)
    clashing = dict(raw)
    clashing["slots"] = dict(raw["slots"])
    clashing["slots"]["report.data"] = {
        "slot_version": 1,
        "encoding": "json",
        "payload": {"current_week": {"qty": 999}},
    }
    with pytest.raises(IdempotencyConflict):
        start_run(db=db, raw=clashing, scope_authorizer=allow_all,
                  resolve=_resolve, enqueue=lambda rid, att: None)


def test_map_provider_error_is_secret_free() -> None:
    try:
        raise RuntimeError("sk-key-abc https://upstream.internal/x payload")
    except RuntimeError as exc:
        error = map_provider_error(exc)
    assert "sk-key-abc" not in error.message
    assert "upstream.internal" not in error.message
    assert error.code == InsightErrorCode.PROVIDER_UNAVAILABLE


def test_task_registered_routed_and_guarded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://x:x@localhost:5432/x")
    monkeypatch.setenv("REDIS_HOST", "localhost")
    monkeypatch.setenv("REDIS_PORT", "6379")
    monkeypatch.setenv("REDIS_DB", "0")
    monkeypatch.setenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
    monkeypatch.setenv("CELERY_RESULT_URL", "redis://localhost:6379/2")

    from app.celery_tasks.insights.run import TASK_NAME, execute_insight_run
    from app.core import config as config_mod
    from app.tasks import celery_app as celery_app_mod

    config_mod.get_settings.cache_clear()
    try:
        fresh = celery_app_mod._build_celery_app()
        assert TASK_NAME in fresh.tasks
        assert fresh.conf.task_routes.get(TASK_NAME, {}).get("queue") == "insights"
    finally:
        config_mod.get_settings.cache_clear()

    task = execute_insight_run
    assert task.name == TASK_NAME
    assert task.acks_late is True
    assert task.max_retries == 3
    assert task.soft_time_limit == 300
    assert task.time_limit == 420


# ---------------------------------------------------------------------------
# BLF-1014：不可渲染的 report.data 必须终结为 typed failure，而不是卡死
# ---------------------------------------------------------------------------


def test_unrenderable_report_payload_fails_terminal(db: Session) -> None:
    """payload 渲染不出 prompt → 终态 failed(SLOT_VALIDATION_FAILED)。

    回归来源：多国家分支把邮件形状（``countries`` 是国家**列表**）塞进
    slot，daily prompt 在 ``countries.keys()`` 上抛 AttributeError；异常
    逃出 prompt 构建段后 run 永远停在 generating（线上卡死）。
    这里锁住两件事：终态 → failed；错误不可重试（不空转 Celery）。
    """
    run = _create_run(
        db,
        slots={
            "report.context": {
                "slot_version": 1,
                "frequency": "daily",
                "report_date": "2026-09-09",
                "date_range_start": "2026-09-01",
                "date_range_end": "2026-09-07",
                "project_ids": [42],
                "country": "US",
            },
            "report.data": {
                "slot_version": 1,
                "encoding": "json",
                "payload": {"multi_country": True, "countries": ["US", "DE"]},
            },
        },
    )
    calls: list[str] = []
    failed = execute_run(
        db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
        generate=_ok_generate(calls),
    )

    assert failed.status == InsightStatus.FAILED.value
    detail = to_detail(failed)
    assert detail.error is not None
    assert detail.error.code == InsightErrorCode.SLOT_VALIDATION_FAILED
    assert not is_retryable(detail.error)
    assert calls == []  # 从未调用 provider：坏 payload 不产生计费

    # 终态幂等：再次投递不再重跑
    execute_run(db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
                generate=_ok_generate(calls))
    assert calls == []
