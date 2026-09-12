"""Insight 观测期指标与质量/成本门禁（BLF-1018，Stage 5）。

观测期要回答四个问题，本模块是唯一的计算入口：

1. **跑得怎么样**：按 run / capability 记录首字时延、总时长、token 用量、
   重连次数、取消结果、Stream 体量、错误类型与降级事件。
2. **是否达标**：把这些指标按桶聚合，与阈值（``Settings.insight_gate_*``，
   默认值锚定仓库既有数字，见 config 注释）比对，输出可审计的结论。
3. **能否退役 legacy**：只有指标门禁全过、CodeGraph 调用方清零、回滚演练
   通过三者同时成立才允许 —— 本模块给出其中「指标」这一票（
   :func:`is_retirement_eligible`），另两票见 ``scripts/insight_gate.py``。
4. **是否泄漏**：落库字段是白名单，system prompt / API key / base_url /
   原始 slot 不进入本表，也不进入日志（见 :data:`FORBIDDEN_SOURCES`）。

数据流（Redis 是缓冲，DB 是审计）
--------------------------------
``InsightStreamWriter`` 在发布帧、首个 content.delta、取消请求时往 per-run
计数 hash（``bb:insight:metrics:{run_id}``）自增；run 到终态时
:func:`finalize_run_observation` 读一次该 hash + Stream 体量，写成
``insight_run_observations`` 的一行（``run_id`` 唯一 → 重复快照覆盖同一行）。
未终态的 run 不落行；降级事件另起一行（``source='legacy_fallback'``，无
run_id），作为降级比例的分子。

写作纪律：任何一次记录失败都不影响 run 本身（best-effort，吞掉异常并降级为
一条 warning），因为观测是旁路，run 的 DB 行才是权威。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.insight_run import InsightRun
from app.models.insight_run_observation import (
    SOURCE_INSIGHT_RUN,
    SOURCE_LEGACY_FALLBACK,
    InsightRunObservation,
)
from app.schemas.insight import InsightStatus, InsightUsage
from app.services.insight.stream_bus import (
    METRIC_CANCEL_REQUESTED,
    METRIC_CANCEL_SUCCEEDED,
    METRIC_FIRST_DELTA_MS,
    METRIC_RECONNECT_COMPLETED,
    METRIC_STREAM_BYTES,
    METRIC_STREAM_FRAMES,
    METRIC_STREAM_OPENS,
    METRIC_STREAM_RECONNECTS,
    InsightStreamWriter,
)

logger = logging.getLogger(__name__)


#: 不允许出现在观测行、日志里的载荷键（= 客户端禁止提交的服务端凭据/提示词）。
#: 观测期只记结构化的错误码/角色/用量，永远不记这些键的值。
FORBIDDEN_SOURCES = (
    "system_prompt",
    "instructions",
    "api_key",
    "base_url",
    "provider_url",
    "slots",
    "slots_json",
)

#: 降级事件的桶名（未经 canonical Insight 服务的旧链路）。
FALLBACK_CAPABILITY_AI_SUMMARY = "ai_summary"
FALLBACK_CAPABILITY_LEGACY_INSIGHT = "legacy_insight"

#: 门禁严重度：blocking = 挡住退役；warning = 只看不管；info = 仅报数。
SEVERITY_BLOCKING = "blocking"
SEVERITY_WARNING = "warning"
SEVERITY_INFO = "info"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ── 记录 ────────────────────────────────────────────────────────────────


def _metric_int(metrics: dict[str, int], name: str) -> int:
    try:
        return int(metrics.get(name, 0))
    except (TypeError, ValueError):
        return 0


def _usage_of(run: InsightRun) -> InsightUsage | None:
    if not run.usage_json:
        return None
    try:
        return InsightUsage.model_validate_json(run.usage_json)
    except Exception:  # noqa: BLE001 — 旧行/脏行不该让记录失败
        return None


def _error_pair(run: InsightRun) -> tuple[str | None, bool | None]:
    """（错误码, 是否可重试）——只取码与布尔，不取 message（可能含上游文本）。"""
    if not run.error_json:
        return None, None
    try:
        import json

        payload = json.loads(run.error_json)
    except ValueError:
        return None, None
    code = payload.get("code") if isinstance(payload, dict) else None
    retryable = payload.get("retryable") if isinstance(payload, dict) else None
    return (str(code) if code else None), (
        bool(retryable) if retryable is not None else None
    )


def record_run_snapshot(
    db: Session,
    run: InsightRun,
    *,
    metrics: dict[str, int] | None = None,
    footprint: tuple[int | None, int | None] | None = None,
) -> InsightRunObservation | None:
    """Upsert one terminal run's observation row (idempotent by ``run_id``）。

    只记录终态 run：观测期看的是「一次已结算的执行」。重复调用（worker
    终态路径 + 取消路径都调用）覆盖同一行，因此 ``cancel_succeeded`` 之类
    的字段能在取消落地后补正。返回写好（或已存在且未变）的行；异常向上抛，
    由 :func:`finalize_run_observation` 兜底吞掉。
    """
    if not run.run_id:
        return None
    usage = _usage_of(run)
    error_code, error_retryable = _error_pair(run)
    metrics = metrics or {}
    xlen, memory = footprint if footprint else (None, None)
    cancel_requested = _metric_int(metrics, METRIC_CANCEL_REQUESTED) > 0
    succeeded = _metric_int(metrics, METRIC_CANCEL_SUCCEEDED) > 0
    cancel_succeeded: bool | None
    if not cancel_requested:
        cancel_succeeded = None
    elif run.status == InsightStatus.CANCELLED.value:
        # 行已成 cancelled：无论请求计数来自本次还是早前的请求，结果已达成。
        cancel_succeeded = True
    else:
        cancel_succeeded = succeeded

    row = db.scalar(
        select(InsightRunObservation).where(InsightRunObservation.run_id == run.run_id)
    )
    if row is None:
        row = InsightRunObservation(run_id=run.run_id)
        db.add(row)
    row.source = SOURCE_INSIGHT_RUN
    row.attempt = run.attempt
    row.capability = run.capability or "insight"
    row.role_id = run.role_id
    row.endpoint_id = run.endpoint_id
    row.model_id = run.model_id
    row.status = run.status
    first_delta = _metric_int(metrics, METRIC_FIRST_DELTA_MS)
    row.first_delta_ms = first_delta if first_delta > 0 else None
    row.duration_ms = run.duration_ms
    row.input_tokens = usage.input_tokens if usage else None
    row.output_tokens = usage.output_tokens if usage else None
    row.total_tokens = usage.total_tokens if usage else None
    row.attempts = run.attempt
    row.retries = max(0, (run.attempt or 1) - 1)
    row.stream_opens = _metric_int(metrics, METRIC_STREAM_OPENS)
    row.stream_reconnects = _metric_int(metrics, METRIC_STREAM_RECONNECTS)
    # 续传闭环：带游标重连后确实观测到终态帧（0/1，由 SSE 端点写入）。
    row.reconnect_completed = _metric_int(metrics, METRIC_RECONNECT_COMPLETED) > 0
    row.stream_frames = _metric_int(metrics, METRIC_STREAM_FRAMES)
    stream_bytes = _metric_int(metrics, METRIC_STREAM_BYTES)
    row.stream_bytes = stream_bytes or None
    row.stream_xlen = xlen
    row.stream_memory_bytes = memory
    row.cancel_requested = cancel_requested
    row.cancel_succeeded = cancel_succeeded
    row.error_code = error_code
    row.error_retryable = error_retryable
    row.fallback = False
    row.updated_at = _utcnow()
    return row


def finalize_run_observation(
    run_id: str,
    *,
    session_factory: Callable[[], Session] | None = None,
    writer: InsightStreamWriter | None = None,
    settings: Any = None,
) -> bool:
    """Record the observation row for a terminal run; never raises.

    Called from every terminal path (worker completion, park-failed, HTTP
    cancel) on a **fresh session**: the caller may already have committed and
    the recording must not ride an open transaction. Non-terminal runs and
    unknown ids are no-ops. Returns ``True`` when a row was written.
    """
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    if not getattr(settings, "insight_observation_enabled", True):
        return False
    if session_factory is None:
        from app.db.session import SessionLocal

        session_factory = SessionLocal
    active_writer = writer or InsightStreamWriter()
    db = session_factory()
    try:
        run = db.scalar(select(InsightRun).where(InsightRun.run_id == str(run_id)))
        if run is None:
            return False
        if run.status not in {
            InsightStatus.COMPLETED.value,
            InsightStatus.FAILED.value,
            InsightStatus.CANCELLED.value,
        }:
            return False
        metrics = {}
        footprint: tuple[int | None, int | None] = (None, None)
        try:
            # 传输层读数单独兜底：Redis 挂掉只让指标缺省，不能让这一行丢掉
            # —— 观测行是审计证据，宁可少字段也不能少行。
            metrics = active_writer.read_metrics(run.run_id)
            footprint = active_writer.stream_footprint(run.run_id)
        except Exception:
            logger.warning(
                "Insight 指标读取失败（run=%s）；按空指标落行", run_id, exc_info=True
            )
        record_run_snapshot(db, run, metrics=metrics, footprint=footprint)
        db.commit()
        return True
    except Exception:
        db.rollback()
        logger.warning(
            "Insight 观测快照写入失败（run=%s）；run 状态不受影响", run_id,
            exc_info=True,
        )
        return False
    finally:
        db.close()


def record_fallback(
    *,
    capability: str,
    reason: str,
    role_id: str | None = None,
    run_id: str | None = None,
    session_factory: Callable[[], Session] | None = None,
    settings: Any = None,
) -> bool:
    """Record one degraded (non-canonical) service event; never raises.

    ``capability`` is the bucket the fallback belongs to (``ai_summary`` for
    the scheduled-report summary, ``legacy_insight`` for the old AIInsight
    chain), so the桶内降级比例 = fallback 事件 / (canonical run + fallback)。
    Only the reason code is stored — the payload that triggered the fallback
    (report content, prompt) never lands here.
    """
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    if not getattr(settings, "insight_observation_enabled", True):
        return False
    if session_factory is None:
        from app.db.session import SessionLocal

        session_factory = SessionLocal
    db = session_factory()
    try:
        row = InsightRunObservation(
            source=SOURCE_LEGACY_FALLBACK,
            run_id=run_id,
            capability=capability,
            role_id=role_id,
            fallback=True,
            fallback_reason=reason[:128],
        )
        db.add(row)
        db.commit()
        return True
    except Exception:
        db.rollback()
        logger.warning(
            "Insight 降级事件记录失败（capability=%s reason=%s）", capability, reason,
            exc_info=True,
        )
        return False
    finally:
        db.close()


# ── 聚合 ────────────────────────────────────────────────────────────────


def _percentile(values: list[int], pct: float) -> int | None:
    """Nearest-rank percentile over a small in-memory window (no SQL dialect 依赖)."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = max(0, min(len(ordered) - 1, round(pct * (len(ordered) - 1))))
    return ordered[index]


def _median(values: list[int]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return float(ordered[mid])
    return (ordered[mid - 1] + ordered[mid]) / 2.0


@dataclass
class CapabilityMetrics:
    """One bucket's aggregated observation window."""

    capability: str
    runs: int = 0
    completed: int = 0
    failed: int = 0
    cancelled: int = 0
    fallback_events: int = 0
    cancel_requested: int = 0
    cancel_succeeded: int = 0
    retried_runs: int = 0
    stream_opens: int = 0
    stream_reconnects: int = 0
    #: 续传后观测到终态帧的 run 数（``stream_reconnects`` 的闭环分子）。
    reconnect_completed: int = 0
    stream_frames: int = 0
    stream_bytes: int = 0
    max_stream_xlen: int | None = None
    max_stream_memory_bytes: int | None = None
    total_tokens: int = 0
    avg_duration_ms: int | None = None
    p95_duration_ms: int | None = None
    max_duration_ms: int | None = None
    avg_first_delta_ms: int | None = None
    p95_first_delta_ms: int | None = None
    max_first_delta_ms: int | None = None
    error_counts: dict[str, int] = field(default_factory=dict)
    cost_anomalies: list[str] = field(default_factory=list)

    @property
    def reconnect_rate(self) -> float:
        return (
            round(self.stream_reconnects / self.stream_opens, 4)
            if self.stream_opens
            else 0.0
        )

    @property
    def cancel_success_rate(self) -> float | None:
        if not self.cancel_requested:
            return None
        return round(self.cancel_succeeded / self.cancel_requested, 4)

    @property
    def fallback_ratio(self) -> float:
        total = self.runs + self.fallback_events
        return round(self.fallback_events / total, 4) if total else 0.0

    @property
    def error_rate(self) -> float:
        return round(self.failed / self.runs, 4) if self.runs else 0.0


def _aggregate_rows(
    rows: list[InsightRunObservation],
) -> tuple[dict[str, CapabilityMetrics], dict[str, dict[str, list[Any]]]]:
    """Fold observation rows into per-capability buckets (+ raw samples)."""
    buckets: dict[str, CapabilityMetrics] = {}
    samples: dict[str, dict[str, list[Any]]] = {}
    for row in rows:
        name = row.capability or "insight"
        bucket = buckets.setdefault(name, CapabilityMetrics(name))
        sample = samples.setdefault(
            name, {"duration": [], "first_delta": [], "tokens": [], "run_ids": []}
        )
        if row.source == SOURCE_LEGACY_FALLBACK:
            bucket.fallback_events += 1
            continue
        bucket.runs += 1
        if row.status == InsightStatus.COMPLETED.value:
            bucket.completed += 1
        elif row.status == InsightStatus.FAILED.value:
            bucket.failed += 1
        elif row.status == InsightStatus.CANCELLED.value:
            bucket.cancelled += 1
        if row.error_code:
            bucket.error_counts[row.error_code] = bucket.error_counts.get(row.error_code, 0) + 1
        if row.cancel_requested:
            bucket.cancel_requested += 1
            if row.cancel_succeeded:
                bucket.cancel_succeeded += 1
        if (row.retries or 0) > 0:
            bucket.retried_runs += 1
        bucket.stream_opens += row.stream_opens or 0
        bucket.stream_reconnects += row.stream_reconnects or 0
        if row.reconnect_completed:
            bucket.reconnect_completed += 1
        bucket.stream_frames += row.stream_frames or 0
        bucket.stream_bytes += row.stream_bytes or 0
        if row.stream_xlen is not None:
            bucket.max_stream_xlen = max(bucket.max_stream_xlen or 0, row.stream_xlen)
        if row.stream_memory_bytes is not None:
            bucket.max_stream_memory_bytes = max(
                bucket.max_stream_memory_bytes or 0, row.stream_memory_bytes
            )
        bucket.total_tokens += row.total_tokens or 0
        if row.duration_ms is not None:
            sample["duration"].append(row.duration_ms)
        if row.first_delta_ms is not None:
            sample["first_delta"].append(row.first_delta_ms)
        sample["tokens"].append(row.total_tokens or 0)
        sample["run_ids"].append((str(row.run_id), row.total_tokens or 0))
    return buckets, samples


def _finalize_buckets(
    buckets: dict[str, CapabilityMetrics],
    samples: dict[str, dict[str, list[Any]]],
    *,
    cost_multiplier: float,
) -> None:
    for name, bucket in buckets.items():
        sample = samples.get(name, {})
        durations = sample.get("duration") or []
        if durations:
            bucket.avg_duration_ms = int(sum(durations) / len(durations))
            bucket.p95_duration_ms = _percentile(durations, 0.95)
            bucket.max_duration_ms = max(durations)
        deltas = sample.get("first_delta") or []
        if deltas:
            bucket.avg_first_delta_ms = int(sum(deltas) / len(deltas))
            bucket.p95_first_delta_ms = _percentile(deltas, 0.95)
            bucket.max_first_delta_ms = max(deltas)
        tokens = sample.get("tokens") or []
        # 成本异常：单 run token 超过桶内中位数的 N 倍（样本 >= 3 才判定，
        # 否则中位数不稳、误报多）。比例判定不依赖模型单价，跨模型可比。
        if cost_multiplier > 0 and len(tokens) >= 3:
            med = _median(tokens)
            if med:
                limit = med * cost_multiplier
                bucket.cost_anomalies = [
                    run_id
                    for run_id, value in (sample.get("run_ids") or [])
                    if value > limit
                ]


def aggregate_observations(
    db: Session,
    *,
    window_days: int = 7,
    capability: str | None = None,
    cost_multiplier: float = 5.0,
    now: datetime | None = None,
) -> list[CapabilityMetrics]:
    """Aggregate the observation window, one bucket per capability."""
    cutoff = (now or _utcnow()) - timedelta(days=max(1, window_days))
    stmt = select(InsightRunObservation).where(
        InsightRunObservation.created_at >= cutoff
    )
    if capability:
        stmt = stmt.where(InsightRunObservation.capability == capability)
    rows = list(db.execute(stmt).scalars().all())
    buckets, samples = _aggregate_rows(rows)
    _finalize_buckets(buckets, samples, cost_multiplier=cost_multiplier)
    return [buckets[key] for key in sorted(buckets)]


# ── 门禁 ────────────────────────────────────────────────────────────────

#: 首个 canonical 域 —— 退役门禁只看这些桶（旧桶的失败不影响新链路判定）。
CANONICAL_CAPABILITIES = ("insight",)


@dataclass(frozen=True)
class GateFinding:
    """One auditable threshold verdict (metric observed vs. threshold)."""

    code: str
    severity: str
    capability: str
    metric: str
    observed: Any
    threshold: Any
    detail: str = ""


@dataclass(frozen=True)
class GateReport:
    """Observation-window verdict; ``eligible_for_retirement`` is one of three votes.

    ``eligible_for_retirement`` / ``retirement_reasons`` 是**唯一**的指标票口径：
    report 属性、请求响应 JSON、审计脚本都走这里，不允许各处各判一次。
    """

    window_days: int
    buckets: list[CapabilityMetrics]
    findings: list[GateFinding]
    generated_at: datetime

    @property
    def blocking_findings(self) -> list[GateFinding]:
        """全部 blocking 结论（含 legacy 桶）——审计口径，不等于退役口径。"""
        return [f for f in self.findings if f.severity == SEVERITY_BLOCKING]

    @property
    def retirement_reasons(self) -> list[str]:
        """指标票未通过的原因（canonical 桶有样本 + 无 blocking 结论才算通过）。"""
        reasons: list[str] = []
        by_capability = {b.capability: b for b in self.buckets}
        for name in CANONICAL_CAPABILITIES:
            bucket = by_capability.get(name)
            if bucket is None or bucket.runs <= 0:
                reasons.append(f"insufficient_data:{name}.runs=0")
        for finding in self.blocking_findings:
            if finding.capability in CANONICAL_CAPABILITIES:
                reasons.append(f"{finding.code}:{finding.metric}={finding.observed}")
        return reasons

    @property
    def eligible_for_retirement(self) -> bool:
        """指标票：canonical 桶有样本且无 blocking 结论。

        空窗口**不算达标** —— 没有证据的「通过」会让退役批准建立在空数据上。
        """
        return not self.retirement_reasons

    def as_dict(self) -> dict[str, Any]:
        return {
            "window_days": self.window_days,
            "generated_at": self.generated_at.isoformat(),
            "eligible_for_retirement": self.eligible_for_retirement,
            "retirement_reasons": self.retirement_reasons,
            # 与 eligible_for_retirement 同源：为 0 ⇔ 指标票通过（含 legacy 桶的
            # blocking 结论仍完整保留在 findings 里，只是不参与退役判定）。
            "blocking_count": len(self.retirement_reasons),
            "buckets": [
                {
                    "capability": b.capability,
                    "runs": b.runs,
                    "completed": b.completed,
                    "failed": b.failed,
                    "cancelled": b.cancelled,
                    "fallback_events": b.fallback_events,
                    "fallback_ratio": b.fallback_ratio,
                    "error_rate": b.error_rate,
                    "error_counts": b.error_counts,
                    "retried_runs": b.retried_runs,
                    "cancel_requested": b.cancel_requested,
                    "cancel_succeeded": b.cancel_succeeded,
                    "cancel_success_rate": b.cancel_success_rate,
                    "stream_opens": b.stream_opens,
                    "stream_reconnects": b.stream_reconnects,
                    "reconnect_rate": b.reconnect_rate,
                    "reconnect_completed": b.reconnect_completed,
                    "stream_frames": b.stream_frames,
                    "stream_bytes": b.stream_bytes,
                    "max_stream_xlen": b.max_stream_xlen,
                    "max_stream_memory_bytes": b.max_stream_memory_bytes,
                    "total_tokens": b.total_tokens,
                    "avg_duration_ms": b.avg_duration_ms,
                    "p95_duration_ms": b.p95_duration_ms,
                    "max_duration_ms": b.max_duration_ms,
                    "avg_first_delta_ms": b.avg_first_delta_ms,
                    "p95_first_delta_ms": b.p95_first_delta_ms,
                    "max_first_delta_ms": b.max_first_delta_ms,
                    "cost_anomalies": b.cost_anomalies,
                }
                for b in self.buckets
            ],
            "findings": [
                {
                    "code": f.code,
                    "severity": f.severity,
                    "capability": f.capability,
                    "metric": f.metric,
                    "observed": f.observed,
                    "threshold": f.threshold,
                    "detail": f.detail,
                }
                for f in self.findings
            ],
        }


def evaluate_gates(
    buckets: list[CapabilityMetrics], thresholds: Any
) -> list[GateFinding]:
    """Compare每个桶的指标与阈值，产出可审计的结论清单。

    ``thresholds`` 是任意带 ``insight_gate_*`` 属性的对象（真实 settings 或
    测试里的 ``SimpleNamespace``）；``0`` 表示该项不判定 —— 只报数，
    避免用一个没依据的数字当门禁。
    """
    findings: list[GateFinding] = []
    max_duration = getattr(thresholds, "insight_gate_max_duration_ms", 0) or 0
    max_first_delta = getattr(thresholds, "insight_gate_max_first_delta_ms", 0) or 0
    max_frames = getattr(thresholds, "insight_gate_max_stream_frames", 0) or 0
    # 降级与上述阈值同语义：0.0 = 不判定（只报数）。想表达「不允许降级」就配
    # 一个正的下限（如 0.0001），而不是拿 0 兼作两种含义。
    max_fallback = getattr(thresholds, "insight_gate_max_fallback_ratio", 0.0) or 0.0

    for bucket in buckets:
        cap = bucket.capability
        if bucket.runs == 0 and bucket.fallback_events == 0:
            continue
        if max_duration and (bucket.max_duration_ms or 0) > max_duration:
            findings.append(
                GateFinding(
                    code="duration_exceeded",
                    severity=SEVERITY_BLOCKING,
                    capability=cap,
                    metric="max_duration_ms",
                    observed=bucket.max_duration_ms,
                    threshold=max_duration,
                    detail="存在单次执行超过执行器 soft_time_limit 预算",
                )
            )
        if max_first_delta and (bucket.max_first_delta_ms or 0) > max_first_delta:
            findings.append(
                GateFinding(
                    code="first_delta_exceeded",
                    severity=SEVERITY_BLOCKING,
                    capability=cap,
                    metric="max_first_delta_ms",
                    observed=bucket.max_first_delta_ms,
                    threshold=max_first_delta,
                    detail="首字时延超过 provider 调用预算",
                )
            )
        if max_frames and (bucket.max_stream_xlen or 0) >= max_frames:
            findings.append(
                GateFinding(
                    code="stream_retention_exhausted",
                    severity=SEVERITY_WARNING,
                    capability=cap,
                    metric="max_stream_xlen",
                    observed=bucket.max_stream_xlen,
                    threshold=max_frames,
                    detail="Stream 已达 maxlen，续传将退化到快照重建",
                )
            )
        if max_fallback and bucket.fallback_ratio > max_fallback:
            findings.append(
                GateFinding(
                    code="fallback_observed",
                    severity=SEVERITY_BLOCKING,
                    capability=cap,
                    metric="fallback_ratio",
                    observed=bucket.fallback_ratio,
                    threshold=max_fallback,
                    detail=f"{bucket.fallback_events} 次降级事件落在该桶",
                )
            )
        if bucket.cancel_requested and bucket.cancel_success_rate != 1.0:
            findings.append(
                GateFinding(
                    code="cancel_not_landed",
                    severity=SEVERITY_BLOCKING,
                    capability=cap,
                    metric="cancel_success_rate",
                    observed=bucket.cancel_success_rate,
                    threshold=1.0,
                    detail="存在取消请求未落地（请求时已终态）",
                )
            )
        if bucket.cost_anomalies:
            findings.append(
                GateFinding(
                    code="cost_anomaly",
                    severity=SEVERITY_BLOCKING,
                    capability=cap,
                    metric="total_tokens",
                    observed=len(bucket.cost_anomalies),
                    threshold=f">{getattr(thresholds, 'insight_gate_cost_anomaly_multiplier', 5.0)}x median",
                    detail=f"异常 run: {','.join(bucket.cost_anomalies[:5])}",
                )
            )
        if bucket.failed:
            findings.append(
                GateFinding(
                    code="failures_observed",
                    severity=SEVERITY_INFO,
                    capability=cap,
                    metric="failed",
                    observed=bucket.failed,
                    threshold=None,
                    detail=f"错误分布 {bucket.error_counts}",
                )
            )
        if bucket.retried_runs:
            findings.append(
                GateFinding(
                    code="retries_observed",
                    severity=SEVERITY_INFO,
                    capability=cap,
                    metric="retried_runs",
                    observed=bucket.retried_runs,
                    threshold=None,
                    detail="重试率供观察，不作为门禁",
                )
            )
    return findings


def gate_report(
    db: Session,
    *,
    settings: Any = None,
    window_days: int | None = None,
    capability: str | None = None,
    now: datetime | None = None,
) -> GateReport:
    """Build the full observation-window verdict (aggregate + thresholds)."""
    if settings is None:
        from app.core.config import get_settings

        settings = get_settings()
    window = int(window_days or getattr(settings, "insight_observation_window_days", 7))
    multiplier = float(getattr(settings, "insight_gate_cost_anomaly_multiplier", 5.0))
    buckets = aggregate_observations(
        db,
        window_days=window,
        capability=capability,
        cost_multiplier=multiplier,
        now=now,
    )
    return GateReport(
        window_days=window,
        buckets=buckets,
        findings=evaluate_gates(buckets, settings),
        generated_at=datetime.now(timezone.utc),
    )


def is_retirement_eligible(report: GateReport) -> tuple[bool, list[str]]:
    """「指标达标」这一票：返回 (是否通过, 未通过原因)。

    只对 canonical 桶（``CANONICAL_CAPABILITIES``）判定 —— 旧桶（如
    ``ai_summary``）本身就是待退役对象，它的降级/失败不该挡住新链路的结论。

    「窗口内没有样本」不算达标：观测期的意义就是拿证据说话，空窗口下发
    「通过」会让退役批准建立在没有数据之上（验收 §3 要求先达标才退役）。

    与 ``GateReport.eligible_for_retirement`` / ``as_dict()`` 同源：脚本、
    报告属性、HTTP 响应三处只允许有一个口径。
    """
    reasons = report.retirement_reasons
    return (not reasons), list(reasons)


__all__ = [
    "CANONICAL_CAPABILITIES",
    "FALLBACK_CAPABILITY_AI_SUMMARY",
    "FALLBACK_CAPABILITY_LEGACY_INSIGHT",
    "FORBIDDEN_SOURCES",
    "SEVERITY_BLOCKING",
    "SEVERITY_INFO",
    "SEVERITY_WARNING",
    "CapabilityMetrics",
    "GateFinding",
    "GateReport",
    "aggregate_observations",
    "evaluate_gates",
    "finalize_run_observation",
    "gate_report",
    "is_retirement_eligible",
    "record_fallback",
    "record_run_snapshot",
]
