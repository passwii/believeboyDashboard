"""Insight Redis Stream transport — key layout + sync write bus (BLF-1012).

Transport layer for the durable Insight run executor (BLF-1011). Redis only;
the database stays the single source of truth, the stream is a replayable
observation channel. No per-token DB writes ever happen here.

Key layout (all under the global ``redis_key_prefix``, db ``insight_stream_redis_db``):

- ``{prefix}:insight:stream:{run_id}`` — Redis Stream, one entry per event,
  field ``event`` = canonical JSON of the InsightEvent. Unified approximate
  MAXLEN + TTL stamped at terminal close-out.
- ``{prefix}:insight:snapshot:{run_id}`` — latest snapshot event JSON with
  its ``(attempt, seq)``, TTL = stream TTL. Written on every snapshot-worthy
  checkpoint so an out-of-window resume can resync from it.
- ``{prefix}:insight:seq:{run_id}:{attempt}`` — ``INCR`` counter owning seq
  allocation per attempt; retry (new attempt) starts a fresh chain.
- ``{prefix}:insight:cancel:{run_id}`` — cross-worker cancel registry:
  ``SETEX`` when a worker starts consuming the run, ``GETDEL`` on API cancel.
- ``{prefix}:insight:terminal:{run_id}:{attempt}`` — ``SET NX`` marker so a
  redelivered Celery task never double-emits the terminal event.

Event identity / replay:

- SSE ``id`` is the canonical cursor ``{run_id}:{attempt}:{seq}``
  (:mod:`app.services.insight.cursor`), *not* the Redis entry id. Entry ids
  are internal transport details and never leave the backend.
- ``seq`` is allocated strictly in-order per ``(run_id, attempt)`` by the
  sink. The executor protocol deliberately leaves envelope fields to the
  transport.

Sync vs async split:

- :class:`InsightStreamWriter` is the **sync** write path (plain
  ``redis.Redis``) used by the Celery worker. It never raises to the
  executor — Redis outages degrade to a dropped frame, the DB state wins.
- :mod:`app.services.insight.subscriber` is the **async** read path
  (``redis.asyncio``) used by the HTTP SSE endpoint.
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import redis
from redis.asyncio import ConnectionPool as AsyncConnectionPool
from redis.asyncio import Redis as AsyncRedis

from app.core.config import get_settings
from app.schemas.insight import InsightError, InsightErrorCode, make_error
from app.services.insight.events import InsightEvent

logger = logging.getLogger(__name__)

#: Field carrying the event JSON inside each stream entry.
EVENT_FIELD = "event"


def _p(suffix: str) -> str:
    """Global prefix + insight namespace (aligns with infra ``_p`` convention)."""
    return f"{get_settings().redis_key_prefix}:{suffix}"


def stream_key(run_id: UUID | str) -> str:
    return _p(f"insight:stream:{run_id}")


def snapshot_key(run_id: UUID | str) -> str:
    return _p(f"insight:snapshot:{run_id}")


def seq_key(run_id: UUID | str, attempt: int) -> str:
    return _p(f"insight:seq:{run_id}:{attempt}")


def cancel_key(run_id: UUID | str) -> str:
    return _p(f"insight:cancel:{run_id}")


def terminal_key(run_id: UUID | str, attempt: int) -> str:
    return _p(f"insight:terminal:{run_id}:{attempt}")


def metrics_key(run_id: UUID | str) -> str:
    """Per-run observation counters hash (BLF-1018).

    Same lifetime as the stream: written by the worker (frames/bytes/first
    delta), the SSE endpoint (opens/reconnects) and the cancel endpoint
    (cancel outcome). Aggregation reads this hash once at terminal state and
    folds it into the ``insight_run_observations`` row; Redis is the
    in-flight buffer, the DB row is the audit record.
    """
    return _p(f"insight:metrics:{run_id}")


# ── observation metric field names (BLF-1018) ───────────────────────────
#: SSE 订阅建立次数（每次 GET /stream 一次）。
METRIC_STREAM_OPENS = "stream_opens"
#: 带 Last-Event-ID 的续传次数（重连分子）。
METRIC_STREAM_RECONNECTS = "stream_reconnects"
#: 已发布事件帧数（XADD 成功一次记一次）。
METRIC_STREAM_FRAMES = "stream_frames"
#: 已发布载荷字节数。
METRIC_STREAM_BYTES = "stream_bytes"
#: 首字时延（attempt 起点 → 首个 content.delta 的毫秒数，只记第一次）。
METRIC_FIRST_DELTA_MS = "first_delta_ms"
#: 针对该 run 发起过的取消请求次数。
METRIC_CANCEL_REQUESTED = "cancel_requested"
#: 取消真正落地的次数（已成终态的取消不算）。
METRIC_CANCEL_SUCCEEDED = "cancel_succeeded"
#: 断线恢复观测：续传后是否观测到终态帧（0/1）。
METRIC_RECONNECT_COMPLETED = "reconnect_completed"

#: 全部计数器字段；聚合/清理按此枚举，避免拼写漂移。
METRIC_FIELDS = (
    METRIC_STREAM_OPENS,
    METRIC_STREAM_RECONNECTS,
    METRIC_STREAM_FRAMES,
    METRIC_STREAM_BYTES,
    METRIC_FIRST_DELTA_MS,
    METRIC_CANCEL_REQUESTED,
    METRIC_CANCEL_SUCCEEDED,
    METRIC_RECONNECT_COMPLETED,
)


def make_stream_client() -> redis.Redis:
    """Dedicated sync client for the insight stream db (worker side).

    Kept separate from the infra cache pool: stream traffic (per-token XADD)
    must not compete with business cache connections, and the db differs.
    """
    settings = get_settings()
    return redis.Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        db=settings.insight_stream_redis_db,
        socket_connect_timeout=5,
        socket_timeout=5,
        health_check_interval=30,
    )

_async_client: AsyncRedis | None = None


async def make_async_stream_client() -> AsyncRedis:
    """Pooled async singleton for the HTTP subscriber side (BLF-1012).

    Same db as the worker's sync client; pooled because one stream
    connection stays open for the whole SSE lifetime. First call pings so
    an outage surfaces at endpoint wiring time, not mid-stream.
    """
    global _async_client
    if _async_client is None:
        settings = get_settings()
        pool = AsyncConnectionPool(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            db=settings.insight_stream_redis_db,
            max_connections=20,
            socket_connect_timeout=5,
            socket_timeout=5,
            health_check_interval=30,
        )
        client = AsyncRedis(connection_pool=pool)
        await client.ping()
        _async_client = client
    return _async_client


async def close_async_stream_client() -> None:
    """Release the async singleton's pool (tests / shutdown)."""
    global _async_client
    if _async_client is not None:
        await _async_client.aclose()
        _async_client = None


async def bump_metric_async(
    client: Any, run_id: UUID | str, field: str, amount: int = 1
) -> None:
    """Async 版观测计数器自增（SSE 端点在事件循环里，不能用同步写端）。

    best-effort：Redis 抖动只留一条 warning —— 观测是旁路，绝不能把一次
    订阅或取消变成 500。
    """
    settings = get_settings()
    try:
        pipe = client.pipeline()
        pipe.hincrby(metrics_key(run_id), field, amount)
        pipe.expire(metrics_key(run_id), settings.insight_stream_ttl_seconds)
        await pipe.execute()
    except Exception:  # noqa: BLE001 — 传输层异常形状不定，观测降级即止
        logger.warning(
            "Insight metrics bump degraded (async run=%s field=%s)", run_id, field
        )


class InsightStreamWriter:
    """Sync write path for the Celery worker (BLF-1012).

    Contract with the executor (:class:`~app.services.insight.executor.InsightEventSink`):

    - never raises: every method swallows Redis errors and logs; a dropped
      frame never fails the run. The DB row is the authority, the stream is
      observation.
    - ``open_run`` is idempotent per attempt: the seq counter is created
      ``NX`` so a redelivery re-opening the same attempt keeps the
      already-allocated seq chain intact.
    """

    def __init__(self, client: redis.Redis | None = None) -> None:
        self._client = client

    def _redis(self) -> redis.Redis:
        if self._client is None:
            self._client = make_stream_client()
        return self._client

    # ── run lifecycle ──────────────────────────────────────────────────

    def open_run(self, run_id: UUID | str, attempt: int) -> None:
        """Register the cancel registry for a live attempt (best-effort).

        The cancel key carries the attempt that owns it; ``GETDEL`` on the
        API side returns it so the cancel endpoint can report which attempt
        was live. Idempotent for redelivery of the same attempt.
        """
        settings = get_settings()
        try:
            pipe = self._redis().pipeline()
            pipe.set(cancel_key(run_id), attempt, ex=settings.insight_stream_ttl_seconds)
            # Fresh attempt → fresh seq chain; NX keeps redelivery from
            # zeroing a counter that already allocated frames.
            pipe.set(seq_key(run_id, attempt), 0, nx=True, ex=settings.insight_stream_ttl_seconds)
            pipe.execute()
        except redis.RedisError:
            logger.warning("Insight stream open_run degraded (run=%s)", run_id)

    def next_seq(self, run_id: UUID | str, attempt: int) -> int | None:
        """Allocate the next seq; ``None`` on outage (the event is dropped)."""
        settings = get_settings()
        try:
            pipe = self._redis().pipeline()
            pipe.incr(seq_key(run_id, attempt))
            pipe.expire(seq_key(run_id, attempt), settings.insight_stream_ttl_seconds)
            return int(pipe.execute()[0])
        except redis.RedisError:
            logger.warning("Insight stream seq allocation degraded (run=%s)", run_id)
            return None

    def append_event(self, run_id: UUID | str, event: InsightEvent) -> None:
        """XADD one event with approximate MAXLEN trim (best-effort).

        Also accounts the published footprint (frames + serialized bytes)
        into the per-run metric hash — the single choke point every frame
        goes through, so the observation never misses one (BLF-1018).
        """
        settings = get_settings()
        payload = event.model_dump_json()
        try:
            pipe = self._redis().pipeline()
            pipe.xadd(
                stream_key(run_id),
                {EVENT_FIELD: payload},
                maxlen=settings.insight_stream_maxlen,
                approximate=True,
            )
            pipe.hincrby(metrics_key(run_id), METRIC_STREAM_FRAMES, 1)
            pipe.hincrby(
                metrics_key(run_id), METRIC_STREAM_BYTES, len(payload.encode("utf-8"))
            )
            pipe.expire(metrics_key(run_id), settings.insight_stream_ttl_seconds)
            pipe.execute()
        except redis.RedisError:
            logger.warning(
                "Insight stream append degraded (run=%s seq=%s)",
                run_id,
                getattr(event, "seq", "?"),
            )

    def save_checkpoint(self, run_id: UUID | str, event: InsightEvent) -> None:
        """Persist the latest snapshot event under its own key (TTL = stream TTL)."""
        settings = get_settings()
        try:
            self._redis().set(
                snapshot_key(run_id),
                event.model_dump_json(),
                ex=settings.insight_stream_ttl_seconds,
            )
        except redis.RedisError:
            logger.warning("Insight stream checkpoint degraded (run=%s)", run_id)

    def try_mark_terminal(self, run_id: UUID | str, attempt: int) -> bool:
        """Atomically claim the terminal emission slot for this attempt.

        ``SET NX``: the first caller wins. A Celery redelivery re-entering
        the terminal path (or two sibling deliveries racing) sees ``False``
        and must not emit a second terminal event.
        """
        settings = get_settings()
        try:
            acquired: bool = bool(
                self._redis().set(
                    terminal_key(run_id, attempt),
                    "1",
                    nx=True,
                    ex=settings.insight_stream_ttl_seconds,
                )
            )
            return acquired
        except redis.RedisError:
            # Redis down: emit anyway. A duplicate terminal frame is the
            # lesser evil vs. never delivering one — the client also guards
            # (seen-id set + terminal stops the consumer).
            logger.warning(
                "Insight stream terminal marker degraded (run=%s attempt=%s)",
                run_id,
                attempt,
            )
            return True

    def close_run(self, run_id: UUID | str, attempt: int) -> None:
        """Terminal close-out: TTL stream + snapshot, drop the cancel key.

        Best-effort: a Redis outage here only delays cleanup until the next
        attempt's markers overwrite them (keys also carry TTLs from open).
        """
        settings = get_settings()
        ttl = settings.insight_stream_ttl_seconds
        try:
            pipe = self._redis().pipeline()
            pipe.expire(stream_key(run_id), ttl)
            pipe.expire(snapshot_key(run_id), ttl)
            pipe.delete(cancel_key(run_id))
            pipe.execute()
        except redis.RedisError:
            logger.warning("Insight stream close_run degraded (run=%s)", run_id)

    def reset_run(self, run_id: UUID | str) -> None:
        """Explicit retry: drop the previous attempt's transport state.

        The stream key is per-run, not per-attempt; without this reset a
        fresh subscribe after retry replays the *previous* attempt's frames
        — including its terminal event, which would close the stream before
        the new attempt's first frame arrives. Called by the retry endpoint
        before re-enqueue; best-effort (an outage here only leaves the old
        window, which the subscriber's attempt filter also guards against).
        """
        try:
            self._redis().delete(
                stream_key(run_id),
                snapshot_key(run_id),
                cancel_key(run_id),
                metrics_key(run_id),
            )
        except redis.RedisError:
            logger.warning("Insight stream reset_run degraded (run=%s)", run_id)

    # ── observation counters (BLF-1018) ─────────────────────────────────

    def bump_metric(
        self, run_id: UUID | str, field: str, amount: int = 1
    ) -> None:
        """Increment one per-run observation counter (best-effort)."""
        settings = get_settings()
        try:
            pipe = self._redis().pipeline()
            pipe.hincrby(metrics_key(run_id), field, amount)
            pipe.expire(metrics_key(run_id), settings.insight_stream_ttl_seconds)
            pipe.execute()
        except redis.RedisError:
            logger.warning(
                "Insight metrics bump degraded (run=%s field=%s)", run_id, field
            )

    def set_metric_if_absent(
        self, run_id: UUID | str, field: str, value: int
    ) -> None:
        """First-write-wins counter: keeps "first delta" honest under redelivery.

        ``HSETNX`` rather than ``HSET`` because a redelivered attempt (or a
        second delta after the first) must not overwrite the latency already
        measured — the metric is the *first* delta by definition.
        """
        settings = get_settings()
        try:
            pipe = self._redis().pipeline()
            pipe.hsetnx(metrics_key(run_id), field, value)
            pipe.expire(metrics_key(run_id), settings.insight_stream_ttl_seconds)
            pipe.execute()
        except redis.RedisError:
            logger.warning(
                "Insight metrics set degraded (run=%s field=%s)", run_id, field
            )

    def read_metrics(self, run_id: UUID | str) -> dict[str, int]:
        """Read the whole counter hash; ``{}`` on outage or a missing key."""
        try:
            raw = self._redis().hgetall(metrics_key(run_id))
        except redis.RedisError:
            logger.warning("Insight metrics read degraded (run=%s)", run_id)
            return {}
        out: dict[str, int] = {}
        for key, value in raw.items():
            name = key.decode() if isinstance(key, bytes) else str(key)
            try:
                out[name] = int(value)
            except (TypeError, ValueError):
                continue
        return out

    def stream_footprint(self, run_id: UUID | str) -> tuple[int | None, int | None]:
        """Current ``(XLEN, MEMORY USAGE)`` of the run's stream.

        Both are best-effort: ``MEMORY`` is unsupported on some servers
        (older/embedded Redis), which yields ``None`` rather than an error.
        """
        length: int | None = None
        memory: int | None = None
        key = stream_key(run_id)
        try:
            length = int(self._redis().xlen(key))
        except (redis.RedisError, TypeError, ValueError):
            logger.warning("Insight stream xlen degraded (run=%s)", run_id)
        try:
            raw = self._redis().memory_usage(key)
            memory = int(raw) if raw is not None else None
        except (redis.RedisError, TypeError, ValueError):
            memory = None
        return length, memory

    def clear_metrics(self, run_id: UUID | str) -> None:
        """Drop the counter hash (explicit retry starts a fresh observation)."""
        try:
            self._redis().delete(metrics_key(run_id))
        except redis.RedisError:
            logger.warning("Insight metrics clear degraded (run=%s)", run_id)

    # ── cancel registry ────────────────────────────────────────────────

    def request_cancel(self, run_id: UUID | str) -> int | None:
        """Consume the cancel key (``GETDEL``); returns the live attempt or ``None``."""
        try:
            raw = self._redis().getdel(cancel_key(run_id))
            if raw is None:
                return None
            text = raw.decode() if isinstance(raw, bytes) else str(raw)
            return int(text)
        except (redis.RedisError, TypeError, ValueError):
            return None

    def make_insight_error(self, code: str, message: str) -> InsightError:
        """Typed error factory for terminal events (cancel/fail paths)."""
        return make_error(InsightErrorCode(code), message)

    @staticmethod
    def cancelled_error() -> InsightError:
        """Typed CANCELLED error payload for a cancelled run's terminal event."""
        return make_error(InsightErrorCode.CANCELLED, "Insight run cancelled")
