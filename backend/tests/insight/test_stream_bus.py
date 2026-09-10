"""BLF-1012: Redis Stream transport — bus keys, seq, cancel, terminal-once.

Uses fakeredis; no real Redis, no DB. The executor-driven sink integration
lives in test_stream_sink.py; the HTTP surface in tests/api/test_insight_runs_stream.py.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import fakeredis
import pytest

from app.core.config import get_settings
from app.services.insight import stream_bus
from app.services.insight.events import PingEvent
from app.services.insight.stream_bus import (
    InsightStreamWriter,
    cancel_key,
    seq_key,
    snapshot_key,
    stream_key,
    terminal_key,
)


@pytest.fixture()
def fake_redis() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis()


@pytest.fixture()
def writer(fake_redis: fakeredis.FakeRedis) -> InsightStreamWriter:
    return InsightStreamWriter(client=fake_redis)


def _ping(rid: UUID, seq: int) -> PingEvent:
    return PingEvent(schema_version=1, run_id=rid, attempt=1, seq=seq)


def test_keys_carry_global_prefix_and_namespace() -> None:
    rid = uuid4()
    prefix = get_settings().redis_key_prefix
    assert stream_key(rid) == f"{prefix}:insight:stream:{rid}"
    assert snapshot_key(rid) == f"{prefix}:insight:snapshot:{rid}"
    assert seq_key(rid, 2) == f"{prefix}:insight:seq:{rid}:2"
    assert cancel_key(rid) == f"{prefix}:insight:cancel:{rid}"
    assert terminal_key(rid, 2) == f"{prefix}:insight:terminal:{rid}:2"


def test_open_run_registers_cancel_and_seeds_seq(writer: InsightStreamWriter) -> None:
    rid = uuid4()
    writer.open_run(rid, 1)
    # redelivery re-opening the same attempt keeps the allocated chain (NX)
    writer.next_seq(rid, 1)
    writer.next_seq(rid, 1)
    writer.open_run(rid, 1)
    assert writer.next_seq(rid, 1) == 3


def test_next_seq_strictly_increments_per_attempt(writer: InsightStreamWriter) -> None:
    rid = uuid4()
    writer.open_run(rid, 1)
    assert [writer.next_seq(rid, 1) for _ in range(3)] == [1, 2, 3]
    writer.open_run(rid, 2)  # retry: fresh chain
    assert writer.next_seq(rid, 2) == 1


def test_cancel_registry_getdel_returns_live_attempt(
    writer: InsightStreamWriter,
    fake_redis: fakeredis.FakeRedis,
) -> None:
    rid = uuid4()
    assert writer.request_cancel(rid) is None  # nothing registered
    writer.open_run(rid, 3)
    assert writer.request_cancel(rid) == 3
    assert writer.request_cancel(rid) is None  # consumed exactly once
    assert fake_redis.exists(cancel_key(rid)) == 0  # registry consumed


def test_terminal_marker_is_set_once(writer: InsightStreamWriter) -> None:
    rid = uuid4()
    assert writer.try_mark_terminal(rid, 1) is True
    assert writer.try_mark_terminal(rid, 1) is False  # redelivery blocked
    assert writer.try_mark_terminal(rid, 2) is True  # new attempt = new slot


def test_append_event_writes_event_field(
    writer: InsightStreamWriter, fake_redis: fakeredis.FakeRedis
) -> None:
    rid = uuid4()
    writer.append_event(rid, _ping(rid, 1))
    entries = fake_redis.xrange(stream_key(rid))  # type: ignore[union-attr]
    assert len(entries) == 1  # type: ignore[arg-type]
    fields = entries[0][1]  # type: ignore[index]
    assert '"type":"ping"' in fields[b"event"].decode()


def test_close_run_ttls_stream_and_drops_cancel(
    writer: InsightStreamWriter, fake_redis: fakeredis.FakeRedis
) -> None:
    rid = uuid4()
    writer.open_run(rid, 1)
    # Stream must exist before TTL applies (EXPIRE on a missing key is a
    # no-op); the real flow always has at least the opening snapshot.
    writer.append_event(rid, _ping(rid, 1))
    writer.save_checkpoint(rid, _ping(rid, 1))
    writer.close_run(rid, 1)
    assert fake_redis.ttl(stream_key(rid)) > 0  # type: ignore[operator]
    assert fake_redis.ttl(snapshot_key(rid)) > 0  # type: ignore[operator]
    assert fake_redis.exists(cancel_key(rid)) == 0


def test_reset_run_drops_previous_attempt_transport_state(
    writer: InsightStreamWriter, fake_redis: fakeredis.FakeRedis
) -> None:
    """B1: retry must clear the per-run stream so old attempt frames
    (including its terminal event) never reach a post-retry subscriber."""
    rid = uuid4()
    writer.open_run(rid, 1)
    writer.append_event(rid, _ping(rid, 1))
    writer.save_checkpoint(rid, _ping(rid, 1))
    writer.try_mark_terminal(rid, 1)
    writer.reset_run(rid)
    assert fake_redis.exists(stream_key(rid)) == 0
    assert fake_redis.exists(snapshot_key(rid)) == 0
    assert fake_redis.exists(cancel_key(rid)) == 0
    # outage → swallowed, retry proceeds
    class BrokenRedis:
        def __getattr__(self, name):
            def explode(*args, **kwargs):
                raise stream_bus.redis.RedisError("down")

            return explode

    broken = InsightStreamWriter(client=BrokenRedis())  # type: ignore[arg-type]
    broken.reset_run(rid)


def test_all_writer_methods_swallow_redis_outage() -> None:
    class BrokenRedis:
        def __getattr__(self, name):  # every call explodes
            def explode(*args, **kwargs):
                raise stream_bus.redis.RedisError("down")

            return explode

    writer = InsightStreamWriter(client=BrokenRedis())  # type: ignore[arg-type]
    rid = uuid4()
    # Nothing raises: the DB stays authoritative, the stream is best-effort.
    writer.open_run(rid, 1)
    assert writer.next_seq(rid, 1) is None
    writer.append_event(rid, _ping(rid, 1))
    writer.save_checkpoint(rid, _ping(rid, 1))
    assert writer.try_mark_terminal(rid, 1) is True  # emit anyway (lesser evil)
    writer.close_run(rid, 1)
    writer.reset_run(rid)
    assert writer.request_cancel(rid) is None
