"""Insight async SSE subscriber (BLF-1012).

Read side of the Redis Stream transport, used by the HTTP SSE endpoint.
Async (``redis.asyncio``) because the FastAPI stream handler runs on the
event loop; the Celery writer stays sync (``stream_bus.py``).

Resume semantics (issue acceptance §2):

- Client connects without ``Last-Event-ID`` → replay from the stream start,
  but *first* check the authoritative DB: a run that already reached
  terminal streams its snapshot + terminal event and closes.
- Client reconnects with ``Last-Event-ID`` → events resume strictly after
  the cursor. The cursor is the canonical ``{run_id}:{attempt}:{seq}``,
  *not* a Redis entry id — the subscriber scans the bounded stream and
  filters by canonical order ``(attempt, seq)``.
- Cursor out of the retention window (or from an older attempt whose
  events were trimmed) → send the saved snapshot checkpoint first, then
  continue from the live tail. The client's seen-id set dedupes overlap.
- Terminal event (``done``/``error``) → deliver it and stop the generator.
- Run row already terminal and stream empty/expired → synthesize the
  terminal event from the DB snapshot (the detail endpoint's authority)
  so a late reconnect still observes the outcome exactly once.

Error paths: Redis outage raises :class:`TransportUnavailableError`; the
endpoint maps it to a typed retryable error and the client falls back to
the detail endpoint.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any
from uuid import UUID

from redis.asyncio import Redis

from app.schemas.insight import InsightRunDetail
from app.services.insight.cursor import event_id_of, parse_event_id
from app.services.insight.events import (
    TERMINAL_EVENT_TYPES,
    InsightEvent,
    InsightEventAdapter,
)
from app.services.insight.stream_bus import EVENT_FIELD, snapshot_key, stream_key

logger = logging.getLogger(__name__)

#: XRREAD block time while waiting for live frames (ms).
_READ_BLOCK_MS = 2000

#: Poll cadence for the DB-terminal check on an idle stream (s).
_DB_POLL_SECONDS = 5.0


class TransportUnavailableError(Exception):
    """Redis unreachable for the Insight transport.

    The HTTP layer maps this to a typed retryable error (503 semantics);
    clients fall back to the detail endpoint, which always answers from DB.
    """


def _decode(raw: Any) -> str:
    return raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)


def _parse_event(raw: Any) -> InsightEvent | None:
    """Parse one stream entry field; corrupt frames are dropped, not fatal."""
    try:
        return InsightEventAdapter.validate_json(_decode(raw))
    except Exception:  # noqa: BLE001 — one bad frame never kills the stream
        logger.warning("Insight stream: dropping unparseable entry")
        return None


def _after_cursor(event: InsightEvent, cursor: tuple[int, int]) -> bool:
    """Canonical order ``(attempt, seq)`` strictly greater than the cursor."""
    return (event.attempt, event.seq) > cursor


class InsightStreamSubscriber:
    """Async read path for one run's stream (BLF-1012).

    ``subscribe`` yields ``(event, sse_id)`` pairs until the terminal event
    (inclusive) or an unrecoverable error. The generator is the SSE body's
    only content source — the endpoint only frames/encodes.
    """

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def load_checkpoint(self, run_id: UUID | str) -> InsightEvent | None:
        """Latest saved snapshot event, or ``None`` (missing or outage→raise)."""
        try:
            raw = await self._redis.get(snapshot_key(run_id))
        except Exception as exc:  # broad by design: transport outage mapping
            raise TransportUnavailableError("load checkpoint") from exc
        if raw is None:
            return None
        return _parse_event(raw)

    async def subscribe(
        self,
        *,
        run_id: UUID | str,
        last_event_id: str | None,
        detail: InsightRunDetail,
        is_disconnected: Any | None = None,
    ) -> AsyncGenerator[tuple[InsightEvent, str], None]:
        """Yield ``(event, sse_id)`` until the terminal event (inclusive).

        ``detail`` is the run's authoritative DB snapshot at subscribe time;
        it seeds the resume decision (already-terminal runs synthesize the
        terminal frame when the stream has none left) and the DB fallback
        path when Redis has nothing.
        """
        rid = str(run_id)
        # Parse and validate the cursor before touching Redis: a malformed
        # cursor is a client error, not a transport error.
        cursor: tuple[int, int] | None = None
        if last_event_id is not None:
            parsed = parse_event_id(last_event_id)
            if str(parsed.run_id) == rid:
                cursor = (parsed.attempt, parsed.seq)
            # A foreign cursor (different run_id) falls back to a
            # from-the-start replay; the client dedupes with its seen set.

        async for event in self._replay_and_follow(rid, cursor, detail):
            yield event, event_id_of(event)
            if event.type in TERMINAL_EVENT_TYPES:
                return

    async def _replay_and_follow(
        self,
        run_id: str,
        cursor: tuple[int, int] | None,
        detail: InsightRunDetail,
    ) -> AsyncGenerator[InsightEvent, None]:
        """Replay window content after the cursor, then follow the live tail.

        Invariants (BLF-1012 review B1/B2):
        - Frames from attempts older than ``detail.attempt`` are dropped: a
          retry resets the transport, but a Redis outage between reset and
          re-enqueue could still leave the old window behind — the DB row's
          attempt is the authority on which frames are current.
        - On a cursor resume, when the first retained frame's canonical seq
          reveals a gap (frames between the cursor and it were trimmed),
          the saved snapshot checkpoint is emitted first so the client
          re-syncs full state before incremental frames resume.

        DB check cadence: an idle *non-terminal* stream re-reads the run row
        every ``_DB_POLL_SECONDS`` so a run whose worker died mid-attempt
        (stream stalled, row terminal via park-failed) still reaches the
        client.
        """
        from app.services.insight.lifecycle import is_terminal

        last_entry = "0-0"
        saw_any = False
        cursor_gap_snapshot_sent = False

        while True:
            try:
                entries = await self._redis.xread(
                    {stream_key(run_id): last_entry},
                    count=128,
                    block=_READ_BLOCK_MS,
                )
            except Exception as exc:  # redis errors are assorted; map to transport
                raise TransportUnavailableError("xread") from exc

            if entries:
                for _key, rows in entries:
                    for entry_id, fields in rows:
                        last_entry = _decode(entry_id)
                        raw = fields.get(EVENT_FIELD) or fields.get(
                            EVENT_FIELD.encode()
                        )
                        if raw is None:
                            continue
                        event = _parse_event(raw)
                        if event is None:
                            continue
                        # B1: stale attempt frames (pre-retry window) never
                        # reach the client, even if the reset was missed.
                        if event.attempt < detail.attempt:
                            continue
                        if cursor is not None and not _after_cursor(event, cursor):
                            continue
                        # Delivered a real frame: the client holds state, a
                        # later synthesized terminal must arrive ALONE.
                        saw_any = True
                        # B2: the first retained frame after a cursor whose
                        # seq is not cursor.seq + 1 means a trimmed gap —
                        # re-sync the client with the snapshot checkpoint.
                        # Decided exactly once, on the first frame past the
                        # cursor (no-gap resumes never snapshot).
                        if cursor is not None and not cursor_gap_snapshot_sent:
                            cursor_gap_snapshot_sent = True
                            if (event.attempt, event.seq) != (cursor[0], cursor[1] + 1):
                                snapshot = await self._resume_snapshot(
                                    run_id, detail, cursor
                                )
                                if snapshot is not None:
                                    yield snapshot
                        yield event
                continue

            # Idle tick: the row is the authority. A stream that went quiet
            # while the row is terminal (worker died before publishing, or
            # the frame was trimmed out of the window) must still reach the
            # client — synthesize the terminal from the row.
            fresh = await self._refresh_detail(detail)
            if fresh is not None:
                detail = fresh
            if is_terminal(detail.status):
                if saw_any or cursor is not None:
                    # Cursor path: the client already applied a snapshot;
                    # deliver the terminal marker alone.
                    yield _synthesize_terminal(detail)
                    return
                # Fresh subscribe, no frames at all: snapshot first so the
                # client sees the final content, then the terminal.
                yield _synthesize_snapshot(detail)
                yield _synthesize_terminal(detail)
                return
            await asyncio.sleep(_DB_POLL_SECONDS)

    async def _resume_snapshot(
        self,
        run_id: str,
        detail: InsightRunDetail,
        cursor: tuple[int, int],
    ) -> InsightEvent | None:
        """Snapshot frame for a trimmed resume: saved checkpoint, else the row.

        The saved checkpoint is the last full-state frame the worker
        published; when Redis lost it too, the authoritative DB row still
        yields a complete (though possibly newer) snapshot. The fallback's
        seq is ``cursor.seq + 1``: the trimming gap guarantees the client
        never saw it, and it sits below the next retained frame — so a
        disconnect after this frame leaves the client's cursor in a
        position where real frames still resume.
        """
        checkpoint = await self.load_checkpoint(run_id)
        if checkpoint is not None and checkpoint.attempt >= detail.attempt:
            return checkpoint
        from app.services.insight.sink import _to_snapshot_event

        return _to_snapshot_event(detail, attempt=cursor[0], seq=cursor[1] + 1)

    async def _refresh_detail(
        self, detail: InsightRunDetail
    ) -> InsightRunDetail | None:
        """Re-read the run row behind the transport; ``None`` keeps the cached one.

        The subscriber never owns a DB session — this is a callback into the
        endpoint-provided loader (see constructor wiring in the API layer),
        so the stream loop stays transport-pure and testable.
        """
        loader = getattr(self, "_detail_loader", None)
        if loader is None:
            return None
        try:
            fresh = await loader(detail.run_id)
        except Exception:  # noqa: BLE001 — DB hiccup must not kill the stream
            return None
        return fresh

    def bind_detail_loader(self, loader: Any) -> None:
        """Attach ``(run_id) -> InsightRunDetail | None`` used on idle ticks.

        The loader runs in a thread (SQLAlchemy sync session) — the async
        wrapper is the caller's responsibility.
        """
        self._detail_loader = loader


def _synthetic_seq(detail: InsightRunDetail, *, offset: int = 1) -> int:
    """Seq for synthesized frames: far above any real one, deterministic.

    Snapshot and terminal frames must never share a seq — the client
    dedupes by SSE id, and a shared id would swallow the terminal frame.
    ``offset`` separates the two (+1 snapshot / +2 terminal); both stay
    below the sink's Redis-outage fallback (+999_999). Deterministic
    values keep repeated reconnects idempotent.
    """
    return detail.attempt * 1_000_000 + offset


def _synthesize_terminal(detail: InsightRunDetail) -> InsightEvent:
    """Terminal event from the authoritative row (stream empty/trimmed)."""
    from app.schemas.insight import InsightErrorCode, make_error
    from app.services.insight.events import ErrorEvent
    from app.services.insight.sink import _to_done_event

    if detail.status.value == "completed":
        return _to_done_event(
            detail, attempt=detail.attempt, seq=_synthetic_seq(detail, offset=2)
        )
    cancelled = detail.status.value == "cancelled"
    code = (
        InsightErrorCode.CANCELLED if cancelled else InsightErrorCode.PROVIDER_UNAVAILABLE
    )
    message = "Insight run cancelled" if cancelled else "Insight run failed"
    return ErrorEvent(
        schema_version=1,
        run_id=detail.run_id,
        attempt=detail.attempt,
        seq=_synthetic_seq(detail, offset=2),
        status="cancelled" if cancelled else "failed",
        error=detail.error or make_error(code, message),
    )


def _synthesize_snapshot(detail: InsightRunDetail) -> InsightEvent:
    """Snapshot event from the authoritative row (stream empty/trimmed)."""
    from app.services.insight.sink import _to_snapshot_event

    return _to_snapshot_event(
        detail, attempt=detail.attempt, seq=_synthetic_seq(detail, offset=1)
    )
