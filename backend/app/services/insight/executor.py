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

Atomic state writes
-------------------
Every write this module makes is a compare-and-swap through
:func:`runs.try_transition`, keyed on ``(run id, attempt held by this task,
status being a legal predecessor of the target)``. Re-reading the row first
is a cheap precheck, not the guarantee: a cancel or retry that commits
between the read and the write makes the write match no row, so the stale
worker stops instead of overwriting the winner. That keeps the guarantee on
every backend — Postgres row locks are not needed for correctness, and the
SQLite tests exercise the same code path production runs.
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
    StaleRunWrite,  # noqa: F401  (re-exported for HTTP-layer mapping)
    create_run,
    get_run,
    to_detail,
    try_transition,
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


def _usage_tokens(usage: Any) -> tuple[int, int]:
    """读取 agent run 的 ``(input_tokens, output_tokens)``，兼容两代 pydantic-ai。

    2.x：``result.usage`` 是**属性**，字段 ``input_tokens``/``output_tokens``；
    旧版：``result.usage()`` 是方法，字段 ``request_tokens``/``response_tokens``。
    取数失败一律按 0 计——usage 形状变化绝不能把一个已经成功的 run 判成失败
    （生产实证：旧写法抛 TypeError 被 classify 成 PROVIDER_UNAVAILABLE 反复重试）。
    """

    if callable(usage):
        usage = usage()
    if usage is None:
        return 0, 0
    input_tokens = getattr(usage, "input_tokens", None)
    if input_tokens is None:
        input_tokens = getattr(usage, "request_tokens", 0)
    output_tokens = getattr(usage, "output_tokens", None)
    if output_tokens is None:
        output_tokens = getattr(usage, "response_tokens", 0)
    return int(input_tokens or 0), int(output_tokens or 0)


def default_generate(agent: Any, prompt: str) -> LLMResult:
    """One-shot agent run with real usage; emits no per-token traffic."""

    result = asyncio.run(agent.run(prompt))
    input_tokens, output_tokens = _usage_tokens(getattr(result, "usage", None))
    return LLMResult(
        markdown=result.output if isinstance(result.output, str) else str(result.output),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
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

    The phase write is a compare-and-swap on ``(id, attempt, status ∈
    predecessors of target)``: it is applied only if the row is still this
    attempt's to move, so a cancel/retry that commits between the read and
    the write makes the write a no-op instead of resurrecting the snapshot.
    Stale attempts and terminal runs return ``False`` and the caller stops.

    "Already there or beyond" stays an in-memory decision from the refreshed
    row, because that case means a *previous delivery* of this same attempt
    made the phase durable — it is a resume, not a race. Every applied
    checkpoint is committed immediately, so a worker kill never loses phase
    progress.
    """

    run = _reload(db, run)
    if run.attempt != attempt or is_terminal(InsightStatus(run.status)):
        return False
    current = InsightStatus(run.status)
    if current == target or _PHASE_ORDER.index(current) > _PHASE_ORDER.index(target):
        return True
    if not try_transition(
        db,
        run,
        target,
        expected_attempt=attempt,
        stage=stage,
        progress=progress,
    ):
        # Lost the claim mid-flight (cancel, retry, or a sibling delivery
        # advanced the row): the winner owns the run from here on.
        return False
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
    *,
    attempt: int,
) -> InsightRun:
    """Park a run as failed, unless it stopped being ours to fail.

    Same atomic write as the phase checkpoints, keyed on the attempt this
    task holds: on a lost claim (another session cancelled or re-attempted
    the run) nothing is written and no terminal event is emitted — the
    winner's state is the truth, and a cancelled run must not be reported as
    failed.
    """

    if not try_transition(
        db, run, InsightStatus.FAILED, expected_attempt=attempt, error=error
    ):
        return run
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
    *,
    attempt: int,
) -> InsightRun:
    if is_retryable(error):
        raise RetryableFailure(error, retry_after=retry_after)
    return _fail(db, run, sink, error, attempt=attempt)


def _reload(db: Session, run: InsightRun) -> InsightRun:
    try:
        db.refresh(run)
    except Exception:  # noqa: BLE001 — detached/rolled-back sessions keep values
        logger.debug("Insight run refresh skipped")
    return run


def _identity_cleaner(role: InsightRoleDefinition, markdown: str) -> str:
    """默认清洗：只做 strip（与 Stage 2 行为一致）。"""
    return markdown.strip()


def _no_instructions(
    role: InsightRoleDefinition, slots: dict[str, Any]
) -> tuple[str, ...]:
    """默认角色指令：空（模型无 system 指令）。"""
    return ()


def role_runtime_for(role: InsightRoleDefinition) -> tuple[Any, Any, Any]:
    """Resolve a role's server-owned prompt template, instructions, and cleaner.

    Stage 3（BLF-1014）：角色专属的 prompt/清洗由业务 adapter 提供，
    executor 只按 role_id 分发，不复制业务模板。未注册的角色保持
    Stage 2 的确定性行为（canonical JSON prompt、无 system 指令、原样
    strip）。返回 ``(prompt_builder, instructions_fn, markdown_cleaner)``，
    其中 ``instructions_fn(role, slots) -> tuple[str, ...]``。
    """
    if role.role_id == "schedule_report_summary":
        from app.services.scheduled_report.insight_adapter.prompt import (
            build_schedule_report_prompt,
            clean_schedule_report_markdown,
            schedule_report_instructions,
        )

        return (
            build_schedule_report_prompt,
            schedule_report_instructions,
            clean_schedule_report_markdown,
        )
    if role.role_id == "ad_analysis":
        from app.services.ad.insight_adapter.prompt import (
            ad_analysis_instructions,
            build_ad_analysis_prompt,
            clean_ad_analysis_markdown,
        )

        return (
            build_ad_analysis_prompt,
            ad_analysis_instructions,
            clean_ad_analysis_markdown,
        )
    if role.role_id == "inventory_health":
        from app.services.inventory.insight_adapter.prompt import (
            build_inventory_health_prompt,
            clean_inventory_health_markdown,
            inventory_health_instructions,
        )

        return (
            build_inventory_health_prompt,
            inventory_health_instructions,
            clean_inventory_health_markdown,
        )
    return default_prompt_builder, _no_instructions, _identity_cleaner


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
    write. Each write is a compare-and-swap on the attempt this task holds,
    so a cancel/retry committed by another session makes the stale worker
    stop instead of overwriting it — the database, not the refreshed
    snapshot, decides the winner.
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
            attempt=attempt,
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
            attempt=attempt,
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
            attempt=attempt,
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
            db,
            run,
            active_sink,
            mapped,
            retry_after=mapped.retry_after_seconds,
            attempt=attempt,
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

    prompt_builder, instructions_for, cleaner = role_runtime_for(role)
    try:
        prompt = (build_prompt or prompt_builder)(role, slots)
        role_instructions = instructions_for(role, slots)
    except Exception as exc:
        # prompt/指令构建在 provider try 之外：异常穿出 execute_run 会被
        # Celery 当「任务异常」丢弃，run 行永远停在 generating，交付侧
        # （schedule report 的终态回写）永远等不到终态（BLF-1014 复核阻塞 2）。
        # 载荷形状错误是确定性的，重试无意义 → 直接落 FAILED 终止态。
        logger.exception("Insight prompt build failed (run_id=%s)", run.run_id)
        return _fail(
            db,
            run,
            active_sink,
            make_error(
                InsightErrorCode.SLOT_VALIDATION_FAILED,
                f"{role.canonical_key} payload could not be rendered into a prompt"
                f" ({type(exc).__name__})",
                # 主载荷 slot 由 role 自身的必填声明决定，避免硬编码某个域
                # （BLF-1016：同一执行器服务三个 role）。
                slot=role.required_slots[0] if role.required_slots else None,
            ),
            attempt=attempt,
        )
    agent = create_insight_agent(selection, role_instructions=role_instructions)
    try:
        llm = (generate or default_generate)(agent, prompt)
    except RetryableFailure:
        raise
    except Exception as exc:  # noqa: BLE001 — classify, then retry or fail
        mapped = map_provider_error(exc)
        return _fail_or_retry(
            db,
            run,
            active_sink,
            mapped,
            retry_after=mapped.retry_after_seconds,
            attempt=attempt,
        )

    if not _guard(db, run, attempt):
        return run
    markdown = cleaner(role, (llm.markdown or "").strip())
    if not markdown:
        return _fail_or_retry(
            db,
            run,
            active_sink,
            make_error(
                InsightErrorCode.PROVIDER_UNAVAILABLE,
                "Insight provider returned empty content",
            ),
            attempt=attempt,
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
    if not try_transition(
        db,
        run,
        InsightStatus.COMPLETED,
        expected_attempt=attempt,
        progress=100,
        usage=usage,
        outputs=outputs,
        content=markdown,
    ):
        # A cancel (or retry) committed while the model was answering: the
        # terminal state is the winner's, and this attempt must not stamp
        # COMPLETED over it.
        return run
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
