"""BLF-1012: StreamEventSink — executor callbacks → stream frames.

Drives the sink exactly the way the executor does (queued snapshot → status
frames → content delta → terminal), then asserts the stream's observable
contract: canonical ids, seq chains, snapshot checkpoints, terminal-once,
and the Redis keys' lifecycle. DB-free: the sink only receives rows/details.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import fakeredis
import pytest

from app.schemas.insight import (
    InsightError,
    InsightErrorCode,
    InsightResumeInfo,
    InsightRunDetail,
    InsightStage,
    InsightStatus,
    make_error,
)
from app.services.insight.sink import StreamEventSink
from app.services.insight.stream_bus import (
    InsightStreamWriter,
    cancel_key,
    snapshot_key,
    stream_key,
)

_NOW = datetime(2026, 9, 10, 8, 0, 0, tzinfo=timezone.utc)


@pytest.fixture()
def fake_redis() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis()


@pytest.fixture()
def writer(fake_redis: fakeredis.FakeRedis) -> InsightStreamWriter:
    return InsightStreamWriter(client=fake_redis)


@pytest.fixture()
def sink(writer: InsightStreamWriter) -> tuple[StreamEventSink, str]:
    rid = str(uuid4())
    return StreamEventSink(writer=writer, run_id=rid, attempt=1), rid


def _detail(
    run_id: str,
    *,
    status: InsightStatus = InsightStatus.GENERATING,
    stage: InsightStage = InsightStage.GENERATING,
    progress: int = 40,
    outputs: dict[str, Any] | None = None,
    error: InsightError | None = None,
) -> InsightRunDetail:
    return InsightRunDetail(
        schema_version=1,
        run_id=run_id,  # type: ignore[arg-type]
        attempt=1,
        role_id="schedule_report_summary",
        role_version=1,
        project_id=42,
        country="US",
        status=status,
        stage=stage,
        progress_percent=progress,
        outputs=outputs or {},
        error=error,
        resume=InsightResumeInfo(
            latest_event_id=None, current_attempt=1, history_available=False
        ),
        created_at=_NOW,
        updated_at=_NOW,
    )


class _FakeRun:
    """Minimal InsightRun stand-in: the sink reads run_id/status (+ started_at).

    ``started_at`` mirrors the real column (naive UTC) because the sink now
    anchors first-delta latency on the first status checkpoint (BLF-1018).
    """

    def __init__(
        self, run_id: str, status: InsightStatus, started_at: datetime | None = None
    ) -> None:
        self.run_id = run_id
        self.status = status.value
        self.started_at = started_at


def _stream_events(fake_redis: fakeredis.FakeRedis, rid: str) -> list[dict]:
    entries = fake_redis.xrange(stream_key(rid))  # type: ignore[union-attr]
    return [json.loads(fields[b"event"].decode()) for _eid, fields in entries]  # type: ignore[index]


def test_open_publishes_snapshot_and_registers_cancel(
    sink: tuple[StreamEventSink, str], fake_redis: fakeredis.FakeRedis
) -> None:
    sink_obj, rid = sink
    sink_obj.open(_detail(rid))
    events = _stream_events(fake_redis, rid)
    assert len(events) == 1
    assert events[0]["type"] == "snapshot"
    assert events[0]["seq"] == 1
    assert events[0]["schema_version"] == 1
    assert fake_redis.exists(cancel_key(rid)) == 1


def test_status_and_delta_frames_allocate_strict_seq(
    sink: tuple[StreamEventSink, str], fake_redis: fakeredis.FakeRedis
) -> None:
    sink_obj, rid = sink
    sink_obj.open(_detail(rid))
    run_a = _FakeRun(rid, InsightStatus.AGGREGATING)
    sink_obj.on_status(run_a, InsightStage.AGGREGATING, 10)  # type: ignore[arg-type]
    run_g = _FakeRun(rid, InsightStatus.GENERATING)
    sink_obj.on_status(run_g, InsightStage.GENERATING, 40, detail="生成中")  # type: ignore[arg-type]
    sink_obj.on_content_delta(slot="main", block_id="b1", delta="## 摘要\n")
    sink_obj.on_content_delta(slot="main", block_id="b1", delta="- 销量 -10%\n")
    events = _stream_events(fake_redis, rid)
    assert [e["type"] for e in events] == [
        "snapshot",
        "status",
        "status",
        "content.delta",
        "content.delta",
    ]
    # seq strictly +1 from 1 (canonical envelope invariant)
    assert [e["seq"] for e in events] == [1, 2, 3, 4, 5]
    assert events[2]["detail"] == "生成中"
    assert events[3]["delta"] == "## 摘要\n"


def test_terminal_done_published_once_with_checkpoint(
    sink: tuple[StreamEventSink, str], fake_redis: fakeredis.FakeRedis
) -> None:
    sink_obj, rid = sink
    content = "## 本周摘要\n\n- 销量环比 -10%\n"
    digest = hashlib.sha256(content.encode()).hexdigest()
    outputs = {
        "main": {"format": "markdown", "content": content, "content_sha256": digest}
    }
    sink_obj.open(_detail(rid))
    run_f = _FakeRun(rid, InsightStatus.FINALIZING)
    sink_obj.on_status(run_f, InsightStage.FINALIZING, 90)  # type: ignore[arg-type]
    terminal_detail = _detail(
        rid,
        status=InsightStatus.COMPLETED,
        stage=InsightStage.FINALIZING,
        progress=100,
        outputs=outputs,
    )
    sink_obj.on_terminal(terminal_detail)
    # A redelivery racing the terminal path again must be a no-op.
    sink_obj.on_terminal(terminal_detail)

    events = _stream_events(fake_redis, rid)
    types = [e["type"] for e in events]
    assert types.count("done") == 1  # terminal exactly once
    assert types[-1] == "done"
    done = events[-1]
    assert done["content_sha256"] == digest
    assert done["outputs"]["main"]["content"] == content
    # Closing checkpoint saved under its own key before the terminal frame.
    snapshot_raw = fake_redis.get(snapshot_key(rid))  # type: ignore[union-attr]
    snapshot = json.loads(snapshot_raw.decode())  # type: ignore[union-attr]
    assert snapshot["is_terminal"] is True
    # Close-out dropped the cancel registry.
    assert fake_redis.exists(cancel_key(rid)) == 0


def test_terminal_error_frames_typed_for_failed_and_cancelled(
    writer: InsightStreamWriter, fake_redis: fakeredis.FakeRedis
) -> None:
    for status, expected_code in (
        (InsightStatus.FAILED, InsightErrorCode.PROVIDER_UNAVAILABLE),
        (InsightStatus.CANCELLED, InsightErrorCode.CANCELLED),
    ):
        rid = str(uuid4())
        run_sink = StreamEventSink(writer=writer, run_id=rid, attempt=1)
        run_sink.open(_detail(rid))
        error = make_error(expected_code, f"typed {status.value}")
        run_sink.on_terminal(_detail(rid, status=status, error=error))
        events = _stream_events(fake_redis, rid)
        terminal = events[-1]
        assert terminal["type"] == "error"
        assert terminal["status"] == status.value
        assert terminal["error"]["code"] == expected_code.value


def test_retry_attempt_gets_fresh_seq_chain(
    writer: InsightStreamWriter, fake_redis: fakeredis.FakeRedis
) -> None:
    rid = str(uuid4())
    first = StreamEventSink(writer=writer, run_id=rid, attempt=1)
    first.open(_detail(rid))
    first.on_status(_FakeRun(rid, InsightStatus.GENERATING), InsightStage.GENERATING, 40)  # type: ignore[arg-type]
    second = StreamEventSink(writer=writer, run_id=rid, attempt=2)
    second.open(
        _detail(rid, status=InsightStatus.QUEUED, stage=InsightStage.QUEUED, progress=0)
    )
    second.on_status(_FakeRun(rid, InsightStatus.AGGREGATING), InsightStage.AGGREGATING, 10)  # type: ignore[arg-type]
    events = _stream_events(fake_redis, rid)
    attempt1 = [e for e in events if e["attempt"] == 1]
    attempt2 = [e for e in events if e["attempt"] == 2]
    assert [e["seq"] for e in attempt1] == [1, 2]
    assert [e["seq"] for e in attempt2] == [1, 2]  # retry restarts seq at 1
