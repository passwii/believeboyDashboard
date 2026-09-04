"""Redis 客户端工厂(async)。

提供两个入口:
- ``get_async_redis_client(db)``: 带连接池的 async 单例,生产路径用这个。
- ``create_redis_client(...)``: 向后兼容的裸工厂(无池),仅测试/特殊场景用。

Celery 已在用 Redis(broker db+1, result db+2),
AI chat stream 用 db+3(避免冲突)。
"""
from __future__ import annotations

import asyncio
import logging

from redis.asyncio import Redis
from redis.asyncio import ConnectionPool as AsyncConnectionPool

from app.core.config import get_settings

logger = logging.getLogger(__name__)

# 默认连接池配置
ASYNC_POOL_MAX_CONNECTIONS = 10
ASYNC_POOL_SOCKET_CONNECT_TIMEOUT = 5
ASYNC_POOL_SOCKET_TIMEOUT = 5

# 按 db 分桶的单例缓存（通常只有 db=3 一个桶）
_async_clients: dict[int, Redis] = {}
_async_lock = asyncio.Lock()


def create_redis_client(
    host: str = "localhost",
    port: int = 6379,
    password: str = "",
    db: int = 0,
) -> Redis:
    """创建 async Redis 客户端（无连接池，向后兼容）。

    生产代码请用 ``get_async_redis_client()``。
    """
    kwargs: dict = {"host": host, "port": port, "db": db}
    if password:
        kwargs["password"] = password
    return Redis(**kwargs)


async def get_async_redis_client(db: int | None = None) -> Redis:
    """获取带连接池的 async Redis 单例（按 db 分桶）。

    首次调用时创建连接池并验证连通性；后续调用直接返回缓存实例。
    协程安全由 asyncio.Lock 保证（同一事件循环内）。
    """
    settings = get_settings()
    effective_db = db if db is not None else settings.redis_db

    if effective_db in _async_clients:
        return _async_clients[effective_db]

    async with _async_lock:
        # 双重检查
        if effective_db in _async_clients:
            return _async_clients[effective_db]

        kwargs: dict = {
            "host": settings.redis_host,
            "port": settings.redis_port,
            "db": effective_db,
            "max_connections": ASYNC_POOL_MAX_CONNECTIONS,
            "socket_connect_timeout": ASYNC_POOL_SOCKET_CONNECT_TIMEOUT,
            "socket_timeout": ASYNC_POOL_SOCKET_TIMEOUT,
            "retry_on_timeout": True,
        }
        if settings.redis_password:
            kwargs["password"] = settings.redis_password

        pool = AsyncConnectionPool(**kwargs)
        client = Redis(connection_pool=pool)
        # 首次连接验证
        await client.ping()
        _async_clients[effective_db] = client
        logger.info("Async Redis client created for db=%d", effective_db)
        return client


async def close_async_redis_clients() -> None:
    """关闭所有 async Redis 客户端及其连接池（应用关闭时调用）。"""
    async with _async_lock:
        for db, client in _async_clients.items():
            try:
                await client.aclose()
            except Exception:
                pass
            logger.info("Async Redis client closed for db=%d", db)
        _async_clients.clear()
