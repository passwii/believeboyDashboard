"""BLF-1012: async SSE subscriber — replay, resume, snapshot fallback.

Uses fakeredis.aioredis; the subscriber is transport-pure (detail loader is
injected), so these tests need no DB. Resume matrix per acceptance §2:

- fresh subscribe → all frames from seq 1, stop at terminal (inclusive);
- Last-Event-ID → strictly after the cursor, no duplicates;
- cursor beyond the window (trimmed events) → still the frames that exist
  after it, terminal stops the stream;
- stream empty + row terminal → snapshot + synthesized terminal from DB;
- idle non-terminal stream keeps following (no premature stop);
- Redis outage → TransportUnavailableError (caller maps to typed error).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from uuid import uuid4

import fakeredis.aioredis
import pytest
import pytest_asyncio

from app.schemas.insight import (
    InsightError,
    InsightErrorCode,
    InsightResumeInfo,
    InsightRunDetail,
    InsightStage,
    InsightStatus,
    make_error,
)
from app.services.insight.stream_bus import EVENT_FIELD, snapshot_key, stream_key
from app.services.insight.subscriber import (
    InsightStreamSubscriber,
    TransportUnavailableError,
    _after_cursor,
)


@pytest_asyncio.fixture
async def fake_redis():
    redis = fakeredis.aioredis.FakeRedis()
    yield redis
    await redis.aclose()


def _detail(
    rid: str,
    *,
    status: InsightStatus = InsightStatus.GENERATING,
    progress: int = 40,
    error: InsightError | None = None,
    outputs: dict[str, Any] | None = None,
) -> InsightRunDetail:
    from datetime import datetime, timezone

    return InsightRunDetail(
        schema_version=1,
        run_id=rid,  # type: ignore[arg-type]
        attempt=1,
        role_id="schedule_report_summary",
        role_version=1,
        project_id=42,
        country="US",
        status=status,
        stage=InsightStage.GENERATING,
        progress_percent=progress,
        outputs=outputs or {},
        error=error,
        resume=InsightResumeInfo(
            latest_event_id=None, current_attempt=1, history_available=True
        ),
        created_at=datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
        updated_at=datetime(2026, 9, 10, 8, 0, tzinfo=timezone.utc),
    )


def _seed_stream(sync_redis: Any, rid: str, events: list[dict]) -> None:
    """Write events directly as stream entries (sync writer semantics)."""
    for payload in events:
        sync_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})


def _base(rid: str, seq: int, **extra: Any) -> dict:
    payload = {
        "schema_version": 1,
        "run_id": rid,
        "attempt": 1,
        "seq": seq,
        **extra,
    }
    return payload


def _happy_events(rid: str) -> list[dict]:
    return [
        _base(rid, 1, type="snapshot", status="queued", stage="queued", progress_percent=5,
              outputs={}, is_terminal=False, error=None),
        _base(rid, 2, type="status", status="aggregating", stage="aggregating",
              progress_percent=30, detail="正在聚合数据"),
        _base(rid, 3, type="content.delta", slot="main", block_id="b1", format="markdown",
              delta="## 本周摘要\n"),
        _base(rid, 4, type="status", status="finalizing", stage="finalizing",
              progress_percent=95, detail=None),
        _base(rid, 5, type="done", status="completed",
              content_sha256="c" * 64,
              outputs={"main": {"format": "markdown", "content": "## 本周摘要\n",
                                "content_sha256": "c" * 64}},
              title="本周摘要", artifact_id=None),
    ]


async def _collect(subscriber, **kwargs) -> list[tuple[Any, str]]:
    out = []
    async for event, sse_id in subscriber.subscribe(**kwargs):
        out.append((event, sse_id))
    return out


@pytest.mark.asyncio
async def test_fresh_subscribe_replays_all_until_terminal(fake_redis) -> None:
    rid = str(uuid4())
    sync = fakeredis.FakeRedis()
    _seed_stream(sync, rid, _happy_events(rid))
    await fake_redis.flushall()  # separate sync/async servers: copy entries over
    for payload in _happy_events(rid):
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})

    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber, run_id=rid, last_event_id=None, detail=_detail(rid)
    )
    types = [event.type for event, _ in frames]
    assert types == ["snapshot", "status", "content.delta", "status", "done"]
    ids = [sse_id for _, sse_id in frames]
    assert ids == [f"{rid}:1:{n}" for n in range(1, 6)]  # canonical ids


@pytest.mark.asyncio
async def test_last_event_id_resumes_strictly_after_cursor(fake_redis) -> None:
    rid = str(uuid4())
    for payload in _happy_events(rid):
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})

    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber,
        run_id=rid,
        last_event_id=f"{rid}:1:3",
        detail=_detail(rid),
    )
    seqs = [event.seq for event, _ in frames]
    assert seqs == [4, 5]  # strictly after seq 3, terminal inclusive
    assert frames[-1][0].type == "done"


@pytest.mark.asyncio
async def test_trimmed_cursor_emits_snapshot_checkpoint_before_retained_frames(
    fake_redis,
) -> None:
    """B2: gap between cursor and first retained frame → snapshot first.

    The window only kept seq 4-5; the client's cursor is seq 2. The first
    retained frame (seq 4) reveals the gap, so the saved snapshot checkpoint
    re-syncs full state *before* incremental frames resume.
    """
    rid = str(uuid4())
    events = _happy_events(rid)
    for payload in events[3:]:  # seq 4, 5 survive
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})
    # worker checkpoint at seq 3 (content complete up to there)
    checkpoint = _base(rid, 3, type="snapshot", status="generating",
                       stage="generating", progress_percent=60,
                       outputs={"main": {"format": "markdown", "content": "## 摘要",
                                         "content_sha256": "c" * 64}},
                       is_terminal=False, error=None)
    await fake_redis.set(snapshot_key(rid), json.dumps(checkpoint))

    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber,
        run_id=rid,
        last_event_id=f"{rid}:1:2",
        detail=_detail(rid),
    )
    types = [event.type for event, _ in frames]
    seqs = [event.seq for event, _ in frames]
    # snapshot checkpoint first, then the retained frames strictly after cursor
    assert types == ["snapshot", "status", "done"]
    assert seqs == [3, 4, 5]


@pytest.mark.asyncio
async def test_trimmed_cursor_without_checkpoint_falls_back_to_db_snapshot(
    fake_redis,
) -> None:
    """B2: checkpoint key lost too → synthesize the snapshot from the row."""
    rid = str(uuid4())
    for payload in _happy_events(rid)[3:]:
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})
    # no snapshot_key entry at all

    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber,
        run_id=rid,
        last_event_id=f"{rid}:1:1",
        detail=_detail(rid),
    )
    types = [event.type for event, _ in frames]
    # DB snapshot (synthetic) precedes the retained frames
    assert types[0] == "snapshot"
    assert types == ["snapshot", "status", "done"]


@pytest.mark.asyncio
async def test_stale_attempt_frames_are_dropped_after_retry(fake_redis) -> None:
    """B1: frames from an attempt older than the DB row's never reach the
    client — a retry whose transport reset was missed must not replay the
    previous attempt's terminal event and close the stream early."""
    rid = str(uuid4())
    # attempt 1 window still present (reset missed); attempt 2 is live.
    stale = [
        _base(rid, 1, type="snapshot", status="queued", stage="queued",
              progress_percent=5, outputs={}, is_terminal=False, error=None),
        _base(rid, 2, type="status", status="generating", stage="generating",
              progress_percent=40, detail=None),
    ]
    fresh = [
        {"schema_version": 1, "run_id": rid, "attempt": 2, "seq": 1,
         "type": "snapshot", "status": "queued", "stage": "queued",
         "progress_percent": 5, "outputs": {}, "is_terminal": False, "error": None},
        {"schema_version": 1, "run_id": rid, "attempt": 2, "seq": 2,
         "type": "status", "status": "generating", "stage": "generating",
         "progress_percent": 40, "detail": None},
        {"schema_version": 1, "run_id": rid, "attempt": 2, "seq": 3,
         "type": "done", "status": "completed", "content_sha256": "e" * 64,
         "outputs": {"main": {"format": "markdown", "content": "## 新结果",
                              "content_sha256": "e" * 64}},
         "title": "新标题", "artifact_id": None},
    ]
    for payload in stale + fresh:
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})

    subscriber = InsightStreamSubscriber(fake_redis)
    # DB row is at attempt 2 (retry bumped it).
    detail = _detail(rid).model_copy(update={"attempt": 2})
    frames = await _collect(
        subscriber, run_id=rid, last_event_id=None, detail=detail
    )
    attempts = [event.attempt for event, _ in frames]
    seqs = [event.seq for event, _ in frames]
    # only attempt 2 frames, seq chain from 1, terminal inclusive
    assert attempts == [2, 2, 2]
    assert seqs == [1, 2, 3]
    assert frames[-1][0].type == "done"


@pytest.mark.asyncio
async def test_empty_stream_with_terminal_row_synthesizes_terminal(fake_redis) -> None:
    rid = str(uuid4())
    # Stream TTL expired entirely; the row (DB) is completed.
    completed = _detail(
        rid,
        status=InsightStatus.COMPLETED,
        progress=100,
        outputs={"main": {"format": "markdown", "content": "## 完成",
                          "content_sha256": "d" * 64}},
    )
    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber, run_id=rid, last_event_id=None, detail=completed
    )
    types = [event.type for event, _ in frames]
    assert types == ["snapshot", "done"]  # snapshot first, terminal exactly once
    assert frames[0][0].status == InsightStatus.COMPLETED
    assert frames[-1][0].outputs["main"].content == "## 完成"
    # B4: ids must differ — the client dedupes by SSE id, a shared id would
    # swallow the terminal frame and the completed run would render failed.
    ids = [sse_id for _, sse_id in frames]
    assert len(set(ids)) == len(ids)
    seqs = [event.seq for event, _ in frames]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


@pytest.mark.asyncio
async def test_partial_frames_then_terminal_row_yields_single_terminal_frame(
    fake_redis,
) -> None:
    """B4 / probe P8: worker died after publishing frames but before the
    terminal — the idle DB refresh synthesizes the terminal ALONE (no
    duplicate snapshot), with an id distinct from every prior frame."""
    rid = str(uuid4())
    for payload in _happy_events(rid)[:3]:  # snapshot, status, delta — no terminal
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})
    cancelled = _detail(
        rid, status=InsightStatus.CANCELLED,
        error=make_error(InsightErrorCode.CANCELLED, "已取消"),
    )
    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber, run_id=rid, last_event_id=None, detail=cancelled
    )
    types = [event.type for event, _ in frames]
    # Real frames replay; terminal synthesized once — no snapshot before it.
    assert types == ["snapshot", "status", "content.delta", "error"]
    ids = [sse_id for _, sse_id in frames]
    assert len(set(ids)) == len(ids)  # B4: no id ever repeats
    seqs = [event.seq for event, _ in frames]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    assert frames[-1][0].error.code == InsightErrorCode.CANCELLED


@pytest.mark.asyncio
async def test_trimmed_resume_db_fallback_snapshot_sits_below_retained_frames(
    fake_redis,
) -> None:
    """B5: checkpoint lost + trimmed window → the DB-fallback snapshot's seq
    is cursor.seq + 1: unseen before (trimmed gap), below the next retained
    frame — so a disconnect after it still lets real frames resume."""
    rid = str(uuid4())
    for payload in _happy_events(rid)[3:]:  # seq 4, 5 survive
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})
    # no snapshot_key entry
    subscriber = InsightStreamSubscriber(fake_redis)
    frames = await _collect(
        subscriber,
        run_id=rid,
        last_event_id=f"{rid}:1:2",
        detail=_detail(rid),
    )
    seqs = [event.seq for event, _ in frames]
    types = [event.type for event, _ in frames]
    assert types == ["snapshot", "status", "done"]
    # fallback snapshot at cursor.seq+1 (=3), then retained 4, 5
    assert seqs == [3, 4, 5]
    ids = [sse_id for _, sse_id in frames]
    assert len(set(ids)) == len(ids)
    seqs = [event.seq for event, _ in frames]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


@pytest.mark.asyncio
async def test_idle_live_stream_keeps_following_until_events_arrive(fake_redis) -> None:
    rid = str(uuid4())
    subscriber = InsightStreamSubscriber(fake_redis)

    async def produce_later():
        await asyncio.sleep(0.05)
        payload = _base(rid, 1, type="snapshot", status="queued", stage="queued",
                        progress_percent=5, outputs={}, is_terminal=False, error=None)
        await fake_redis.xadd(stream_key(rid), {EVENT_FIELD: json.dumps(payload)})

    producer = asyncio.create_task(produce_later())

    async def first_frames():
        got = []
        async for event, sse_id in subscriber.subscribe(
            run_id=rid, last_event_id=None, detail=_detail(rid)
        ):
            got.append((event, sse_id))
            return got  # a live (non-terminal) stream is followed forever

    frames = await asyncio.wait_for(first_frames(), timeout=10)
    await producer
    # The idle loop kept xreading; the frame published mid-wait was delivered.
    assert frames is not None
    assert [event.type for event, _ in frames] == ["snapshot"]


@pytest.mark.asyncio
async def test_redis_outage_raises_transport_unavailable(fake_redis, monkeypatch) -> None:
    rid = str(uuid4())

    async def broken_xread(*args, **kwargs):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(fake_redis, "xread", broken_xread)
    subscriber = InsightStreamSubscriber(fake_redis)
    with pytest.raises(TransportUnavailableError):
        async for _ in subscriber.subscribe(
            run_id=rid, last_event_id=None, detail=_detail(rid)
        ):
            pass


def test_after_cursor_canonical_ordering() -> None:
    from app.services.insight.events import PingEvent

    rid = uuid4()
    p1 = PingEvent(schema_version=1, run_id=rid, attempt=1, seq=4)
    assert _after_cursor(p1, (1, 3)) is True
    assert _after_cursor(p1, (1, 4)) is False
    assert _after_cursor(p1, (2, 1)) is False  # newer attempt still wins
