"""AI Chat stream cancel registry.

Process-local `dict[conversation_id, threading.Event]`. Each active stream
endpoint registers an event on entry and clears it on exit. The cancel
endpoint signals the event, which the streaming generator observes between
yields and uses to break out of the LLM loop and close the httpx client.

Process-local means a cancel only works on the same worker process that
handles both the stream and the cancel. Multi-worker deployments
(supervisord / uvicorn workers > 1) need either:

  - sticky session routing so the same worker handles both requests; or
  - a Redis-backed cancel signal (out of scope for this change, tracked
    under BEL-62 follow-up).

The frontend Next.js route handler already short-circuits local fetches via
AbortController, so cancel latency is bounded by the polling interval in
the stream generator (50ms).
"""
from __future__ import annotations

import threading
from typing import Dict

# Key: conversation_id (int). Value: threading.Event set when cancel is requested.
_streams: Dict[int, threading.Event] = {}
_streams_lock = threading.Lock()


def register(conversation_id: int) -> threading.Event:
    """Register an active stream and return its cancel event.

    The streaming generator calls this in its first yield, and the cleanup
    path (try/finally) calls `unregister`. If another stream is already
    registered for the same conversation_id, the existing event is reused
    (conservative — avoids accidentally unblocking a previous stream).
    """
    with _streams_lock:
        event = _streams.get(conversation_id)
        if event is None:
            event = threading.Event()
            _streams[conversation_id] = event
        return event


def unregister(conversation_id: int, event: threading.Event) -> None:
    """Remove the event from the registry, but only if it's the same event we registered.

    Idempotent: safe to call from multiple cleanup paths.
    """
    with _streams_lock:
        current = _streams.get(conversation_id)
        if current is event:
            _streams.pop(conversation_id, None)


def request_cancel(conversation_id: int) -> bool:
    """Signal the cancel event for a conversation. Returns True if a stream was active."""
    with _streams_lock:
        event = _streams.get(conversation_id)
        if event is None:
            return False
        event.set()
        return True
