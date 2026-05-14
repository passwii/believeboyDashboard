"""Redis connection/pool management, presence, and session management."""

import json
import logging
from datetime import UTC, datetime
from typing import Any

import redis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_redis_client: redis.Redis | None = None

# Presence
PRESENCE_KEY_PREFIX = "presence:user:"
PRESENCE_TTL_SECONDS = 90

# Session
SESSION_KEY_PREFIX = "session:"
SESSION_TTL_SECONDS = 8 * 3600  # 8 hours


def get_redis_client() -> redis.Redis:
    """获取 Redis 客户端。使用连接池，支持自动重连。

    如果现有连接已断开，会自动关闭并重建客户端。
    """
    global _redis_client
    if _redis_client is not None:
        try:
            _redis_client.ping()
            return _redis_client
        except (redis.ConnectionError, redis.TimeoutError, OSError):
            logger.warning("Redis connection lost, reconnecting...")
            try:
                _redis_client.close()
            except Exception:
                pass
            _redis_client = None

    settings = get_settings()
    pool = redis.ConnectionPool(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        db=settings.redis_db,
        decode_responses=True,
        max_connections=20,
        retry_on_timeout=True,
        socket_connect_timeout=5,
        socket_timeout=5,
        health_check_interval=30,
    )
    _redis_client = redis.Redis(connection_pool=pool)
    # 首次连接验证
    _redis_client.ping()
    return _redis_client


def close_redis_client() -> None:
    global _redis_client
    if _redis_client is not None:
        _redis_client.close()
        _redis_client = None


# ── Presence ───────────────────────────────────────────────────────────


def _get_presence_key(user_id: str) -> str:
    return f"{PRESENCE_KEY_PREFIX}{user_id}"


def set_user_presence(
    user_id: str,
    display_name: str,
    email: str | None,
    avatar_url: str | None,
    current_path: str,
    current_page_title: str,
) -> None:
    client = get_redis_client()
    data = {
        "user_id": user_id,
        "display_name": display_name,
        "email": email,
        "avatar_url": avatar_url,
        "current_path": current_path,
        "current_page_title": current_page_title,
        "last_seen_at": datetime.now(UTC).isoformat(),
    }
    client.setex(
        _get_presence_key(user_id),
        PRESENCE_TTL_SECONDS,
        json.dumps(data, ensure_ascii=False),
    )


def get_all_presence(stale_after_seconds: int = 90) -> list[dict[str, Any]]:
    client = get_redis_client()
    # 使用 SCAN 替代 KEYS，避免阻塞
    keys: list[str] = []
    cursor = 0
    while True:
        cursor, batch = client.scan(cursor, match=f"{PRESENCE_KEY_PREFIX}*", count=500)
        keys.extend(batch)
        if cursor == 0:
            break
    if not keys:
        return []

    now = datetime.now(UTC).timestamp()
    stale_cutoff = now - stale_after_seconds
    results = []

    for key in keys:
        data = client.get(key)
        if data is None:
            continue
        try:
            parsed = json.loads(data)
            last_seen = parsed.get("last_seen_at", "")
            if last_seen:
                ts = datetime.fromisoformat(
                    last_seen.replace("Z", "+00:00")
                ).timestamp()
                if ts >= stale_cutoff:
                    results.append(parsed)
        except (json.JSONDecodeError, ValueError):
            continue

    results.sort(key=lambda x: x.get("last_seen_at", ""), reverse=True)
    return results


# ── Sessions ───────────────────────────────────────────────────────────


def _session_key(user_id: str, session_id: str) -> str:
    return f"{SESSION_KEY_PREFIX}{user_id}:{session_id}"


def write_session(user_id: str, session_id: str) -> None:
    client = get_redis_client()
    client.setex(_session_key(user_id, session_id), SESSION_TTL_SECONDS, "1")


def validate_session(user_id: str, session_id: str) -> bool:
    client = get_redis_client()
    key = _session_key(user_id, session_id)
    if not client.exists(key):
        return False
    client.expire(key, SESSION_TTL_SECONDS)
    return True


def delete_user_sessions(user_id: str) -> int:
    from app.services.infra.cache import cache_delete_pattern

    pattern = f"{SESSION_KEY_PREFIX}{user_id}:*"
    return cache_delete_pattern(pattern)


def revoke_session(user_id: str, session_id: str) -> bool:
    client = get_redis_client()
    key = _session_key(user_id, session_id)
    return bool(client.delete(key))
