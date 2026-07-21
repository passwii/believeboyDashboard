"""CancelRegistry — 取消信号注册表。

接口 + 两个实现:
- RedisCancelRegistry:  生产用,Redis live key(GETDEL 跨 worker)
- InProcessCancelRegistry: 单测/降级用,进程内 asyncio.Event

对应 V2 spec §6.4。
"""
from __future__ import annotations

import asyncio
from typing import Protocol, runtime_checkable

from redis.asyncio import Redis

from app.core.config import get_settings


def _live_key(conv_id: int) -> str:
    return f"{get_settings().ai_chat_stream_prefix}:{conv_id}:live"


@runtime_checkable
class CancelRegistry(Protocol):
    """取消信号注册表接口。"""

    async def register(self, conv_id: int) -> None:
        """标记一个活跃流。"""
        ...

    async def is_live(self, conv_id: int) -> bool:
        """检查流是否仍活跃(False = 已取消)。"""
        ...

    async def request_cancel(self, conv_id: int) -> bool:
        """请求取消。返回 True 如果有活跃流被取消。"""
        ...


class RedisCancelRegistry:
    """生产实现:Redis live key。跨 worker 天然生效。

    - register:       SET ai:chat:{conv_id}:live 1
    - is_live:        EXISTS ai:chat:{conv_id}:live
    - request_cancel: GETDEL ai:chat:{conv_id}:live
    """

    def __init__(self, redis: Redis):
        self._redis = redis

    async def register(self, conv_id: int) -> None:
        await self._redis.set(_live_key(conv_id), 1)

    async def is_live(self, conv_id: int) -> bool:
        return await self._redis.exists(_live_key(conv_id)) > 0

    async def request_cancel(self, conv_id: int) -> bool:
        result = await self._redis.getdel(_live_key(conv_id))
        return result is not None


class InProcessCancelRegistry:
    """降级/单测实现:进程内 asyncio.Event。

    无 Redis 依赖;单测更快更确定。
    同一进程内即时生效(无跨 worker 能力)。
    """

    def __init__(self):
        self._events: dict[int, asyncio.Event] = {}

    async def register(self, conv_id: int) -> None:
        self._events[conv_id] = asyncio.Event()
        self._events[conv_id].set()  # 初始 = 活跃

    async def is_live(self, conv_id: int) -> bool:
        ev = self._events.get(conv_id)
        return ev.is_set() if ev else False

    async def request_cancel(self, conv_id: int) -> bool:
        ev = self._events.get(conv_id)
        if ev is None or not ev.is_set():
            return False
        ev.clear()
        return True

    async def unregister(self, conv_id: int) -> None:
        self._events.pop(conv_id, None)
