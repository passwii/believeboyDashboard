"""BLF-1018：观测期指标落库、聚合与门禁判定（含脱敏保证）。

这一层是「观测期质量/成本门禁」的计算核心，所以逐条钉住三件事：

1. **记录**：终态 run 的快照字段来自何处（run 行 + Redis 计数器），降级事件
   单独成行；记录失败永不影响 run 本身。
2. **聚合/判定**：桶内比率、百分位、成本异常，以及阈值语义（``0`` = 只报数
   不判定，绝不把没有依据的数字当门禁）；legacy 桶的失败不挡 canonical 结论。
3. **脱敏**：prompt / API key / base_url / 原始 slot **值**绝不出现在观测行、
   日志、Redis 指标 hash 里 —— 只记错误码、角色、用量这类可审计字段。

用文件型 sqlite（同 ``test_durability.py``）：``finalize_run_observation`` 会开
自己的 session，内存库在第二条连接上会看不到行。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import fakeredis
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.insight_run import InsightRun
from app.models.insight_run_observation import (
    SOURCE_INSIGHT_RUN,
    SOURCE_LEGACY_FALLBACK,
    InsightRunObservation,
)
from app.schemas.insight import (
    InsightErrorCode,
    InsightStatus,
    InsightUsage,
    make_error,
)
from app.services.insight import stream_bus
from app.services.insight.observation import (
    FALLBACK_CAPABILITY_AI_SUMMARY,
    SEVERITY_BLOCKING,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    aggregate_observations,
    evaluate_gates,
    finalize_run_observation,
    gate_report,
    is_retirement_eligible,
    record_fallback,
    record_run_snapshot,
)
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

#: 三个故意塞进 run 行的敏感值：任何一处泄漏都由 TestRedaction 抓到。
SECRET_PROMPT = "SYSTEM-PROMPT-DO-NOT-LOG"
SECRET_API_KEY = "sk-live-SUPER-SECRET"
SECRET_SLOT_BODY = "RAW-SLOT-PAYLOAD-DO-NOT-LOG"


def _settings(**overrides: Any) -> Any:
    values: dict[str, Any] = {
        "insight_observation_enabled": True,
        "insight_observation_window_days": 7,
        "insight_gate_max_duration_ms": 0,
        "insight_gate_max_first_delta_ms": 0,
        "insight_gate_max_stream_frames": 0,
        "insight_gate_max_fallback_ratio": 0.0,
        "insight_gate_cost_anomaly_multiplier": 5.0,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture()
def engine(tmp_path):
    from app.db.session import Base

    eng = create_engine(f"sqlite:///{tmp_path}/observation.db", future=True)
    Base.metadata.create_all(eng)
    try:
        yield eng
    finally:
        eng.dispose()


@pytest.fixture()
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture()
def db(session_factory) -> Iterator[Session]:
    session = session_factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def writer() -> InsightStreamWriter:
    return InsightStreamWriter(client=fakeredis.FakeRedis())


def _run(
    db: Session,
    *,
    status: str = InsightStatus.COMPLETED.value,
    capability: str = "insight",
    attempt: int = 1,
    duration_ms: int | None = 4_000,
    usage: InsightUsage | None = None,
    error: Any = None,
    slots: str = "{}",
    run_id: str | None = None,
) -> InsightRun:
    rid = run_id or uuid4().hex
    row = InsightRun(
        run_id=rid,
        attempt=attempt,
        capability=capability,
        use_case="schedule_report_summary",
        project_id=1,
        country="US",
        role_id="schedule_report_summary",
        role_version=1,
        endpoint_id="default",
        model_id="fake-model",
        status=status,
        stage="finalizing",
        progress_percent=90,
        idempotency_key=f"key-{rid[:8]}",
        request_fingerprint="0" * 64,
        slots_json=slots,
        status_timeline_json="[]",
        usage_json=usage.model_dump_json() if usage else None,
        error_json=(
            json.dumps(
                {
                    "code": error.code.value,
                    "message": f"{SECRET_PROMPT} {error.message}",
                    "retryable": error.retryable,
                }
            )
            if error
            else None
        ),
        duration_ms=duration_ms,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    db.add(row)
    db.commit()
    return row


def _metrics(**overrides: int) -> dict[str, int]:
    values = {
        METRIC_STREAM_OPENS: 1,
        METRIC_STREAM_RECONNECTS: 0,
        METRIC_STREAM_FRAMES: 12,
        METRIC_STREAM_BYTES: 2_048,
        METRIC_FIRST_DELTA_MS: 1_500,
        METRIC_CANCEL_REQUESTED: 0,
        METRIC_CANCEL_SUCCEEDED: 0,
    }
    values.update(overrides)
    return values


# --------------------------------------------------------------------------
# 1. 记录
# --------------------------------------------------------------------------


class TestRecordRunSnapshot:
    def test_snapshot_carries_run_and_transport_metrics(self, db: Session) -> None:
        run = _run(
            db,
            usage=InsightUsage(input_tokens=100, output_tokens=250, total_tokens=350),
        )
        row = record_run_snapshot(
            db,
            run,
            metrics=_metrics(**{METRIC_STREAM_RECONNECTS: 2}),
            footprint=(57, 8_192),
        )
        db.commit()

        assert row is not None
        assert row.source == SOURCE_INSIGHT_RUN
        assert (row.capability, row.status, row.attempt) == ("insight", "completed", 1)
        assert (row.first_delta_ms, row.duration_ms) == (1_500, 4_000)
        assert (row.input_tokens, row.output_tokens, row.total_tokens) == (100, 250, 350)
        assert (row.stream_opens, row.stream_reconnects) == (1, 2)
        assert (row.stream_frames, row.stream_bytes) == (12, 2_048)
        assert (row.stream_xlen, row.stream_memory_bytes) == (57, 8_192)
        # 未请求取消 → 结果未知（None），不是「取消失败」。
        assert row.cancel_requested is False
        assert row.cancel_succeeded is None
        assert row.fallback is False

    def test_first_delta_clamped_to_duration(self, db: Session) -> None:
        """BLF-1111：首字不可能晚于 run 时长。

        取消路径的 ``completed_at``/``duration_ms`` 在取消落地时就写了，worker
        到下一个 guard 才停，其后仍可能投出第一帧（生产实测：取消的 run 出现
        first_delta_ms 28,806,485 > duration_ms 28,804,033）。那种帧描述的已不是
        活跃 run，落库时夹进 duration_ms。
        """
        run = _run(db, status=InsightStatus.CANCELLED.value, duration_ms=4_000)
        row = record_run_snapshot(
            db, run, metrics=_metrics(**{METRIC_FIRST_DELTA_MS: 6_485})
        )
        db.commit()

        assert row is not None
        assert (row.first_delta_ms, row.duration_ms) == (4_000, 4_000)

    def test_first_delta_under_duration_is_untouched(self, db: Session) -> None:
        """夹取只在越界时生效，正常值不被改写。"""
        run = _run(db, duration_ms=10_000)
        row = record_run_snapshot(
            db, run, metrics=_metrics(**{METRIC_FIRST_DELTA_MS: 1_500})
        )
        db.commit()

        assert row is not None
        assert row.first_delta_ms == 1_500

    def test_snapshot_is_idempotent_per_run_and_later_call_corrects_cancel(
        self, db: Session
    ) -> None:
        """worker 终态与 HTTP 取消都会调用：同一 run 只有一行，后写补正结果。"""
        run = _run(db, status=InsightStatus.CANCELLED.value)
        record_run_snapshot(db, run, metrics=_metrics(**{METRIC_CANCEL_REQUESTED: 1}))
        db.commit()
        run.status = InsightStatus.CANCELLED.value
        record_run_snapshot(
            db,
            run,
            metrics=_metrics(
                **{METRIC_CANCEL_REQUESTED: 1, METRIC_CANCEL_SUCCEEDED: 1}
            ),
        )
        db.commit()

        rows = db.scalars(select(InsightRunObservation)).all()
        assert len(rows) == 1
        assert rows[0].cancel_requested is True
        assert rows[0].cancel_succeeded is True

    def test_cancel_requested_but_run_not_cancelled_records_failure(
        self, db: Session
    ) -> None:
        """取消请求落在已终态的 run 上 = 没落地，必须在门禁里可见。"""
        run = _run(db, status=InsightStatus.COMPLETED.value)
        row = record_run_snapshot(
            db, run, metrics=_metrics(**{METRIC_CANCEL_REQUESTED: 1})
        )
        db.commit()
        assert row is not None
        assert row.cancel_requested is True
        assert row.cancel_succeeded is False

    def test_only_error_code_is_stored_never_message(self, db: Session) -> None:
        error = make_error(InsightErrorCode.UPSTREAM_TIMEOUT, SECRET_PROMPT)
        run = _run(db, status=InsightStatus.FAILED.value, error=error, duration_ms=None)
        row = record_run_snapshot(db, run)
        db.commit()

        assert row is not None
        assert row.error_code == InsightErrorCode.UPSTREAM_TIMEOUT.value
        assert row.error_retryable is True
        assert SECRET_PROMPT not in json.dumps(
            {c.name: getattr(row, c.name) for c in row.__table__.columns}, default=str
        )

    def test_retries_derive_from_attempt(self, db: Session) -> None:
        run = _run(db, attempt=3)
        row = record_run_snapshot(db, run)
        db.commit()
        assert row is not None
        assert (row.attempts, row.retries) == (3, 2)


class TestFinalize:
    def test_finalize_writes_snapshot_for_terminal_run(
        self, db, session_factory, writer: InsightStreamWriter
    ) -> None:
        run = _run(db, usage=InsightUsage(input_tokens=1, output_tokens=2, total_tokens=3))
        writer.bump_metric(run.run_id, METRIC_STREAM_FRAMES, 4)

        assert finalize_run_observation(
            run.run_id, session_factory=session_factory, writer=writer
        ) is True

        with session_factory() as check:
            row = check.scalar(
                select(InsightRunObservation).where(
                    InsightRunObservation.run_id == run.run_id
                )
            )
        assert row is not None
        assert row.stream_frames == 4
        assert row.total_tokens == 3

    def test_finalize_skips_non_terminal_run(self, db, session_factory, writer) -> None:
        run = _run(db, status=InsightStatus.GENERATING.value, duration_ms=None)
        assert (
            finalize_run_observation(
                run.run_id, session_factory=session_factory, writer=writer
            )
            is False
        )
        with session_factory() as check:
            assert check.scalars(select(InsightRunObservation)).all() == []

    def test_finalize_is_disabled_by_flag(self, db, session_factory, writer) -> None:
        run = _run(db)
        assert (
            finalize_run_observation(
                run.run_id,
                session_factory=session_factory,
                writer=writer,
                settings=_settings(insight_observation_enabled=False),
            )
            is False
        )

    def test_finalize_unknown_run_is_noop(self, session_factory, writer) -> None:
        assert (
            finalize_run_observation(
                "does-not-exist", session_factory=session_factory, writer=writer
            )
            is False
        )

    def test_finalize_survives_metric_transport_outage(self, db, session_factory) -> None:
        """Redis 挂了也要落行（指标缺省），观测是旁路、run 才是权威。"""

        class BrokenWriter:
            """读数即炸的 writer：模拟传输层整体不可用（非 redis.RedisError）。"""

            def read_metrics(self, run_id: str) -> dict[str, int]:
                raise RuntimeError(f"redis down for {run_id}")

            def stream_footprint(self, run_id: str) -> tuple[None, None]:
                raise RuntimeError(f"redis down for {run_id}")

        run = _run(db)
        assert (
            finalize_run_observation(
                run.run_id,
                session_factory=session_factory,
                writer=cast(Any, BrokenWriter()),
            )
            is True
        )
        with session_factory() as check:
            row = check.scalar(select(InsightRunObservation))
        assert row is not None and row.stream_frames == 0


class TestRecordFallback:
    def test_fallback_row_has_no_run_and_keeps_reason(self, db, session_factory) -> None:
        assert record_fallback(
            capability=FALLBACK_CAPABILITY_AI_SUMMARY,
            reason="semaphore_timeout",
            role_id="schedule_report_summary",
            session_factory=session_factory,
        )
        with session_factory() as check:
            row = check.scalar(select(InsightRunObservation))
        assert row is not None
        assert row.source == SOURCE_LEGACY_FALLBACK
        assert row.run_id is None
        assert row.fallback is True
        assert row.fallback_reason == "semaphore_timeout"

    def test_fallback_reason_is_length_capped(self, session_factory) -> None:
        record_fallback(
            capability="legacy_insight",
            reason="x" * 500,
            session_factory=session_factory,
        )
        with session_factory() as check:
            row = check.scalar(select(InsightRunObservation))
        assert row is not None and len(row.fallback_reason) == 128

    def test_fallback_disabled_flag_writes_nothing(self, session_factory) -> None:
        assert (
            record_fallback(
                capability=FALLBACK_CAPABILITY_AI_SUMMARY,
                reason="error",
                session_factory=session_factory,
                settings=_settings(insight_observation_enabled=False),
            )
            is False
        )
        with session_factory() as check:
            assert check.scalars(select(InsightRunObservation)).all() == []


# --------------------------------------------------------------------------
# 2. 聚合与门禁
# --------------------------------------------------------------------------


def _seed_completed(db: Session, **overrides: Any) -> InsightRun:
    run = _run(db, **overrides)
    record_run_snapshot(
        db,
        run,
        metrics=_metrics(
            **{
                METRIC_FIRST_DELTA_MS: overrides.get("first_delta_ms", 1_000),
                METRIC_STREAM_OPENS: overrides.get("stream_opens", 1),
                METRIC_STREAM_RECONNECTS: overrides.get("stream_reconnects", 0),
            }
        ),
    )
    db.commit()
    return run


class TestAggregation:
    def test_rates_and_percentiles_per_capability(self, db: Session) -> None:
        for tokens, duration in ((100, 1_000), (200, 2_000), (300, 9_000)):
            _seed_completed(
                db,
                usage=InsightUsage(
                    input_tokens=tokens, output_tokens=0, total_tokens=tokens
                ),
                duration_ms=duration,
            )
        _seed_completed(
            db,
            capability="ai_summary",
            usage=InsightUsage(input_tokens=1, output_tokens=0, total_tokens=1),
        )
        record_fallback(
            capability="ai_summary",
            reason="submit_failed",
            session_factory=lambda: db,
        )

        buckets = {b.capability: b for b in aggregate_observations(db)}
        insight = buckets["insight"]
        assert insight.runs == 3
        assert (insight.avg_duration_ms, insight.p95_duration_ms) == (4_000, 9_000)
        assert insight.total_tokens == 600
        assert insight.reconnect_rate == 0.0

        summary = buckets["ai_summary"]
        assert (summary.runs, summary.fallback_events) == (1, 1)
        # 分母 = canonical run + 降级事件。
        assert summary.fallback_ratio == 0.5

    def test_reconnect_and_cancel_rates(self, db: Session) -> None:
        run = _run(db, status=InsightStatus.CANCELLED.value)
        record_run_snapshot(
            db,
            run,
            metrics=_metrics(
                **{
                    METRIC_STREAM_OPENS: 4,
                    METRIC_STREAM_RECONNECTS: 1,
                    METRIC_RECONNECT_COMPLETED: 1,
                    METRIC_CANCEL_REQUESTED: 1,
                    METRIC_CANCEL_SUCCEEDED: 1,
                }
            ),
        )
        db.commit()

        bucket = aggregate_observations(db)[0]
        assert bucket.reconnect_rate == 0.25
        # 续传闭环：重连 1 次、且补到了终态帧。
        assert bucket.reconnect_completed == 1
        assert bucket.cancel_success_rate == 1.0

    def test_reconnect_without_terminal_frame_is_not_completed(self, db: Session) -> None:
        """只重连、没看到终态帧（断线又断）不算闭环 —— 计数器缺席即未完成。"""
        run = _run(db, status=InsightStatus.COMPLETED.value)
        record_run_snapshot(
            db, run, metrics=_metrics(**{METRIC_STREAM_OPENS: 2, METRIC_STREAM_RECONNECTS: 1})
        )
        db.commit()

        assert aggregate_observations(db)[0].reconnect_completed == 0

    def test_window_excludes_older_rows(self, db: Session) -> None:
        run = _seed_completed(db)
        row = db.scalar(select(InsightRunObservation))
        assert row is not None
        row.created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=30)
        db.commit()

        assert aggregate_observations(db, window_days=7) == []
        assert len(aggregate_observations(db, window_days=60)) == 1
        del run

    def test_cost_anomaly_flags_outlier_run(self, db: Session) -> None:
        for tokens in (100, 110, 120, 5_000):
            _seed_completed(
                db,
                usage=InsightUsage(
                    input_tokens=tokens, output_tokens=0, total_tokens=tokens
                ),
            )
        bucket = aggregate_observations(db)[0]
        assert len(bucket.cost_anomalies) == 1

    def test_cost_anomaly_needs_three_samples(self, db: Session) -> None:
        """样本 < 3 时中位数不稳，不判定 —— 避免单跑一次就报成本异常。"""
        for tokens in (10, 10_000):
            _seed_completed(
                db,
                usage=InsightUsage(
                    input_tokens=tokens, output_tokens=0, total_tokens=tokens
                ),
            )
        assert aggregate_observations(db)[0].cost_anomalies == []


class TestGateThresholds:
    def test_zero_thresholds_are_report_only(self, db: Session) -> None:
        _seed_completed(db, duration_ms=10 * 60_000)
        report = gate_report(db, settings=_settings())
        assert report.blocking_findings == []
        assert report.eligible_for_retirement is True

    def test_zero_fallback_threshold_is_not_judged(self, db: Session, session_factory) -> None:
        """``insight_gate_max_fallback_ratio = 0`` = 不判定：降级只报数，不成结论。

        反例回归（review）：此前 ``0.0`` 被当阈值比较，一次降级事件就把 canonical
        桶判成 blocking —— 与 config/文档写的「0 = 不判定」相反。
        """
        _seed_completed(db, capability="insight")
        record_fallback(
            capability="insight", reason="timeout", session_factory=session_factory
        )
        report = gate_report(db, settings=_settings(insight_gate_max_fallback_ratio=0.0))
        assert [b.fallback_ratio for b in report.buckets if b.capability == "insight"] == [0.5]
        assert report.blocking_findings == []
        assert report.eligible_for_retirement is True

    def test_positive_fallback_threshold_blocks(self, db: Session, session_factory) -> None:
        """配了正的下限才判定 —— 「不允许降级」用非零阈值表达，不与 0 混用。"""
        _seed_completed(db, capability="insight")
        record_fallback(
            capability="insight", reason="timeout", session_factory=session_factory
        )
        report = gate_report(db, settings=_settings(insight_gate_max_fallback_ratio=0.1))
        assert [f.code for f in report.blocking_findings] == ["fallback_observed"]
        assert report.eligible_for_retirement is False
        assert "fallback_observed:fallback_ratio=0.5" in report.retirement_reasons

    def test_duration_and_first_delta_exceeding_budget_block(self) -> None:
        from app.services.insight.observation import CapabilityMetrics

        bucket = CapabilityMetrics(
            "insight", runs=1, completed=1, max_duration_ms=301_000, max_first_delta_ms=95_000
        )
        findings = evaluate_gates(
            [bucket],
            _settings(
                insight_gate_max_duration_ms=300_000,
                insight_gate_max_first_delta_ms=90_000,
            ),
        )
        by_code = {f.code: f for f in findings}
        assert by_code["duration_exceeded"].severity == SEVERITY_BLOCKING
        assert by_code["duration_exceeded"].observed == 301_000
        assert by_code["first_delta_exceeded"].severity == SEVERITY_BLOCKING

    def test_stream_retention_is_warning_not_blocking(self) -> None:
        from app.services.insight.observation import CapabilityMetrics

        findings = evaluate_gates(
            [CapabilityMetrics("insight", runs=1, completed=1, max_stream_xlen=10_000)],
            _settings(insight_gate_max_stream_frames=10_000),
        )
        assert [f.severity for f in findings] == [SEVERITY_WARNING]

    def test_cancel_that_never_landed_blocks(self) -> None:
        from app.services.insight.observation import CapabilityMetrics

        findings = evaluate_gates(
            [
                CapabilityMetrics(
                    "insight", runs=1, completed=1, cancel_requested=1, cancel_succeeded=0
                )
            ],
            _settings(),
        )
        assert [f.code for f in findings] == ["cancel_not_landed"]
        assert findings[0].severity == SEVERITY_BLOCKING

    def test_failures_and_retries_are_informational(self) -> None:
        from app.services.insight.observation import CapabilityMetrics

        findings = evaluate_gates(
            [
                CapabilityMetrics(
                    "insight",
                    runs=3,
                    failed=1,
                    retried_runs=1,
                    error_counts={"PROVIDER_TIMEOUT": 1},
                )
            ],
            _settings(),
        )
        assert {f.severity for f in findings} == {SEVERITY_INFO}
        assert {f.code for f in findings} == {"failures_observed", "retries_observed"}

    def test_empty_window_is_not_eligible_in_report_json(self, db: Session) -> None:
        """空窗口不产生 findings，但**不是达标** —— 报告属性与 JSON 口径必须一致。

        反例回归（review）：``as_dict()['eligible_for_retirement']`` 曾只看
        ``blocking_findings``，空窗口下返回 ``true``，与 ``is_retirement_eligible()``
        相互矛盾。
        """
        report = gate_report(db, settings=_settings())
        assert report.buckets == []
        assert report.findings == []
        assert report.eligible_for_retirement is False
        payload = report.as_dict()
        assert payload["eligible_for_retirement"] is False
        assert payload["retirement_reasons"] == ["insufficient_data:insight.runs=0"]
        assert payload["blocking_count"] == 1
        assert is_retirement_eligible(report) == (False, ["insufficient_data:insight.runs=0"])


class TestRetirementEligibility:
    def test_legacy_bucket_findings_do_not_block_new_path(
        self, db: Session, session_factory
    ) -> None:
        """``ai_summary`` 桶本身就是待退役对象，它的降级不该挡住 canonical 结论。"""
        _seed_completed(db)
        record_fallback(
            capability=FALLBACK_CAPABILITY_AI_SUMMARY,
            reason="timeout",
            session_factory=session_factory,
        )
        # 正阈值让 legacy 桶确实产生一条 blocking 结论（0 = 不判定）。
        report = gate_report(
            db, settings=_settings(insight_gate_max_fallback_ratio=0.1)
        )
        assert [f.capability for f in report.blocking_findings] == ["ai_summary"]

        ok, reasons = is_retirement_eligible(report)
        assert ok is True and reasons == []
        # 指标票口径唯一：report 属性 / JSON / 判定函数三处同源，legacy 的 blocking
        # 结论只留在 findings 里做审计，不进退役口径。
        assert report.eligible_for_retirement is True
        payload = report.as_dict()
        assert payload["eligible_for_retirement"] is True
        assert payload["retirement_reasons"] == []
        assert payload["blocking_count"] == 0
        assert [f["capability"] for f in payload["findings"]] == ["ai_summary"]

    def test_canonical_findings_block_with_reasons(self, db: Session) -> None:
        _seed_completed(db, duration_ms=999_000)
        report = gate_report(
            db, settings=_settings(insight_gate_max_duration_ms=300_000)
        )
        ok, reasons = is_retirement_eligible(report)
        assert ok is False
        assert reasons == ["duration_exceeded:max_duration_ms=999000"]
        assert report.eligible_for_retirement is False

    def test_empty_window_is_not_a_pass(self, db: Session) -> None:
        """空观测窗口不能算「指标达标」——否则退役批准建立在没有证据之上。"""
        report = gate_report(db, settings=_settings())
        ok, reasons = is_retirement_eligible(report)
        assert ok is False
        assert reasons == ["insufficient_data:insight.runs=0"]

    def test_report_dict_is_json_serializable(self, db: Session) -> None:
        _seed_completed(db)
        payload = gate_report(db, settings=_settings()).as_dict()
        assert json.loads(json.dumps(payload))["buckets"][0]["capability"] == "insight"


# --------------------------------------------------------------------------
# 3. 脱敏（验收 §1：敏感 prompt / API key / 原始 slot 不入日志与指标）
# --------------------------------------------------------------------------


def _row_blob(row: InsightRunObservation) -> str:
    return json.dumps(
        {c.name: getattr(row, c.name) for c in row.__table__.columns}, default=str
    )


class TestRedaction:
    def test_secrets_never_reach_row_logs_or_metrics(
        self, db, session_factory, writer: InsightStreamWriter, caplog
    ) -> None:
        slots = json.dumps(
            {
                "report.context": {
                    "system_prompt": SECRET_PROMPT,
                    "instructions": SECRET_PROMPT,
                    "api_key": SECRET_API_KEY,
                    "base_url": "http://secret-provider.internal/v1",
                    "payload": SECRET_SLOT_BODY,
                }
            }
        )
        run = _run(
            db,
            status=InsightStatus.FAILED.value,
            error=make_error(InsightErrorCode.UPSTREAM_TIMEOUT, SECRET_PROMPT),
            slots=slots,
            duration_ms=None,
        )
        writer.bump_metric(run.run_id, METRIC_FIRST_DELTA_MS, 1_200)

        with caplog.at_level(logging.DEBUG):
            assert finalize_run_observation(
                run.run_id, session_factory=session_factory, writer=writer
            ) is True

        with session_factory() as check:
            row = check.scalar(select(InsightRunObservation))
        assert row is not None

        haystacks = {
            "observation row": _row_blob(row),
            "log records": "\n".join(
                record.getMessage() for record in caplog.records
            ),
            "redis metrics": json.dumps(
                writer.read_metrics(run.run_id), default=str, ensure_ascii=False
            ),
        }
        for label, blob in haystacks.items():
            for secret in (SECRET_PROMPT, SECRET_API_KEY, SECRET_SLOT_BODY):
                assert secret not in blob, f"{label} 泄漏了敏感值"

    def test_observation_columns_are_an_explicit_allowlist(self) -> None:
        """表结构本身就是白名单：新增列若带敏感语义，这条会失败提醒复核。"""
        allowed = {
            "id", "source", "run_id", "attempt", "capability", "role_id",
            "endpoint_id", "model_id", "status", "first_delta_ms", "duration_ms",
            "input_tokens", "output_tokens", "total_tokens", "attempts", "retries",
            "stream_opens", "stream_reconnects", "reconnect_completed",
            "stream_frames", "stream_bytes",
            "stream_xlen", "stream_memory_bytes", "cancel_requested",
            "cancel_succeeded", "error_code", "error_retryable", "fallback",
            "fallback_reason", "created_at", "updated_at",
        }
        assert {c.name for c in InsightRunObservation.__table__.columns} == allowed

    def test_forbidden_sources_cover_client_credential_keys(self) -> None:
        from app.schemas.insight import FORBIDDEN_CLIENT_KEYS, SYSTEM_PROMPT_KEYS
        from app.services.insight.observation import FORBIDDEN_SOURCES

        assert set(SYSTEM_PROMPT_KEYS) | set(FORBIDDEN_CLIENT_KEYS) <= set(
            FORBIDDEN_SOURCES
        )
        assert "slots" in FORBIDDEN_SOURCES


class TestStreamMetricPlumbing:
    def test_metric_hash_survives_and_reads_back(self, writer) -> None:
        writer.bump_metric("r1", METRIC_STREAM_OPENS)
        writer.bump_metric("r1", METRIC_STREAM_OPENS, 2)
        writer.set_metric_if_absent("r1", METRIC_FIRST_DELTA_MS, 900)
        writer.set_metric_if_absent("r1", METRIC_FIRST_DELTA_MS, 1_800)  # 首写获胜

        metrics = writer.read_metrics("r1")
        assert metrics[METRIC_STREAM_OPENS] == 3
        assert metrics[METRIC_FIRST_DELTA_MS] == 900

    def test_metrics_key_is_namespaced_and_cleared_with_run(self, writer) -> None:
        rid = uuid4()
        writer.open_run(rid, 1)
        writer.bump_metric(str(rid), METRIC_STREAM_FRAMES)
        key = stream_bus.metrics_key(str(rid))
        assert key.endswith(f"insight:metrics:{rid}")
        writer.reset_run(rid)
        assert writer.read_metrics(str(rid)) == {}
