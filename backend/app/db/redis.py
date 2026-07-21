"""Redis 客户端工厂(async)。

复用 settings.redis_* 配置。Celery 已在用 Redis(broker db+1, result db+2),
AI chat stream 用 db+3(避免冲突)。
"""
from __future__ import annotations

from redis.asyncio import Redis


def create_redis_client(
    host: str = "localhost",
    port: int = 6379,
    password: str = "",
    db: int = 0,
) -> Redis:
    """创建 async Redis 客户端。"""
    kwargs: dict = {"host": host, "port": port, "db": db}
    if password:
        kwargs["password"] = password
    return Redis(**kwargs)
