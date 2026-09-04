"""Redis connection/pool management, presence, and session management."""

import json
import logging
import threading
from datetime import UTC, datetime
from typing import Any

import redis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# 默认连接池配置(供 get_redis_client 与 health probe 共享)
REDIS_POOL_MAX_CONNECTIONS = 20
REDIS_POOL_SOCKET_CONNECT_TIMEOUT = 5
REDIS_POOL_SOCKET_TIMEOUT = 5
REDIS_POOL_HEALTH_CHECK_INTERVAL = 30


def _p(suffix: str) -> str:
    """给 Redis key 加上全局前缀: ``{prefix}:{suffix}``。"""
    return f"{get_settings().redis_key_prefix}:{suffix}"


# Presence
PRESENCE_KEY_PREFIX = _p("presence:user:")
PRESENCE_TTL_SECONDS = 90

# Session
SESSION_KEY_PREFIX = _p("session:")
SESSION_TTL_SECONDS = 8 * 3600  # 8 hours


# 单例客户端 + 锁,避免多线程并发首次创建时出现多个 ConnectionPool
_redis_client: redis.Redis | None = None
_redis_lock = threading.Lock()


def _build_connection_pool(
    *,
    socket_timeout: int = REDIS_POOL_SOCKET_TIMEOUT,
    socket_connect_timeout: int = REDIS_POOL_SOCKET_CONNECT_TIMEOUT,
    health_check_interval: int = REDIS_POOL_HEALTH_CHECK_INTERVAL,
) -> redis.ConnectionPool:
    """构造一个连接池。health probe 路径可以传入更短的 timeout 复用同一配置结构。"""
    settings = get_settings()
    return redis.ConnectionPool(
        host=settings.redis_host,
        port=settings.redis_port,
        password=settings.redis_password or None,
        db=settings.redis_db,
        decode_responses=True,
        max_connections=REDIS_POOL_MAX_CONNECTIONS,
        retry_on_timeout=True,
        socket_connect_timeout=socket_connect_timeout,
        socket_timeout=socket_timeout,
        health_check_interval=health_check_interval,
    )


def _disconnect_pool(client: redis.Redis | None) -> None:
    """显式释放客户端关联的连接池,避免半开 socket 残留。"""
    if client is None:
        return
    pool = getattr(client, "connection_pool", None)
    if pool is not None:
        try:
            pool.disconnect()
        except Exception:
            pass


def get_redis_client() -> redis.Redis:
    """获取 Redis 客户端。使用连接池，支持自动重连。

    热路径直接返回已有客户端（连接池的 ``health_check_interval=30`` +
    ``retry_on_timeout=True`` 已提供自动探活与重连）。仅在连接池抛出
    ``ConnectionError`` / ``TimeoutError`` 时才由 ``retry_on_timeout`` 自动
    重建底层连接，无需外层 ping 探测。

    线程安全:首次创建受 ``_redis_lock`` 保护,避免多线程并发冷启动时产生
    多个 ``ConnectionPool`` 实例。
    """
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    with _redis_lock:
        if _redis_client is not None:
            return _redis_client

        pool = _build_connection_pool()
        _redis_client = redis.Redis(connection_pool=pool)
        # 首次连接验证（仅冷启动一次）
        _redis_client.ping()
        return _redis_client


def close_redis_client() -> None:
    """关闭并释放 Redis 客户端与其连接池。"""
    global _redis_client
    with _redis_lock:
        if _redis_client is not None:
            _disconnect_pool(_redis_client)
            try:
                _redis_client.close()
            except Exception:
                pass
            _redis_client = None


def make_redis_probe_client(
    *,
    socket_timeout: int = 2,
    socket_connect_timeout: int = 2,
    health_check_interval: int = 0,
) -> redis.Redis:
    """构造一个用于健康检查/低频运维探测的轻量客户端。

    区别于 ``get_redis_client()`` 返回的全局单例,本工厂:
    - 总是返回新实例,不占用主连接池
    - 默认更短的 timeout(2s),避免 health probe 被长 socket_timeout 拖死
    - ``health_check_interval=0`` 关闭 PING 探活,降低探测自身开销
    """
    pool = _build_connection_pool(
        socket_timeout=socket_timeout,
        socket_connect_timeout=socket_connect_timeout,
        health_check_interval=health_check_interval,
    )
    return redis.Redis(connection_pool=pool)


def is_redis_available() -> bool:
    """判断 Redis 是否"配置且可达"。

    单一来源,用于替代散落在各处的 ``if not settings.redis_host`` /
    ``try: get_redis_client() except: ...`` 判断。注意:此函数会做一次
    ``ping()``(网络 RTT),请勿在每请求热路径上无脑调用——只在:
      - 应用启动健康检查
      - 一次会话内首次写入前的懒加载
    等"开销可接受"的场景使用。
    """
    settings = get_settings()
    if not settings.redis_host:
        return False
    try:
        client = get_redis_client()
        client.ping()
        return True
    except Exception as exc:
        logger.warning("Redis availability check failed: %s", exc)
        return False


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

    # Pipeline 批量读取，避免 N+1 网络往返
    pipe = client.pipeline()
    for key in keys:
        pipe.get(key)
    values = pipe.execute()

    now = datetime.now(UTC).timestamp()
    stale_cutoff = now - stale_after_seconds
    results = []

    for data in values:
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


# Lua: 检查 key 是否存在，存在则刷新 TTL 并返回 1，否则返回 0。单次往返。
_VALIDATE_SESSION_LUA = """
if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return 1
end
return 0
"""


def validate_session(user_id: str, session_id: str) -> bool:
    client = get_redis_client()
    key = _session_key(user_id, session_id)
    return bool(client.eval(_VALIDATE_SESSION_LUA, 1, key, SESSION_TTL_SECONDS))


def delete_user_sessions(user_id: str) -> int:
    from app.services.infra.cache import cache_delete_pattern

    pattern = f"{SESSION_KEY_PREFIX}{user_id}:*"
    return cache_delete_pattern(pattern)


def revoke_session(user_id: str, session_id: str) -> bool:
    client = get_redis_client()
    key = _session_key(user_id, session_id)
    return bool(client.delete(key))
