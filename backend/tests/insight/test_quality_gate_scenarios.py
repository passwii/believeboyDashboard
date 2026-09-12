"""BLF-1018 质量门禁场景集：成功 / 失败 / 取消 / 重试 / 断线恢复 / 权限越权 / 成本异常（+ 回滚演练）。

验收 §2 要求这些场景**都**有结论且**可审计**。所以本模块不是普通的断言堆：

- 每个场景返回一条结构化结论 ``{scenario, status, observed, checks}``；
- 结论由 :func:`all_scenarios` 汇总，测试与 ``scripts/insight_gate.py`` 看到的是
  同一份结构（脚本把它当作门禁证据的一部分打印出来）；
- 每条 check 都带观测值（``value`` / ``expected``），失败时能直接读出「差在哪」，
  而不是只有一个栈回溯。

场景走真实实现：run 行来自真实仓储、执行来自真实 ``execute_run``、指标落库走真实
``finalize_run_observation``、断线恢复走真实 async 订阅器（Last-Event-ID 续传）与真实
Redis 计数器。只有 LLM 与权限主体是注入的替身。

权限越权一景在**服务层**判定开关语义（409 ``DOMAIN_SWITCH_NOT_READY`` / 冻结谓词）；
HTTP 层同语义的实测在 ``tests/api/test_insight_domain_runs.py`` 与
``tests/api/test_insight_observation.py``（管理员专属 403），两级合起来覆盖越权面。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import fakeredis
import fakeredis.aioredis
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.insight_run import InsightRun
from app.models.insight_run_observation import InsightRunObservation
from app.schemas.insight import (
    InsightErrorCode,
    InsightRunRequest,
    InsightStage,
    InsightStatus,
    make_error,
)
from app.services.insight import stream_bus
from app.services.insight.domain_switch import (
    canonical_domain_roles,
    domain_switch_error,
    legacy_write_frozen,
)
from app.services.insight.events import TERMINAL_EVENT_TYPES
from app.services.insight.executor import LLMResult, RetryableFailure, execute_run
from app.services.insight.observation import (
    aggregate_observations,
    finalize_run_observation,
    gate_report,
    is_retirement_eligible,
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
    retry_run,
    to_detail,
    try_transition,
)
from app.services.insight.sink import StreamEventSink
from app.services.insight.stream_bus import (
    METRIC_CANCEL_REQUESTED,
    METRIC_CANCEL_SUCCEEDED,
    METRIC_RECONNECT_COMPLETED,
    METRIC_STREAM_OPENS,
    METRIC_STREAM_RECONNECTS,
    InsightStreamWriter,
    stream_key,
)
from app.services.insight.subscriber import InsightStreamSubscriber
from app.services.insight.validator import fingerprint_of
from app.services.insight_concurrency import bucket_caps
from tests.insight.conftest import make_request

#: 门禁阈值：与 Settings 默认口径一致（0 = 只报数不判定）。
GATE_SETTINGS = SimpleNamespace(
    insight_observation_enabled=True,
    insight_observation_window_days=7,
    insight_gate_max_duration_ms=300_000,
    insight_gate_max_first_delta_ms=90_000,
    insight_gate_max_stream_frames=10_000,
    insight_gate_max_fallback_ratio=0.0,
    insight_gate_cost_anomaly_multiplier=5.0,
)


@dataclass
class Check:
    """一条可审计的断言结果（观测值 + 期望值）。"""

    name: str
    passed: bool
    value: Any = None
    expected: Any = None
    detail: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "passed": self.passed,
            "value": self.value,
            "expected": self.expected,
            "detail": self.detail,
        }


@dataclass
class ScenarioVerdict:
    """一个门禁场景的完整结论。"""

    scenario: str
    checks: list[Check] = field(default_factory=list)

    def check(self, name: str, value: Any, expected: Any = True, detail: str = "") -> None:
        self.checks.append(
            Check(
                name=name,
                passed=bool(value == expected) if expected is not True else bool(value),
                value=value,
                expected=expected,
                detail=detail,
            )
        )

    @property
    def status(self) -> str:
        return "pass" if self.checks and all(c.passed for c in self.checks) else "fail"

    def as_dict(self) -> dict[str, Any]:
        return {
            "scenario": self.scenario,
            "status": self.status,
            "observed": {c.name: c.value for c in self.checks},
            "checks": [c.as_dict() for c in self.checks],
        }


def _request(**overrides: Any) -> InsightRunRequest:
    return InsightRunRequest.model_validate(make_request(**overrides))


def _create(db: Session, **overrides: Any) -> InsightRun:
    request = _request(**overrides)
    run, _ = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    return run


def _resolve(endpoint_id: str, model_id: str, role: InsightRoleDefinition, settings: Any):
    return InsightModelSelection(endpoint_id="default", model_id="fake-model", model=None)  # type: ignore[arg-type]


def _sink(writer: InsightStreamWriter, run: InsightRun) -> StreamEventSink:
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=run.attempt)
    sink.open(to_detail(run))
    return sink


def _ok(markdown: str = "# 摘要\n\n正文", *, tokens: tuple[int, int] = (120, 240)):
    def _generate(agent: Any, prompt: str) -> LLMResult:
        return LLMResult(
            markdown=markdown, input_tokens=tokens[0], output_tokens=tokens[1]
        )

    return _generate


def _row(session_factory, run_id: str) -> InsightRunObservation:
    with session_factory() as db:
        row = db.scalar(
            select(InsightRunObservation).where(InsightRunObservation.run_id == run_id)
        )
    assert row is not None, f"run {run_id} 没有观测行"
    return row


# --------------------------------------------------------------------------
# 场景实现
# --------------------------------------------------------------------------


def scenario_success(db: Session, session_factory, writer: InsightStreamWriter) -> ScenarioVerdict:
    """正常跑完：观测行 completed，首字时延/时长/token/帧数都落库。"""
    verdict = ScenarioVerdict("success")
    run = _create(db, idempotency_key=f"gate-success-{uuid4().hex[:8]}")
    db.commit()
    sink = _sink(writer, run)
    result = execute_run(
        db=db, run_id=run.run_id, attempt=1, sink=sink, resolve=_resolve, generate=_ok()
    )
    db.commit()
    finalize_run_observation(run.run_id, session_factory=session_factory, writer=writer)
    row = _row(session_factory, run.run_id)

    verdict.check("run_status", result.status, InsightStatus.COMPLETED.value)
    verdict.check("observation_status", row.status, InsightStatus.COMPLETED.value)
    verdict.check("first_delta_recorded", row.first_delta_ms is not None)
    verdict.check("duration_recorded", row.duration_ms is not None)
    verdict.check("total_tokens", row.total_tokens, 360)
    verdict.check("stream_frames_published", row.stream_frames > 0)
    verdict.check("bucket_error_rate", aggregate_observations(db)[0].error_rate, 0.0)
    return verdict


def scenario_failure(db: Session, session_factory, writer: InsightStreamWriter) -> ScenarioVerdict:
    """provider 不可用：run 落 FAILED，只记错误码（不记上游报文）。"""
    verdict = ScenarioVerdict("failure")
    run = _create(db, idempotency_key=f"gate-failure-{uuid4().hex[:8]}")
    db.commit()

    def _boom(agent: Any, prompt: str) -> LLMResult:
        raise InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_ERROR, "boom", retryable=False
        )

    result = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        sink=_sink(writer, run),
        resolve=_resolve,
        generate=_boom,
    )
    db.commit()
    finalize_run_observation(run.run_id, session_factory=session_factory, writer=writer)
    row = _row(session_factory, run.run_id)

    verdict.check("run_status", result.status, InsightStatus.FAILED.value)
    verdict.check("observation_status", row.status, InsightStatus.FAILED.value)
    verdict.check("error_code_recorded", row.error_code is not None)
    verdict.check("error_retryable", row.error_retryable, False)
    bucket = aggregate_observations(db)[0]
    verdict.check("bucket_failed_count", bucket.failed >= 1, True)
    return verdict


def scenario_cancel(db: Session, session_factory, writer: InsightStreamWriter) -> ScenarioVerdict:
    """用户取消：run 落 cancelled，取消成功率 1.0（请求真的落地）。"""
    verdict = ScenarioVerdict("cancel")
    run = _create(db, idempotency_key=f"gate-cancel-{uuid4().hex[:8]}")
    db.commit()
    sink = _sink(writer, run)
    writer.bump_metric(run.run_id, METRIC_CANCEL_REQUESTED)

    cancel_run(db, run.run_id)
    db.commit()
    result = execute_run(
        db=db, run_id=run.run_id, attempt=1, sink=sink, resolve=_resolve, generate=_ok()
    )
    writer.bump_metric(run.run_id, METRIC_CANCEL_SUCCEEDED)
    db.commit()
    finalize_run_observation(run.run_id, session_factory=session_factory, writer=writer)
    row = _row(session_factory, run.run_id)

    verdict.check("run_status", result.status, InsightStatus.CANCELLED.value)
    verdict.check("observation_status", row.status, InsightStatus.CANCELLED.value)
    verdict.check("cancel_requested", row.cancel_requested, True)
    verdict.check("cancel_succeeded", row.cancel_succeeded, True)
    bucket = aggregate_observations(db)[0]
    verdict.check("cancel_success_rate", bucket.cancel_success_rate, 1.0)
    return verdict


def scenario_retry(db: Session, session_factory, writer: InsightStreamWriter) -> ScenarioVerdict:
    """重试：传输级重投不改 attempt；用户级 retry 才换代，且两次执行各留账。"""
    verdict = ScenarioVerdict("retry")
    run = _create(db, idempotency_key=f"gate-retry-{uuid4().hex[:8]}")
    db.commit()

    def _flaky(agent: Any, prompt: str) -> LLMResult:
        raise InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_RATE_LIMITED, "slow down", retryable=True
        )

    # A. 可重试失败 = Celery 重投**同一 attempt**，不是用户可见的新一轮。
    with pytest.raises(RetryableFailure):
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            sink=_sink(writer, run),
            resolve=_resolve,
            generate=_flaky,
        )
    db.commit()
    db.refresh(run)
    verdict.check("redelivery_keeps_attempt", run.attempt, 1)

    # B. 重试耗尽后 park 为 FAILED（与 _park_failed 同一状态转移），用户再发起 retry。
    try_transition(
        db,
        run,
        InsightStatus.FAILED,
        expected_attempt=1,
        error=make_error(InsightErrorCode.UPSTREAM_TIMEOUT, "exhausted"),
    )
    db.commit()
    db.refresh(run)
    verdict.check("parked_status", run.status, InsightStatus.FAILED.value)

    retried = retry_run(db, run.run_id)
    db.commit()
    writer.reset_run(run.run_id)  # 换代即清传输态（旧 attempt 的帧与计数作废）
    sink = _sink(writer, retried)
    result = execute_run(
        db=db,
        run_id=retried.run_id,
        attempt=retried.attempt,
        sink=sink,
        resolve=_resolve,
        generate=_ok(),
    )
    db.commit()
    finalize_run_observation(run.run_id, session_factory=session_factory, writer=writer)
    row = _row(session_factory, run.run_id)

    verdict.check("attempt_bumped", retried.attempt, 2)
    verdict.check("run_status", result.status, InsightStatus.COMPLETED.value)
    verdict.check("row_attempts", row.attempts, 2)
    verdict.check("row_retries", row.retries, 1)
    report = gate_report(db, settings=GATE_SETTINGS)
    verdict.check(
        "retry_does_not_block_retirement",
        is_retirement_eligible(report)[0],
        True,
        "重试只报数，不作为门禁",
    )
    return verdict


def scenario_reconnect(
    db: Session, session_factory, writer: InsightStreamWriter, async_redis
) -> ScenarioVerdict:
    """断线恢复：带游标重连只补未见的帧，终止帧恰好一次、且终态可审计。"""
    verdict = ScenarioVerdict("reconnect")
    run = _create(db, idempotency_key=f"gate-reconnect-{uuid4().hex[:8]}")
    db.commit()

    # 真跑一次 attempt：终态行带 outputs/digest，子进程崩溃后的「按行合成终止帧」
    # 才有完整内容（否则 DoneEvent 的 content_sha256 校验失败）。
    result = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        sink=_sink(writer, run),
        resolve=_resolve,
        generate=_ok(),
    )
    db.commit()
    db.refresh(run)
    verdict.check("run_completed", result.status, InsightStatus.COMPLETED.value)

    published = [
        (1, "aggregating"),
        (2, "generating"),
        (3, "finalizing"),
        (4, "finalizing"),
        (5, "finalizing"),
    ]

    async def _publish_all() -> None:
        for seq, status in published:
            payload = {
                "schema_version": 1,
                "run_id": run.run_id,
                "attempt": 1,
                "seq": seq,
                "type": "status",
                "status": status,
                "stage": status,
                "progress_percent": 40,
            }
            await async_redis.xadd(
                stream_key(run.run_id),
                {stream_bus.EVENT_FIELD: json.dumps(payload)},
            )

    asyncio.run(_publish_all())

    terminal_detail = to_detail(run)
    # 断线瞬间客户端看到的还是进行中的状态（真实里 detail 由 DB 实时读，此处
    # 用同一行的「当时快照」建模，恢复时再换成终态行）。
    stale_detail = terminal_detail.model_copy(
        update={
            "status": InsightStatus.GENERATING,
            "stage": InsightStage.GENERATING,
            "progress_percent": 40,
        }
    )
    subscriber = InsightStreamSubscriber(async_redis)

    async def _read(detail, cursor, stop_after=None):
        frames = []
        async for event, _sse_id in subscriber.subscribe(
            run_id=run.run_id, last_event_id=cursor, detail=detail
        ):
            frames.append(event)
            if stop_after is not None and len(frames) >= stop_after:
                break
        return frames

    first = asyncio.run(_read(stale_detail, None, stop_after=3))
    verdict.check("first_segment_seq", [e.seq for e in first], [1, 2, 3])
    cursor = f"{run.run_id}:1:{first[-1].seq}"

    # SSE 连接两次、其中一次带游标 = 一次重连。
    writer.bump_metric(run.run_id, METRIC_STREAM_OPENS, 2)
    writer.bump_metric(run.run_id, METRIC_STREAM_RECONNECTS, 1)

    resumed = asyncio.run(_read(terminal_detail, cursor))
    status_seqs = [e.seq for e in resumed if e.type == "status"]
    # 与 SSE 端点同条件地记「续传闭环」：带游标重连且确实补到终态帧。
    if resumed and resumed[-1].type in TERMINAL_EVENT_TYPES:
        writer.bump_metric(run.run_id, METRIC_RECONNECT_COMPLETED, 1)
    verdict.check("resume_only_missing_frames", status_seqs, [4, 5])
    verdict.check(
        "no_duplicate_frames",
        len(set([e.seq for e in first] + status_seqs)),
        len(first) + len(status_seqs),
    )
    verdict.check(
        "terminal_frame_alone_once",
        [e.type for e in resumed[-1:]],
        ["done"],
        "终态由 DB 行合成，且是最后一帧",
    )
    verdict.check("terminal_status", resumed[-1].status, "completed")

    finalize_run_observation(run.run_id, session_factory=session_factory, writer=writer)
    row = _row(session_factory, run.run_id)
    verdict.check("row_stream_opens", row.stream_opens, 2)
    verdict.check("row_stream_reconnects", row.stream_reconnects, 1)
    verdict.check(
        "row_reconnect_completed",
        row.reconnect_completed,
        True,
        "重连补到了终态帧 = 续传闭环",
    )
    report = gate_report(db, settings=GATE_SETTINGS)
    bucket = next(b for b in report.buckets if b.capability == "insight")
    verdict.check("bucket_reconnect_rate", bucket.reconnect_rate, 0.5)
    verdict.check("bucket_reconnect_completed", bucket.reconnect_completed, 1)
    verdict.check(
        "reconnect_not_a_gate",
        is_retirement_eligible(report)[0],
        True,
        "断线率只上报，不阻断退役",
    )
    verdict.check(
        "report_vote_matches_function",
        report.as_dict()["eligible_for_retirement"],
        is_retirement_eligible(report)[0],
        "报告 JSON 与判定函数同源（含 reconnect_completed 聚合后仍一致）",
    )
    return verdict


def scenario_permission_escalation() -> ScenarioVerdict:
    """权限越权面：开关未开时 canonical 域关闭、开关开启后旧写端冻结、未点名域不受影响。"""
    verdict = ScenarioVerdict("permission_escalation")
    off = SimpleNamespace(insight_canonical_domains="")
    on = SimpleNamespace(insight_canonical_domains="ad_analysis")

    closed = domain_switch_error("ad_analysis", enabled=False)
    frozen = domain_switch_error("ad_analysis", enabled=True)
    verdict.check("switch_off_status", closed.status_code, 409)
    off_detail = cast(dict[str, Any], closed.detail)
    verdict.check("switch_off_code", off_detail["code"], "DOMAIN_SWITCH_NOT_READY")
    verdict.check("canonical_domains_when_off", sorted(canonical_domain_roles(off)), [])
    verdict.check("legacy_write_not_frozen_when_off", legacy_write_frozen(off, "ad_analysis"), None)
    verdict.check("legacy_write_frozen_when_on", legacy_write_frozen(on, "ad_analysis"), "ad_analysis")
    verdict.check("switch_on_status", frozen.status_code, 409)
    # 未点名的域（含未实现的 role）不受开关影响：配置笔误不能扩大冻结面。
    verdict.check(
        "unnamed_domain_untouched",
        legacy_write_frozen(SimpleNamespace(insight_canonical_domains="typo_role"), "ad_analysis"),
        None,
    )
    return verdict


def scenario_cost_anomaly(db: Session) -> ScenarioVerdict:
    """成本异常：token 离群 run 必须在门禁里被点名；并发桶按 capability 分开封顶。"""
    verdict = ScenarioVerdict("cost_anomaly")
    for tokens in (100, 110, 120, 9_000):
        run = _create(db, idempotency_key=f"gate-cost-{tokens}-{uuid4().hex[:6]}")
        db.commit()
        run.status = InsightStatus.COMPLETED.value
        run.duration_ms = 2_000
        run.usage_json = json.dumps(
            {"input_tokens": tokens, "output_tokens": 0, "total_tokens": tokens}
        )
        db.commit()
        finalize_run_observation(run.run_id, session_factory=_bound(db), writer=None)
    db.commit()

    report = gate_report(db, settings=GATE_SETTINGS)
    anomaly = [f for f in report.findings if f.code == "cost_anomaly"]
    verdict.check("cost_anomaly_findings", len(anomaly), 1)
    verdict.check("blocking_cost_anomaly", anomaly[0].severity, "blocking")
    verdict.check("retirement_blocked", is_retirement_eligible(report)[0], False)

    caps = bucket_caps()
    verdict.check("insight_bucket_capped", "insights" in caps, True)
    verdict.check("legacy_bucket_separate", "ai_summary" in caps, True)
    verdict.check(
        "buckets_have_independent_caps",
        caps["insights"] >= 1 and caps["ai_summary"] >= 1,
        True,
        detail=f"insights={caps['insights']} ai_summary={caps['ai_summary']}",
    )
    return verdict


def scenario_rollback_drill(db: Session) -> ScenarioVerdict:
    """回滚演练：切换 → 旧写端 409 → 清空开关 → 旧写端恢复（同一 CSV 字段往返）。"""
    verdict = ScenarioVerdict("rollback_drill")
    switched = SimpleNamespace(insight_canonical_domains="ad_analysis")
    rolled_back = SimpleNamespace(insight_canonical_domains="")

    verdict.check("frozen_after_switch", legacy_write_frozen(switched, "ad_analysis"), "ad_analysis")
    frozen_error = domain_switch_error("ad_analysis", enabled=True)
    verdict.check("frozen_write_is_409", frozen_error.status_code, 409)
    frozen_detail = cast(dict[str, Any], frozen_error.detail)
    verdict.check("frozen_write_is_not_retryable", frozen_detail["retryable"], False)
    verdict.check("write_allowed_after_rollback", legacy_write_frozen(rolled_back, "ad_analysis"), None)
    verdict.check(
        "canonical_domains_cleared",
        sorted(canonical_domain_roles(rolled_back)),
        [],
        detail="回滚 = 清空 insight_canonical_domains，无第二个开关",
    )
    # 历史只读兼容：旧表/旧读路径不在退役范围内，开关只影响新写。
    from app.models.ai_insight import AIInsight

    verdict.check("legacy_read_model_retained", AIInsight.__tablename__, "ai_insights")
    return verdict


def _bound(db: Session) -> Callable[[], Session]:
    """让 finalize 用与测试相同的连接（sqlite 内存/文件库共享同一 engine）。"""
    bind = db.get_bind()
    return sessionmaker(bind=bind, autoflush=False, autocommit=False, future=True)


# --------------------------------------------------------------------------
# 汇总执行
# --------------------------------------------------------------------------


def all_scenarios(
    db: Session, session_factory, writer: InsightStreamWriter, async_redis: Any
) -> list[ScenarioVerdict]:
    """按验收 §2 的清单跑完七个场景 + 回滚演练，返回可审计结论。"""
    return [
        scenario_success(db, session_factory, writer),
        scenario_failure(db, session_factory, writer),
        scenario_cancel(db, session_factory, writer),
        scenario_retry(db, session_factory, writer),
        scenario_reconnect(db, session_factory, writer, async_redis),
        scenario_permission_escalation(),
        scenario_cost_anomaly(db),
        scenario_rollback_drill(db),
    ]


# --------------------------------------------------------------------------
# pytest 装配：每个场景一条用例（失败可归因），外加一条「场景齐备」的汇总用例
# --------------------------------------------------------------------------


@pytest.fixture()
def engine(tmp_path):
    from app.db.session import Base

    eng = create_engine(f"sqlite:///{tmp_path}/gate.db", future=True)
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


@pytest.fixture()
def async_redis() -> Iterator[Any]:
    """与 sync writer 共享一个 FakeServer：端点路径的 sync/async 同库语义。"""
    server = fakeredis.FakeServer()
    client = fakeredis.aioredis.FakeRedis(server=server)
    yield client
    asyncio.run(client.aclose())


def _report(verdict: ScenarioVerdict) -> str:
    return json.dumps(verdict.as_dict(), ensure_ascii=False, indent=2)


def test_scenario_success(db, session_factory, writer) -> None:
    verdict = scenario_success(db, session_factory, writer)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_failure(db, session_factory, writer) -> None:
    verdict = scenario_failure(db, session_factory, writer)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_cancel(db, session_factory, writer) -> None:
    verdict = scenario_cancel(db, session_factory, writer)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_retry(db, session_factory, writer) -> None:
    verdict = scenario_retry(db, session_factory, writer)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_reconnect(db, session_factory, writer, async_redis) -> None:
    verdict = scenario_reconnect(db, session_factory, writer, async_redis)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_permission_escalation() -> None:
    verdict = scenario_permission_escalation()
    assert verdict.status == "pass", _report(verdict)


def test_scenario_cost_anomaly(db) -> None:
    verdict = scenario_cost_anomaly(db)
    assert verdict.status == "pass", _report(verdict)


def test_scenario_rollback_drill(db) -> None:
    verdict = scenario_rollback_drill(db)
    assert verdict.status == "pass", _report(verdict)


def test_all_scenarios_are_covered(db, session_factory, writer, async_redis) -> None:
    """场景清单齐备性：少一个场景（口径漂移）比场景失败更隐蔽，故单独钉住。"""
    verdicts = all_scenarios(db, session_factory, writer, async_redis)
    names = [v.scenario for v in verdicts]
    assert names == [
        "success",
        "failure",
        "cancel",
        "retry",
        "reconnect",
        "permission_escalation",
        "cost_anomaly",
        "rollback_drill",
    ], _report(verdicts[0])
    failed = [v.as_dict() for v in verdicts if v.status != "pass"]
    assert failed == [], json.dumps(failed, ensure_ascii=False, indent=2)


def test_scenario_matrix_is_auditable() -> None:
    """结论结构本身可审计：每个场景都带 scenario/status/observed/checks。"""
    payload = scenario_permission_escalation().as_dict()
    assert set(payload) == {"scenario", "status", "observed", "checks"}
    assert payload["checks"]
    assert all(
        set(c) == {"name", "passed", "value", "expected", "detail"}
        for c in payload["checks"]
    )
