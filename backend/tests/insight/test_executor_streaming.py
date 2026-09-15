"""BLF-1071: 执行器真流式 delta —— 多帧有序输出、中途失败、终态语义。

验收要点（对应 issue §验收）：
1. 同一 run 产出**多帧**有序 ``content.delta``（id/seq 严格递增），且所有
   delta 拼接 == 终稿 Markdown（与 ``done.outputs[slot].content_sha256`` 一致）；
2. 中途失败 → 可分类 retry，且不出现「重复正文」「截断正文」「终态帧重发」；
3. 「不按 token 写 DB」保持不变：终态前 run 行不落正文；
4. 观测口径：``first_delta_ms`` 变真首字时延、``stream_frames`` 显著上升。

这些用例走**真实链路**：真实 ``StreamEventSink`` + fakeredis（帧、seq、
终态一次）、真实 ``execute_run``、真实 run 仓储。只有 LLM 流与模型解析是替身。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterator
from typing import Any

import fakeredis
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.schemas.insight import (
    InsightErrorCode,
    InsightRunRequest,
    InsightStatus,
)
from app.services.insight.executor import (
    ListEventSink,
    LLMResult,
    RetryableFailure,
    execute_run,
    is_retryable,
)
from app.services.insight.provider import (
    InsightProviderError,
    InsightProviderErrorCode,
)
from app.services.insight.roles import InsightRoleDefinition
from app.services.insight.runs import (
    cancel_run,
    create_run,
    get_run,
    retry_run,
    to_detail,
)
from app.services.insight.sink import StreamEventSink
from app.services.insight.stream_bus import (
    METRIC_FIRST_DELTA_MS,
    METRIC_STREAM_FRAMES,
    InsightStreamWriter,
    stream_key,
)
from app.services.insight.validator import fingerprint_of
from tests.insight.conftest import make_request

# ---------------------------------------------------------------------------
# 替身：provider 文本流（满足 executor.StreamedGeneration 协议）
# ---------------------------------------------------------------------------


class FakeStream:
    """Deterministic stand-in for ``provider.InsightTextStream``.

    ``items`` 里的字符串是 delta；``BaseException`` 实例在轮到它时抛出
    （模拟「中途失败」）。自然耗尽才算 ``finished``，与生产实现同一口径。
    """

    def __init__(
        self,
        items: list[Any],
        *,
        state: str | None = "complete",
        usage: tuple[int, int] = (7, 9),
    ) -> None:
        self._items = list(items)
        self._state = state
        self._usage = usage
        self._finished = False
        self.closed = False

    def __aiter__(self) -> FakeStream:
        return self

    async def __anext__(self) -> str:
        if not self._items:
            self._finished = True
            raise StopAsyncIteration
        item = self._items.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item

    async def aclose(self) -> None:
        self.closed = True

    @property
    def finished(self) -> bool:
        return self._finished

    @property
    def state(self) -> str | None:
        return self._state

    @property
    def truncated(self) -> bool:
        return self._state in ("incomplete", "interrupted")

    @property
    def usage_tokens(self) -> tuple[int, int]:
        return self._usage if self._finished else (0, 0)


def _stream_of(items: list[Any], **kwargs: Any):
    def _factory(_agent: Any, _prompt: str) -> FakeStream:
        return FakeStream(items, **kwargs)

    return _factory


# ---------------------------------------------------------------------------
# fixtures / helpers
# ---------------------------------------------------------------------------


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


@pytest.fixture()
def redis_engine(tmp_path):
    """File DB, so a second session sees only *committed* rows (like Postgres).

    终态前不落正文的断言需要一个**独立**连接去看 worker 已提交的事务——
    sqlite 内存库的共享连接会让这种观察失真。
    """

    from app.db.session import Base

    engine = create_engine(f"sqlite:///{tmp_path}/streaming.db", future=True)
    Base.metadata.create_all(engine)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.fixture()
def fake_redis() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis()


def _session(engine) -> Session:
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)()


def _resolve(endpoint_id: str, model_id: str, role: InsightRoleDefinition, settings: Any):
    from app.services.insight.provider import InsightModelSelection

    return InsightModelSelection(endpoint_id="default", model_id="fake-model", model=None)  # type: ignore[arg-type]


def _create(db: Session, **overrides: Any):
    request = InsightRunRequest.model_validate(make_request(**overrides))
    run, _ = create_run(
        db,
        request=request,
        fingerprint=fingerprint_of(request),
        endpoint_id="default",
        model_id="fake-model",
    )
    return run


def _frames(fake_redis: fakeredis.FakeRedis, run_id: str) -> list[dict]:
    entries = fake_redis.xrange(stream_key(run_id))  # type: ignore[union-attr]
    return [json.loads(fields[b"event"].decode()) for _eid, fields in entries]  # type: ignore[index]


def _typed(fake_redis: fakeredis.FakeRedis, run_id: str, kind: str) -> list[dict]:
    return [frame for frame in _frames(fake_redis, run_id) if frame["type"] == kind]


# ---------------------------------------------------------------------------
# 验收 §1：多帧 + 有序 + 拼接等于终稿
# ---------------------------------------------------------------------------


def test_run_emits_many_ordered_delta_frames(db: Session, fake_redis) -> None:
    """同一 run 产出多帧 content.delta，seq 严格递增，拼接 == 终稿。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    pieces = ["## 本周摘要\n\n", "- 销量环比 ", "-10%\n", "- 退货率 2.1%"]
    out = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_stream_of(list(pieces), usage=(120, 240)),
    )

    assert out.status == InsightStatus.COMPLETED.value
    deltas = _typed(fake_redis, run.run_id, "content.delta")
    # 验收 §1：真流式 = 多帧（不是以前的一帧整段）。
    assert len(deltas) == len(pieces)
    assert [frame["delta"] for frame in deltas] == pieces

    # 同一 attempt 内 seq 严格递增，且 id 即 canonical {run_id}:{attempt}:{seq}。
    all_frames = _frames(fake_redis, run.run_id)
    seqs = [frame["seq"] for frame in all_frames]
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert all(frame["attempt"] == 1 for frame in all_frames)

    # 拼接 == 终稿，且终稿 sha256 就是 done 里的摘要。
    #
    # 口径说明：delta 是 provider 的**原始**分片，终稿是 cleaner 的产物。
    # 本用例的输入对 cleaner 稳定（无可剥离元信息、无首尾空白），所以严格相等；
    # cleaner 真的改写字节时由下面的权威 content.snapshot 帧拉齐（见下一用例）。
    joined = "".join(frame["delta"] for frame in deltas)
    detail = to_detail(out)
    final = detail.outputs["main"].content
    assert joined == final
    done = _typed(fake_redis, run.run_id, "done")[-1]
    assert done["content_sha256"] == hashlib.sha256(final.encode()).hexdigest()
    assert done["outputs"]["main"]["content"] == final


def test_streamed_run_persists_usage_once_and_publishes_authoritative_snapshot(
    db: Session, fake_redis
) -> None:
    """流式 run 的 usage 仍以完整终稿为准，并补一帧权威 content.snapshot。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_stream_of(["正文", "（字数：120字）"], usage=(11, 22)),
    )

    detail = to_detail(run)
    assert detail.usage is not None
    assert (detail.usage.input_tokens, detail.usage.output_tokens) == (11, 22)

    # 清洗器会去掉「（字数：N字）」这类元信息污染：delta 是原始 provider 分片，
    # 权威帧是清洗后的终稿——两者刻意不同，客户端以权威帧为准。
    deltas = _typed(fake_redis, run.run_id, "content.delta")
    joined = "".join(frame["delta"] for frame in deltas)
    assert "（字数：120字）" in joined
    assert detail.outputs["main"].content == "正文"
    # cleaner 改写了字节：原始分片拼接 ≠ 终稿（这正是需要权威帧的原因）。
    assert joined != detail.outputs["main"].content

    snapshots = _typed(fake_redis, run.run_id, "content.snapshot")
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert snapshot["slot"] == "main"
    assert snapshot["content"] == "正文"
    assert snapshot["content_sha256"] == detail.outputs["main"].content_sha256
    # checkpoint_seq 指向它取代的最后一帧 delta（续传可跳过该前缀）。
    assert snapshot["checkpoint_seq"] == deltas[-1]["seq"]
    assert snapshot["seq"] > snapshot["checkpoint_seq"]


def test_stream_frames_metric_counts_real_typewriter_frames(
    db: Session, fake_redis
) -> None:
    """观测口径：stream_frames 随真 delta 上升，first_delta_ms 被记录。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_stream_of(["a", "b", "c", "d", "e"]),
    )

    metrics = writer.read_metrics(run.run_id)
    # 5 帧 delta + snapshot/status/terminal 帧 —— 真流式下帧数远高于旧的 1 帧。
    assert metrics[METRIC_STREAM_FRAMES] >= 5
    assert METRIC_FIRST_DELTA_MS in metrics
    assert metrics[METRIC_FIRST_DELTA_MS] >= 0


# ---------------------------------------------------------------------------
# 验收 §2：中途失败 —— 可分类 retry，无截断/重复正文，无终态帧
# ---------------------------------------------------------------------------


def test_mid_stream_retryable_error_retries_without_terminal_frame(
    db: Session, fake_redis
) -> None:
    """provider 中途抛错（可重试）→ RetryableFailure，且不发终态帧。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    boom = InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_RATE_LIMITED,
        "rate limited",
        retryable=True,
        retry_after=5,
    )
    with pytest.raises(RetryableFailure) as exc:
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            resolve=_resolve,
            sink=sink,
            stream_generate=_stream_of(["## 摘要\n", "半截正文", boom]),
        )

    assert exc.value.error.code == InsightErrorCode.RATE_LIMITED
    assert exc.value.retry_after == 5
    assert is_retryable(exc.value.error)

    # 已发出的 delta 不污染终态：没有 done/error，run 仍可恢复。
    assert _typed(fake_redis, run.run_id, "done") == []
    assert _typed(fake_redis, run.run_id, "error") == []
    assert to_detail(run).status == InsightStatus.GENERATING
    # 半截正文没有落库（既不是终态也不是 content_markdown）。
    assert to_detail(run).outputs == {}
    assert run.content_markdown is None


def test_mid_stream_non_retryable_error_goes_terminal_without_partial_content(
    db: Session, fake_redis
) -> None:
    """不可重试的中途失败 → FAILED，且绝不把半截正文当终稿。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    denied = InsightProviderError(
        InsightProviderErrorCode.MODEL_NOT_ALLOWED, "not allowed", retryable=False
    )
    out = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_stream_of(["## 摘要\n", "半截", denied]),
    )

    assert out.status == InsightStatus.FAILED.value
    detail = to_detail(out)
    assert detail.error is not None
    assert detail.error.code == InsightErrorCode.MODEL_NOT_ALLOWED
    assert out.content_markdown is None
    assert out.outputs_json is None
    errors = _typed(fake_redis, run.run_id, "error")
    assert len(errors) == 1
    assert errors[0]["status"] == "failed"


def test_retry_after_mid_stream_failure_has_no_duplicated_or_truncated_content(
    db: Session, fake_redis
) -> None:
    """重投续跑：终稿恰好一份，不出现重复正文/截断正文/终态帧重发。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    attempt_one = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    attempt_one.open(to_detail(run))

    boom = InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_TIMEOUT, "timed out", retryable=True
    )
    with pytest.raises(RetryableFailure):
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            resolve=_resolve,
            sink=attempt_one,
            stream_generate=_stream_of(["## 旧\n", "半截", boom]),
        )
    # worker 重投同一个 attempt（Celery acks_late）。
    db.rollback()

    retry_sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    retry_sink.open(to_detail(run))
    out = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=retry_sink,
        stream_generate=_stream_of(["## 新摘要\n", "完整正文\n"], usage=(3, 4)),
    )

    assert out.status == InsightStatus.COMPLETED.value
    final = to_detail(out).outputs["main"].content
    assert final == "## 新摘要\n完整正文"

    # 终态帧恰好一次（terminal marker 挡住重投的第二次）。
    assert len(_typed(fake_redis, run.run_id, "done")) == 1
    assert _typed(fake_redis, run.run_id, "error") == []

    # 两轮投递各自的 delta 都在流里；重投不重置 seq，所以整条链唯一且递增。
    deltas = _typed(fake_redis, run.run_id, "content.delta")
    seqs = [frame["seq"] for frame in deltas]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)

    # 权威 content.snapshot 划出"本次投递生效的正文"：它的 content 就是终稿
    # （第一轮尝试的半截正文 "## 旧\n半截" 从未被当作终稿），checkpoint_seq
    # 之前的 delta 是重投前那一轮的（已被快照取代）。
    snapshot = _typed(fake_redis, run.run_id, "content.snapshot")[-1]
    assert snapshot["content"] == final
    stale = [f for f in deltas if f["seq"] <= snapshot["checkpoint_seq"]]
    assert any("## 旧" in f["delta"] for f in stale), "第一轮 delta 应保留在流里"
    # 终稿里不包含第一轮的半截正文（无重复、无拼接污染）。
    assert "## 旧" not in final
    # 快照之后没有剩余的 delta：它已经是最后一帧 delta 的权威替代。
    assert [f for f in deltas if f["seq"] > snapshot["checkpoint_seq"]] == []


def test_new_attempt_frames_never_mix_with_old_attempt(
    db: Session, fake_redis
) -> None:
    """用户级 retry 换代：新 attempt 的帧 / seq 与旧 attempt 完全隔离。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    attempt_one = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    attempt_one.open(to_detail(run))

    boom = InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_ERROR, "boom", retryable=True
    )
    with pytest.raises(RetryableFailure):
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            resolve=_resolve,
            sink=attempt_one,
            stream_generate=_stream_of(["## 旧 attempt\n", boom]),
        )

    # 重试耗尽 → park failed，用户再显式 retry（attempt=2，清传输态）。
    from app.services.insight.runs import try_transition

    assert (
        try_transition(
            db,
            run,
            InsightStatus.FAILED,
            expected_attempt=1,
            error=_make_error(InsightErrorCode.UPSTREAM_TIMEOUT, "exhausted"),
        )
        is True
    )
    db.commit()
    retried = retry_run(db, run.run_id)
    writer.reset_run(run.run_id)

    attempt_two = StreamEventSink(writer=writer, run_id=run.run_id, attempt=2)
    attempt_two.open(to_detail(retried))
    out = execute_run(
        db=db,
        run_id=retried.run_id,
        attempt=2,
        resolve=_resolve,
        sink=attempt_two,
        stream_generate=_stream_of(["## 新正文\n", "完整"], usage=(1, 2)),
    )

    assert out.attempt == 2
    frames = _frames(fake_redis, run.run_id)
    assert {frame["attempt"] for frame in frames} == {2}
    deltas = [f for f in frames if f["type"] == "content.delta"]
    assert "".join(f["delta"] for f in deltas) == "## 新正文\n完整"
    assert [f["seq"] for f in deltas] == sorted(f["seq"] for f in deltas)


# ---------------------------------------------------------------------------
# 验收 §3：终态前不落正文（绝无 per-token DB 写）
# ---------------------------------------------------------------------------


def test_no_content_persisted_before_terminal_state(redis_engine) -> None:
    """流式消费期间（终态之前）run 行绝不出现正文——独立连接实测。"""
    worker = _session(redis_engine)
    observer = _session(redis_engine)
    run = _create(worker)
    worker.commit()
    run_id = run.run_id

    seen: list[tuple[str, str | None, str | None]] = []

    def _probe(_chunk: str) -> None:
        """每个 delta 到达时，用独立连接读一次已提交的行。"""
        observer.expire_all()
        row = get_run(observer, run_id)
        seen.append((row.status, row.content_markdown, row.outputs_json))

    class _ProbingStream(FakeStream):
        def __init__(self) -> None:
            super().__init__(["## 一\n", "二\n", "三\n"])
            self._tick = 0

        async def __anext__(self) -> str:
            chunk = await super().__anext__()
            self._tick += 1
            if self._tick <= 3:
                _probe(chunk)
            return chunk

    def _factory(_agent: Any, _prompt: str) -> _ProbingStream:
        return _ProbingStream()

    out = execute_run(
        db=worker,
        run_id=run_id,
        attempt=1,
        resolve=_resolve,
        stream_generate=_factory,
    )
    worker.commit()

    assert out.status == InsightStatus.COMPLETED.value
    # 流中每帧到达时，行都还没有正文。
    assert len(seen) == 3
    for status, content, outputs in seen:
        assert content is None, f"流中已落正文（status={status}）"
        assert outputs is None, f"流中已落 outputs（status={status}）"
    # 终态才落一次。
    assert out.content_markdown == "## 一\n二\n三"
    assert out.outputs_json is not None

    worker.close()
    observer.close()


# ---------------------------------------------------------------------------
# 边界：空产出 / 非字符串 chunk / provider 提前关闭 / 取消
# ---------------------------------------------------------------------------


def test_truncated_provider_stream_is_retryable(db: Session) -> None:
    """provider 提前关闭（未发终止事件）→ 可重试，绝不把半截正文当终稿。"""
    run = _create(db)
    sink = ListEventSink()

    with pytest.raises(RetryableFailure) as exc:
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            resolve=_resolve,
            sink=sink,
            # state=incomplete 模拟上游 EOF 未终止（截断流）。
            stream_generate=_stream_of(["## 半截\n"], state="incomplete"),
        )

    assert exc.value.error.code == InsightErrorCode.PROVIDER_UNAVAILABLE
    assert is_retryable(exc.value.error)
    assert not sink.terminals
    assert to_detail(run).status == InsightStatus.GENERATING
    assert run.content_markdown is None


def test_empty_stream_uses_existing_empty_content_path(db: Session) -> None:
    """空产出保持既有 empty-content 错误路径（可重试）。"""
    run = _create(db)
    sink = ListEventSink()

    with pytest.raises(RetryableFailure) as exc:
        execute_run(
            db=db,
            run_id=run.run_id,
            attempt=1,
            resolve=_resolve,
            sink=sink,
            stream_generate=_stream_of([]),
        )

    assert exc.value.error.code == InsightErrorCode.PROVIDER_UNAVAILABLE
    assert "empty" in exc.value.error.message
    assert not sink.terminals


def test_non_string_and_empty_chunks_are_skipped(db: Session) -> None:
    """非字符串 / 空 chunk 不产生帧，也不污染终稿。"""
    run = _create(db)
    sink = ListEventSink()

    out = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_stream_of(["## 摘要\n", "", None, 42, "正文\n"]),  # type: ignore[list-item]
    )

    assert out.status == InsightStatus.COMPLETED.value
    assert sink.streamed_text == "## 摘要\n正文\n"
    # cleaner 的 strip 会去掉尾部换行（原始分片保留）。
    assert to_detail(out).outputs["main"].content == sink.streamed_text.strip()


def test_cancel_mid_stream_stops_and_writes_nothing(db: Session, fake_redis) -> None:
    """流中途取消：立即停流、不发终态帧、不覆盖取消方写入的行。"""
    run = _create(db)
    writer = InsightStreamWriter(client=fake_redis)
    sink = StreamEventSink(writer=writer, run_id=run.run_id, attempt=1)
    sink.open(to_detail(run))

    cancelled = False

    class _CancellingStream(FakeStream):
        def __init__(self) -> None:
            super().__init__(["## 一\n", "二\n", "三\n", "四\n"])

        async def __anext__(self) -> str:
            nonlocal cancelled
            if not cancelled:
                # 第一帧之后用户取消：executor 应在一个抽检周期内停下来。
                cancelled = True
                cancel_run(db, run.run_id)
                db.commit()
            return await super().__anext__()

    def _factory(_agent: Any, _prompt: str) -> _CancellingStream:
        return _CancellingStream()

    out = execute_run(
        db=db, run_id=run.run_id, attempt=1, resolve=_resolve, sink=sink,
        stream_generate=_factory,
    )

    assert out.status == InsightStatus.CANCELLED.value
    assert out.content_markdown is None
    assert _typed(fake_redis, run.run_id, "done") == []
    # 取消是「对手」写的终态；本 worker 不得再写一次。
    assert _typed(fake_redis, run.run_id, "error") == []


def test_one_shot_generate_injection_keeps_legacy_single_frame(db: Session) -> None:
    """一次性注入口（generate=）行为不变：单帧整段 delta + 终态。"""
    run = _create(db)
    sink = ListEventSink()

    def _ok(_agent: Any, _prompt: str) -> LLMResult:
        return LLMResult(markdown="# Weekly\n\nbody", input_tokens=10, output_tokens=20)

    out = execute_run(
        db=db, run_id=run.run_id, attempt=1, resolve=_resolve, sink=sink, generate=_ok
    )

    assert out.status == InsightStatus.COMPLETED.value
    assert len(sink.deltas) == 1  # 旧路径仍是一帧
    assert sink.deltas[0][1] == "final"
    assert sink.streamed_text == "# Weekly\n\nbody"
    assert sink.content_snapshots and sink.content_snapshots[0][1] == "# Weekly\n\nbody"


def test_provider_stream_is_closed_when_consumer_aborts(db: Session) -> None:
    """消费被中止时也必须关闭 provider 流，避免继续计费。"""
    run = _create(db)
    captured: list[FakeStream] = []

    def _factory(_agent: Any, _prompt: str) -> FakeStream:
        stream = FakeStream(["## 一\n", "二\n"])
        captured.append(stream)
        return stream

    execute_run(
        db=db, run_id=run.run_id, attempt=1, resolve=_resolve,
        stream_generate=_factory,
    )

    assert captured and captured[0].closed is True


def test_production_wrapper_closes_provider_context_on_mid_stream_cancel(
    db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """回归（Tia 阻塞项）：真实生产 wrapper 在消费中止时真的关掉 provider context。

    旧写法只在 executor 侧 duck-type 查 ``stream.aclose``，而 ``InsightTextStream``
    当时没有这个方法 —— 生产路径下消费中止时不会显式关流（既有 ``FakeStream`` 自带
    ``aclose``，正好掩住了这个缺口）。

    为什么本用例必须把 ``shutdown_asyncgens`` 打掉：``asyncio.run`` 退出时会替所有未
    收尾的异步生成器补一发 ``GeneratorExit``，顺带把 ``agent.run_stream`` 的 async
    context 收掉 —— 不挡住它，测不出「显式关流」与「靠运行时回收」的区别（前者可预测、
    且不依赖执行器恰好跑在一次性事件循环里）。挡住后，``__aexit__`` 只可能由
    ``InsightTextStream.aclose`` 触发。

    其余全走真链路：真 ``open_text_stream`` 包装、真 ``default_stream`` 接缝、
    真 ``_consume_stream`` 与真 guard；只把秒级抽检间隔置 0，让首帧后的 guard 就发现取消。
    """
    from contextlib import asynccontextmanager

    from app.services.insight import executor as executor_mod
    from app.services.insight.provider import open_text_stream

    run = _create(db)
    monkeypatch.setattr(executor_mod, "_STREAM_GUARD_INTERVAL_SECONDS", 0.0)

    async def _noop_shutdown_asyncgens(self: Any) -> None:
        """不替本用例回收异步生成器（见 docstring）。"""

    monkeypatch.setattr(
        asyncio.BaseEventLoop, "shutdown_asyncgens", _noop_shutdown_asyncgens
    )

    class _FakeRun:
        response = None
        usage = None

        async def stream_text(self, delta: bool = True, debounce_by: Any = None):
            for piece in ("## 一\n", "二\n", "三\n"):
                yield piece

    class _RecordingAgent:
        def __init__(self) -> None:
            self.entered = 0
            self.exited = 0

        @asynccontextmanager
        async def run_stream(self, _prompt: str):
            self.entered += 1
            try:
                yield _FakeRun()
            finally:
                self.exited += 1

    agents: list[_RecordingAgent] = []

    def _factory(_agent: Any, prompt: str) -> Any:
        agent = _RecordingAgent()
        agents.append(agent)
        return open_text_stream(agent, prompt)

    class _CancellingSink(ListEventSink):
        """首帧到达时取消 run（与 ``test_cancel_mid_stream_...`` 同一手法）。"""

        def __init__(self) -> None:
            super().__init__()
            self._cancelled = False

        def on_content_delta(self, *, slot: str, block_id: str, delta: str) -> None:
            super().on_content_delta(slot=slot, block_id=block_id, delta=delta)
            if not self._cancelled:
                self._cancelled = True
                cancel_run(db, run.run_id)
                db.commit()

    sink = _CancellingSink()
    out = execute_run(
        db=db,
        run_id=run.run_id,
        attempt=1,
        resolve=_resolve,
        sink=sink,
        stream_generate=_factory,
    )

    # 取消方（对手）赢：本 worker 不写终态。
    assert out.status == InsightStatus.CANCELLED.value
    assert out.content_markdown is None
    assert not sink.terminals
    # 关键断言：真实 wrapper 的 aclose 把 provider async context 关掉。
    assert agents, "provider stream 未被创建"
    assert agents[0].entered == 1
    assert agents[0].exited == 1, "消费中止后 provider async context 未被关闭"


def _make_error(code: InsightErrorCode, message: str):
    from app.schemas.insight import make_error

    return make_error(code, message)
