"""Redis-backed distributed semaphore helpers for AI insight generation."""

from __future__ import annotations

import contextlib
import logging
import time
import uuid
from contextlib import AbstractContextManager

from redis import Redis

from app.core.config import Settings, get_settings
from app.services.infra.redis import get_redis_client

logger = logging.getLogger(__name__)

ACQUIRE_SCRIPT = """
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local token = ARGV[2]
local now = tonumber(ARGV[3])
local ttl_ms = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) < limit then
    redis.call('ZADD', key, now + ttl_ms, token)
    redis.call('PEXPIRE', key, ttl_ms)
    return 1
end
return 0
"""

RELEASE_SCRIPT = """
local key = KEYS[1]
local token = ARGV[1]
return redis.call('ZREM', key, token)
"""

DEFAULT_LEASE_SECONDS = 15 * 60



@contextlib.contextmanager
def acquire_remote_semaphore(
    name: str,
    *,
    timeout: float = 300,
    max_concurrent: int | None = None,
    lease_seconds: int = DEFAULT_LEASE_SECONDS,
) -> AbstractContextManager[bool]:
    """Acquire a Redis-backed semaphore slot.

    Returns a context manager yielding ``True`` when a slot was acquired and
    ``False`` when the timeout elapsed. Expired tokens are reclaimed on every
    acquire attempt, so a killed worker eventually frees its slot.
    """
    settings = get_settings()
    limit = max_concurrent or settings.max_concurrent_insights
    client = get_redis_client()
    key = f"semaphore:ai_insights:{name}"
    token = str(uuid.uuid4())
    ttl_ms = int(lease_seconds * 1000)
    deadline = time.monotonic() + timeout
    acquired = False

    try:
        while True:
            if _try_acquire(
                client=client,
                key=key,
                token=token,
                limit=limit,
                ttl_ms=ttl_ms,
            ):
                acquired = True
                yield True
                return

            if time.monotonic() >= deadline:
                logger.warning(
                    "Could not acquire Redis semaphore %s within %.1fs",
                    key,
                    timeout,
                )
                yield False
                return

            time.sleep(0.25)
    finally:
        if acquired:
            release_remote_semaphore(client, key, token)


def release_remote_semaphore(client: Redis, key: str, token: str) -> None:
    client.eval(RELEASE_SCRIPT, 1, key, token)


def _try_acquire(
    *,
    client: Redis,
    key: str,
    token: str,
    limit: int,
    ttl_ms: int,
) -> bool:
    now_ms = int(time.time() * 1000)
    result = client.eval(ACQUIRE_SCRIPT, 1, key, limit, token, now_ms, ttl_ms)
    return bool(result)
