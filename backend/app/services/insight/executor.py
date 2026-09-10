"""Insight run executor (BLF-1011).

Drives a durable run from ``queued`` to a terminal state using the Stage 1
role/slot/provider contracts. Execution is decoupled from HTTP observers:
progress and content flow to an :class:`InsightEventSink`, which BLF-1012
implements with a Redis Stream/SSE transport. The sink never touches the
database — in particular there are no per-token writes; content accumulates
in memory and persists once at terminal state.

Attempt boundaries
------------------
* Celery redelivery (worker kill, broker requeue, ``self.retry``) re-executes
  the *same* attempt: non-terminal progress resumes, terminal runs return
  untouched without calling the LLM again.
* Only an explicit :func:`runs.retry_run` bumps ``attempt``; a task carrying
  a stale attempt returns immediately.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.insight_run import InsightRun
from app.schemas.insight import (
    RETRYABLE_ERROR_CODES,
    InsightError,
    InsightErrorCode,
    InsightOutput,
    InsightRunDetail,
    InsightRunRequest,
    InsightStage,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight.contracts import sha256_hex, to_canonical_json
from app.services.insight.lifecycle import is_terminal
from app.services.insight.model_resolver import create_insight_agent
from app.services.insight.provider import (
    InsightModelResolver,
    InsightModelSelection,
    InsightProviderError,
    InsightProviderErrorCode,
    classify_provider_error,
)
from app.services.insight.roles import (
    InsightRoleDefinition,
    RoleLookupError,
    lookup_role,
    require_active,
)
from app.services.insight.runs import (
    IdempotencyConflict,  # noqa: F401  (re-exported for HTTP-layer mapping)
    RunNotFound,  # noqa: F401  (re-exported for HTTP-layer mapping)
    create_run,
    get_run,
    to_detail,
    transition,
)
from app.services.insight.validator import (
    ScopeAuthorizer,
    fingerprint_of,
    validate_run_request,
)

logger = logging.getLogger(__name__)


class InsightEventSink(Protocol):
    """Observer outlet owned by the transport layer (BLF-1012).

    The executor calls these synchronously as phases advance; the transport
    assigns SSE envelope fields (``seq``/``id``) and owns replay. Methods
    must not raise for transport outages — the run's database state is the
    source of truth, the sink is best-effort.
    """

    def on_status(
        self,
        run: InsightRun,
        stage: InsightStage,
        progress: int,
        detail: str | None = None,
    ) -> None:
        """A phase/status change became durable."""

    def on_content_delta(self, *, slot: str, block_id: str, delta: str) -> None:
        """A slice of generated Markdown; never persisted per token."""

    def on_terminal(self, detail: InsightRunDetail) -> None:
        """Exactly one terminal snapshot per attempt."""


class NullEventSink:
    """Sink that drops everything (worker default until BLF-1012 wires up)."""

    def on_status(
        self,
        run: InsightRun,
        stage: InsightStage,
        progress: int,
        detail: str | None = None,
    ) -> None:
        return None

    def on_content_delta(self, *, slot: str, block_id: str, delta: str) -> None:
        return None

    def on_terminal(self, detail: InsightRunDetail) -> None:
        return None


class ListEventSink:
    """In-memory sink for tests: records every call in order."""

    def __init__(self) -> None:
        self.statuses: list[tuple[str, str, int]] = []
        self.deltas: list[tuple[str, str, str]] = []
        self.terminals: list[InsightRunDetail] = []

    def on_status(
        self,
        run: InsightRun,
        stage: InsightStage,
        progress: int,
        detail: str | None = None,
    ) -> None:
        self.statuses.append((run.run_id, stage.value, progress))

    def on_content_delta(self, *, slot: str, block_id: str, delta: str) -> None:
        self.deltas.append((slot, block_id, delta))

    def on_terminal(self, detail: InsightRunDetail) -> None:
        self.terminals.append(detail)


@dataclass(frozen=True)
class LLMResult:
    """One-shot LLM outcome: full Markdown plus real token usage."""

    markdown: str
    input_tokens: int = 0
    output_tokens: int = 0


#: ``(agent, user_prompt) -> LLMResult``; injected fakes make tests hermetic.
GenerateFunc = Callable[[Any, str], LLMResult]
#: ``(role, validated_slots) -> user_prompt``; role-owned templates land in Stage 3.
PromptBuilder = Callable[[InsightRoleDefinition, dict[str, Any]], str]
#: ``(run_id, attempt) -> None``; production sends the Celery task.
EnqueueFunc = Callable[[str, int], None]


class RetryableFailure(Exception):
    """The attempt must be redelivered (same attempt, resume on re-entry)."""

    def __init__(self, error: InsightError, retry_after: int | None = None) -> None:
        self.error = error
        self.retry_after = retry_after
        super().__init__(f"retryable insight failure: {error.code.value}")


_PROVIDER_CODE_MAP: dict[InsightProviderErrorCode, InsightErrorCode] = {
    InsightProviderErrorCode.PROVIDER_NOT_CONFIGURED: InsightErrorCode.PROVIDER_UNAVAILABLE,
    InsightProviderErrorCode.ENDPOINT_NOT_ALLOWED: InsightErrorCode.MODEL_NOT_ALLOWED,
    InsightProviderErrorCode.MODEL_NOT_ALLOWED: InsightErrorCode.MODEL_NOT_ALLOWED,
    InsightProviderErrorCode.MODEL_UNAVAILABLE: InsightErrorCode.MODEL_NOT_ALLOWED,
    InsightProviderErrorCode.UPSTREAM_RATE_LIMITED: InsightErrorCode.RATE_LIMITED,
    InsightProviderErrorCode.UPSTREAM_TIMEOUT: InsightErrorCode.UPSTREAM_TIMEOUT,
    InsightProviderErrorCode.UPSTREAM_ERROR: InsightErrorCode.PROVIDER_UNAVAILABLE,
}

def map_provider_error(exc: Exception) -> InsightError:
    """Map any provider failure to a secret-free typed error for persistence.

    The provider's ``retryable`` verdict is preserved verbatim: several
    provider codes collapse onto ``PROVIDER_UNAVAILABLE`` (a retryable
    contract code by default), but a non-retryable cause — not configured,
    4xx upstream — must stay non-retryable so the run fails instead of
    redelivering forever.
    """

    classified = classify_provider_error(exc)
    code = _PROVIDER_CODE_MAP[classified.code]
    return make_error(
        code,
        classified.message,
        retryable=classified.retryable,
        retry_after_seconds=classified.retry_after,
    )


def is_retryable(error: InsightError) -> bool:
    """Only retry when the contract allows the code AND the cause is retryable."""
    return bool(error.retryable) and error.code in RETRYABLE_ERROR_CODES


def default_prompt_builder(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> str:
    """Deterministic prompt: canonical JSON per slot, slot names as headers."""

    sections = [
        f"## {name}\n{to_canonical_json(payload)}"
        for name, payload in sorted(slots.items())
    ]
    return (
        f"Role: {role.canonical_key}\n"
        "Generate the Markdown output for the slots below.\n\n" + "\n\n".join(sections)
    )


def default_generate(agent: Any, prompt: str) -> LLMResult:
    """One-shot agent run with real usage; emits no per-token traffic."""

    result = asyncio.run(agent.run(prompt))
    usage = result.usage()
    return LLMResult(
        markdown=result.output if isinstance(result.output, str) else str(result.output),
        input_tokens=int(usage.request_tokens or 0),
        output_tokens=int(usage.response_tokens or 0),
    )


#: ``(endpoint_id, model_id, role, settings) -> resolved server-side model``.
ModelResolverFunc = Callable[
    [str, str, InsightRoleDefinition, Any], InsightModelSelection
]


def default_resolve_model(
    endpoint_id: str,
    model_id: str,
    role: InsightRoleDefinition,
    settings: Any,
) -> InsightModelSelection:
    """Re-resolve the persisted endpoint/model through server-side policy."""

    return InsightModelResolver(settings).resolve_model(
        endpoint_id=endpoint_id or None,
        model_id=model_id or None,
        role_id=role.role_id,
    )


_PHASE_ORDER = (
    InsightStatus.QUEUED,
    InsightStatus.AGGREGATING,
    InsightStatus.GENERATING,
    InsightStatus.FINALIZING,
)


def _guard(db: Session, run: InsightRun, attempt: int) -> bool:
    """Refresh and verify this task still owns the live attempt.

    Returns ``False`` when another session moved the row — explicit
    cancel/retry bumped ``attempt`` or parked a terminal state — and the
    caller must stop without writing, so a stale worker can never
    overwrite a cancel or a newer attempt.
    """

    run = _reload(db, run)
    if run.attempt != attempt:
        return False
    return not is_terminal(InsightStatus(run.status))


def _advance(
    db: Session,
    run: InsightRun,
    target: InsightStatus,
    *,
    attempt: int,
    stage: InsightStage,
    progress: int,
    sink: InsightEventSink,
    detail: str | None = None,
) -> bool:
    """Step forward unless already there or beyond (redelivery resume).

    Refreshes first so a cancel/retry committed by another session is
    observed: stale attempts and terminal runs return ``False`` and the
    caller must stop without writing. Every applied checkpoint is
    committed immediately, so a worker kill after this returns never
    loses the phase progress. Strict rollback rejection stays in
    :func:`runs.transition`; this helper only skips work a previous
    delivery already made durable.
    """

    run = _reload(db, run)
    if run.attempt != attempt or is_terminal(InsightStatus(run.status)):
        return False
    current = InsightStatus(run.status)
    if current == target:
        return True
    if _PHASE_ORDER.index(current) > _PHASE_ORDER.index(target):
        return True
    transition(db, run, target, stage=stage, progress=progress)
    db.commit()
    try:
        sink.on_status(run, stage, progress, detail)
    except Exception:  # noqa: BLE001 — sink is best-effort, DB state wins
        logger.warning("Insight event sink failed (status=%s)", target.value)
    return True


def _fail(
    db: Session,
    run: InsightRun,
    sink: InsightEventSink,
    error: InsightError,
) -> InsightRun:
    transition(db, run, InsightStatus.FAILED, error=error)
    db.commit()
    try:
        sink.on_terminal(to_detail(run))
    except Exception:  # noqa: BLE001
        logger.warning("Insight event sink failed (terminal=failed)")
    return run


def _fail_or_retry(
    db: Session,
    run: InsightRun,
    sink: InsightEventSink,
    error: InsightError,
    retry_after: int | None = None,
) -> InsightRun:
    if is_retryable(error):
        raise RetryableFailure(error, retry_after=retry_after)
    return _fail(db, run, sink, error)


def _reload(db: Session, run: InsightRun) -> InsightRun:
    try:
        db.refresh(run)
    except Exception:  # noqa: BLE001 — detached/rolled-back sessions keep values
        logger.debug("Insight run refresh skipped")
    return run


def execute_run(
    *,
    db: Session,
    run_id: UUID | str,
    attempt: int,
    settings: Any = None,
    resolve: ModelResolverFunc | None = None,
    generate: GenerateFunc | None = None,
    build_prompt: PromptBuilder | None = None,
    sink: InsightEventSink | None = None,
) -> InsightRun:
    """Run one attempt to a terminal state (or raise :class:`RetryableFailure`).

    Never calls the LLM for stale attempts, terminal runs, or cancelled runs.
    Every phase checkpoint is committed before returning, so a worker kill
    loses no progress; the Celery task's own commit only covers the final
    write. Guards re-read the row before each write, so a cancel/retry
    committed by another session stops this task without overwriting it.
    """

    active_sink: InsightEventSink = sink or NullEventSink()
    run = get_run(db, run_id)
    if run.attempt != attempt:
        return run
    if is_terminal(InsightStatus(run.status)):
        return run

    try:
        role = require_active(lookup_role(run.role_id, run.role_version))
    except RoleLookupError as exc:
        return _fail_or_retry(
            db,
            run,
            active_sink,
            make_error(exc.code, "Insight role is not available"),
        )

    try:
        slots = json.loads(run.slots_json or "{}")
    except ValueError:
        return _fail(
            db,
            run,
            active_sink,
            make_error(
                InsightErrorCode.SLOT_VALIDATION_FAILED,
                "Stored insight slots are unreadable",
            ),
        )
    if not isinstance(slots, dict):
        return _fail(
            db,
            run,
            active_sink,
            make_error(
                InsightErrorCode.SLOT_VALIDATION_FAILED,
                "Stored insight slots are unreadable",
            ),
        )

    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    try:
        resolve_func = resolve or default_resolve_model
        selection = resolve_func(run.endpoint_id, run.model_id, role, settings)
    except InsightProviderError as exc:
        mapped = map_provider_error(exc)
        return _fail_or_retry(
            db, run, active_sink, mapped, retry_after=mapped.retry_after_seconds
        )

    if not _guard(db, run, attempt):
        return run

    if not _advance(
        db,
        run,
        InsightStatus.AGGREGATING,
        attempt=attempt,
        stage=InsightStage.AGGREGATING,
        progress=10,
        sink=active_sink,
    ):
        return run
    # NOTE: business aggregation plugs in here (Stage 3 adapters); the stored
    # validated slots are already the aggregation input contract.
    if not _advance(
        db,
        run,
        InsightStatus.GENERATING,
        attempt=attempt,
        stage=InsightStage.GENERATING,
        progress=40,
        sink=active_sink,
    ):
        return run

    if not _guard(db, run, attempt):
        return run

    prompt = (build_prompt or default_prompt_builder)(role, slots)
    agent = create_insight_agent(selection)
    try:
        llm = (generate or default_generate)(agent, prompt)
    except RetryableFailure:
        raise
    except Exception as exc:  # noqa: BLE001 — classify, then retry or fail
        mapped = map_provider_error(exc)
        return _fail_or_retry(
            db, run, active_sink, mapped, retry_after=mapped.retry_after_seconds
        )

    if not _guard(db, run, attempt):
        return run

    markdown = (llm.markdown or "").strip()
    if not markdown:
        return _fail_or_retry(
            db,
            run,
            active_sink,
            make_error(
                InsightErrorCode.PROVIDER_UNAVAILABLE,
                "Insight provider returned empty content",
            ),
        )

    digest = sha256_hex(markdown.encode("utf-8"))
    outputs = {
        role.output_slot: InsightOutput(
            format="markdown", content=markdown, content_sha256=digest
        )
    }
    usage = InsightUsage(
        input_tokens=max(0, llm.input_tokens),
        output_tokens=max(0, llm.output_tokens),
        total_tokens=max(0, llm.input_tokens) + max(0, llm.output_tokens),
    )
    try:
        active_sink.on_content_delta(
            slot=role.output_slot, block_id="final", delta=markdown
        )
    except Exception:  # noqa: BLE001
        logger.warning("Insight event sink failed (content.delta)")

    if not _advance(
        db,
        run,
        InsightStatus.FINALIZING,
        attempt=attempt,
        stage=InsightStage.FINALIZING,
        progress=90,
        sink=active_sink,
    ):
        return run
    if not _guard(db, run, attempt):
        return run
    transition(
        db,
        run,
        InsightStatus.COMPLETED,
        progress=100,
        usage=usage,
        outputs=outputs,
        content=markdown,
    )
    db.commit()
    # COMPLETED has no InsightStage member; the run keeps FINALIZING, which is
    # what the detail snapshot and the status timeline report.
    try:
        active_sink.on_terminal(to_detail(run))
    except Exception:  # noqa: BLE001
        logger.warning("Insight event sink failed (terminal=completed)")
    return run


def start_run(
    *,
    db: Session,
    raw: dict[str, Any],
    scope_authorizer: ScopeAuthorizer,
    enqueue: EnqueueFunc | None = None,
    settings: Any = None,
    resolve: ModelResolverFunc | None = None,
) -> tuple[InsightRun, bool]:
    """Validate, idempotently create, and enqueue a run.

    Returns ``(run, replayed)``; only fresh runs are enqueued, so a replayed
    request never triggers a second LLM call. Validation/role/provider
    failures propagate as ``InsightValidationError`` / ``RoleLookupError`` /
    ``InsightProviderError`` for the HTTP layer to map.

    The fresh row is committed *before* ``enqueue`` runs: the worker starts
    from a different session and must see the row, otherwise it observes
    ``not_found`` and the task is silently lost. Callers therefore must not
    assume an open transaction after this returns.
    """

    request: InsightRunRequest = validate_run_request(
        raw, scope_authorizer=scope_authorizer
    )
    role = require_active(lookup_role(request.role_id, request.role_version))
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    if resolve is not None:
        selection = resolve(
            request.endpoint_id or "", request.model_id or "", role, settings
        )
    else:
        selection = InsightModelResolver(settings).resolve_model(
            endpoint_id=request.endpoint_id,
            model_id=request.model_id,
            role_id=request.role_id,
        )
    run, replayed = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id=selection.endpoint_id,
        model_id=selection.model_id,
    )
    if replayed:
        return run, True
    db.commit()
    if enqueue is not None:
        enqueue(run.run_id, run.attempt)
    return run, replayed


__all__ = [
    "EnqueueFunc",
    "GenerateFunc",
    "InsightEventSink",
    "LLMResult",
    "ListEventSink",
    "ModelResolverFunc",
    "NullEventSink",
    "PromptBuilder",
    "RetryableFailure",
    "default_generate",
    "default_prompt_builder",
    "default_resolve_model",
    "execute_run",
    "is_retryable",
    "map_provider_error",
    "start_run",
]
