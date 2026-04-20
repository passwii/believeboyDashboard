"""
Rate limiting for auth endpoints using Redis as backend.

Redis is preferred; falls back to in-memory if Redis is unavailable.
Redis counters survive server restarts via Redis persistence.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Literal

logger = logging.getLogger(__name__)


def _rate_limit_key(limit_type: str, identifier: str) -> str:
    return f"ratelimit:{limit_type}:{identifier}"


def _redis_client():
    from app.services.redis_service import get_redis_client

    try:
        return get_redis_client()
    except Exception:
        return None


def increment_and_check(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    """
    Atomically increment a counter and check against limit.
    Returns (attempts, retry_after_seconds).  retry_after_seconds is 0 if under limit.
    """
    client = _redis_client()
    if client is None:
        return _in_memory_check(limit_type, identifier, max_requests, window_seconds)

    key = _rate_limit_key(limit_type, identifier)
    try:
        pipe = client.pipeline()
        now = time.time()
        window_start = now - window_seconds

        pipe.zremrangebyscore(key, 0, window_start)
        pipe.zadd(key, {str(now): now})
        pipe.zcard(key)
        pipe.expire(key, window_seconds + 10)
        results = pipe.execute()
        count = results[2]

        if count > max_requests:
            oldest = client.zrange(key, 0, 0, withscores=True)
            retry_after = int(oldest[0][1] + window_seconds - now) if oldest else window_seconds
            return count, max(retry_after, 1)

        return count, 0
    except Exception:
        logger.warning("Redis rate limit unavailable, falling back to in-memory")
        return _in_memory_check(limit_type, identifier, max_requests, window_seconds)


# ─── In-memory fallback ───────────────────────────────────────────────────────

_IN_MEMORY: dict[str, tuple[int, float]] = {}
_MEMORY_LOCK = threading.Lock()


def _in_memory_check(
    limit_type: str,
    identifier: str,
    max_requests: int,
    window_seconds: int,
) -> tuple[int, int]:
    key = f"{limit_type}:{identifier}"
    now = time.time()
    with _MEMORY_LOCK:
        entry = _IN_MEMORY.get(key)
        if entry is None or (now - entry[1]) > window_seconds:
            _IN_MEMORY[key] = (1, now)
            return 1, 0
        count, start = entry
        if count >= max_requests:
            elapsed = now - start
            return count, int(window_seconds - elapsed)
        _IN_MEMORY[key] = (count + 1, start)
        return count + 1, 0


def clear_key(limit_type: str, identifier: str) -> None:
    """Remove a rate-limit key (e.g. after successful login clears failed-attempt counter)."""
    client = _redis_client()
    if client is not None:
        try:
            key = _rate_limit_key(limit_type, identifier)
            client.delete(key)
        except Exception:
            pass
