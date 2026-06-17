"""Read replica engine, circuit breaker, and request-scoped markers (BEL-73).

This module owns:

- `_build_read_engine()` — mirror of the primary engine construction in
  `app/db/session.py`, gated on `database_read_url` being non-empty.
- A module-level circuit breaker (`is_breaker_open` / `record_replica_failure` /
  `record_replica_success`) so a flaky replica doesn't take down the API.
- A `ContextVar` (`_force_primary`) that lets endpoint / service code pin
  the current request to the primary engine. This is the escape hatch for
  write-after-read scenarios where replica lag would otherwise surface stale
  data.

Failover strategy: we decide once at session construction which engine to
hand back. We do **not** swap the connection inside a `before_cursor_execute`
event — that fights SQLAlchemy's internal transaction / savepoint state
machine and breaks on `db.begin()` paths. The read session is guarded by a
`before_flush` event that raises if anything tries to INSERT/UPDATE/DELETE
on it (fail-loud is better than silent data loss on a hot-standby).

The `pool_pre_ping=True` configured in `_build_read_engine` runs a `SELECT 1`
on every checkout; its failure is the trip signal for the breaker. We do
not run a separate probe thread.
"""
from __future__ import annotations

import logging
import threading
import time
from contextvars import ContextVar
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Circuit breaker state (process-global)
# ---------------------------------------------------------------------------
_breaker_lock = threading.Lock()
_consecutive_failures: int = 0
_last_failure_ts: float = 0.0
_last_warned_count: int = 0  # to throttle the "still failing" warning

# Marker that the current request / task is pinned to primary reads.
# Set by `get_primary_db()` and the `force_primary()` context manager so
# any read-routed sub-session inside the request knows to keep using the
# primary engine.
_force_primary: ContextVar[bool] = ContextVar("force_primary", default=False)


def _build_read_engine() -> Engine | None:
    """Build the read-replica engine. Returns None when no replica configured.

    Mirrors the primary engine config in `app/db/session.py` so behavior
    is consistent (same pool sizing defaults, same connect-time options,
    same sslmode detection).
    """
    settings = get_settings()
    if not settings.database_read_url:
        return None

    url_lower = settings.database_read_url.lower()
    connect_args: dict[str, Any] = {
        "connect_timeout": 60,
        # Long read queries (e.g. monthly report aggregation) can run
        # longer than 120s; we leave the default 120s on the read side
        # for safety. Operators can raise it by setting a per-replica
        # role or by changing the value here.
        "options": "-c statement_timeout=120s -c idle_in_transaction_session_timeout=60s",
    }
    if "sslmode=require" in url_lower or "supabase.co" in url_lower:
        connect_args["sslmode"] = "require"

    engine = create_engine(
        settings.database_read_url,
        future=True,
        # pool_pre_ping is the trip signal for the circuit breaker: any
        # failed SELECT 1 on checkout raises DisconnectionError / OperationalError
        # which `get_read_db()` catches to flip the request over to primary.
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_timeout=10,
        pool_size=settings.db_read_pool_size,
        max_overflow=settings.db_read_max_overflow,
        pool_use_lifo=True,
        connect_args=connect_args,
    )
    logger.info(
        "BEL-73: read-replica engine initialized pool_size=%d max_overflow=%d",
        settings.db_read_pool_size,
        settings.db_read_max_overflow,
    )
    return engine


# ---------------------------------------------------------------------------
# Circuit breaker API
# ---------------------------------------------------------------------------
def is_breaker_open() -> bool:
    """True when subsequent reads should skip the replica and go to primary.

    Two open conditions:
    1. `_consecutive_failures >= replica_failure_threshold` AND
    2. The cooldown window has not yet elapsed since the last failure.

    After the cooldown elapses, the breaker resets to "half-open" (returns
    False so the next request tries the replica again; if it fails we trip
    the breaker once more).
    """
    settings = get_settings()
    with _breaker_lock:
        if _consecutive_failures < settings.replica_failure_threshold:
            return False
        if time.monotonic() - _last_failure_ts > settings.replica_cooldown_seconds:
            # Cooldown elapsed: allow one probe (returned via get_read_db's
            # lazy attempt). If the probe succeeds, record_replica_success
            # will clear the counter.
            return False
        return True


def record_replica_failure() -> None:
    """Trip / increment the breaker on a read-engine error."""
    global _consecutive_failures, _last_failure_ts, _last_warned_count
    settings = get_settings()
    with _breaker_lock:
        _consecutive_failures += 1
        _last_failure_ts = time.monotonic()
        # Throttle warnings: log on first failure, then every 10th.
        if _consecutive_failures == 1 or _consecutive_failures % 10 == 0:
            logger.warning(
                "BEL-73: replica failure count=%d threshold=%d cooldown=%ds",
                _consecutive_failures,
                settings.replica_failure_threshold,
                settings.replica_cooldown_seconds,
            )
            _last_warned_count = _consecutive_failures


def record_replica_success() -> None:
    """Clear the breaker after a successful read-engine round trip."""
    global _consecutive_failures, _last_warned_count
    with _breaker_lock:
        if _consecutive_failures > 0:
            logger.info(
                "BEL-73: replica recovered after %d failures", _consecutive_failures
            )
            _consecutive_failures = 0
            _last_warned_count = 0


def reset_breaker() -> None:
    """Reset the breaker to closed state. For tests only."""
    global _consecutive_failures, _last_failure_ts, _last_warned_count
    with _breaker_lock:
        _consecutive_failures = 0
        _last_failure_ts = 0.0
        _last_warned_count = 0


def get_breaker_snapshot() -> dict[str, int | float]:
    """Read-only view of the breaker state. For /health and tests."""
    with _breaker_lock:
        return {
            "consecutive_failures": _consecutive_failures,
            "last_failure_age_seconds": (
                time.monotonic() - _last_failure_ts if _last_failure_ts else 0.0
            ),
        }
