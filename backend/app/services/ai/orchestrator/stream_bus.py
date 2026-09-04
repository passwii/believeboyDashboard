"""RedisStreamBus — 基于 Redis Stream 的事件总线。

核心操作:
- start(conv_id):   SET live_key + XADD begin 标记
- stop(conv_id):     XADD end 标记 + DEL live_key + EXPIRE stream
- add(conv_id, ev):  XADD ProtocolEvent
- listen(conv_id):   XREAD 订阅(generator,遇 end 停止)
- is_live(conv_id):  EXISTS live_key

对应 V2 spec §6.3。
"""
from __future__ import annotations

import json
import logging
from typing import AsyncGenerator

from redis.asyncio import Redis

from app.core.config import get_settings
from app.services.ai.protocol.events import ProtocolEvent

logger = logging.getLogger(__name__)


def _stream_key(conv_id: int) -> str:
    return f"{get_settings().ai_chat_stream_prefix}:{conv_id}"


def _live_key(conv_id: int) -> str:
    return f"{get_settings().ai_chat_stream_prefix}:{conv_id}:live"


class RedisStreamBus:
    """Redis Stream 事件总线。"""

    def __init__(self, redis: Redis):
        self._redis = redis

    async def start(self, conv_id: int) -> None:
        """标记流活跃 + 发 begin 标记。"""
        settings = get_settings()
        await self._redis.set(_live_key(conv_id), 1)
        await self._redis.xadd(_stream_key(conv_id), {
            "type": "begin",
            "data": json.dumps({"conversation_id": conv_id}),
        }, maxlen=settings.ai_chat_stream_maxlen)

    async def stop(self, conv_id: int) -> None:
        """发 end 标记 + DEL live_key + EXPIRE stream。"""
        settings = get_settings()
        await self._redis.xadd(_stream_key(conv_id), {
            "type": "end",
            "data": "{}",
        }, maxlen=settings.ai_chat_stream_maxlen)
        await self._redis.delete(_live_key(conv_id))
        await self._redis.expire(_stream_key(conv_id), settings.ai_chat_stream_ttl_seconds)

    async def add(self, conv_id: int, event: ProtocolEvent) -> str:
        """把 ProtocolEvent 写入 Stream,返回 entry_id。"""
        settings = get_settings()
        entry_id = await self._redis.xadd(_stream_key(conv_id), {
            "type": "event",
            "data": event.model_dump_json(),
        }, maxlen=settings.ai_chat_stream_maxlen)
        return entry_id if isinstance(entry_id, str) else entry_id.decode()

    async def is_live(self, conv_id: int) -> bool:
        """检查流是否仍活跃(live_key 存在 = 未取消)。"""
        return await self._redis.exists(_live_key(conv_id)) > 0

    async def listen(
        self, conv_id: int, from_id: str = "0"
    ) -> AsyncGenerator[tuple[str, str, str], None]:
        """订阅 Stream,yield (entry_id, type, data_json)。遇 type=end 停止。"""
        last_id = from_id
        while True:
            res = await self._redis.xread({_stream_key(conv_id): last_id}, block=500)
            if not res:
                # 无新事件;若流已结束,读剩余历史后退出
                if not await self.is_live(conv_id):
                    remaining = await self._redis.xrange(_stream_key(conv_id), min=last_id, max="+")
                    for eid, fields in remaining:
                        eid_str = eid if isinstance(eid, str) else eid.decode()
                        if eid_str <= last_id:
                            continue
                        t = _decode_field(fields, "type")
                        d = _decode_field(fields, "data")
                        if t == "end":
                            return
                        yield eid_str, t, d
                    return
                continue

            for _stream, entries in res:
                for entry_id, fields in entries:
                    eid = entry_id if isinstance(entry_id, str) else entry_id.decode()
                    last_id = eid
                    t = _decode_field(fields, "type")
                    d = _decode_field(fields, "data")
                    if t == "end":
                        return
                    yield eid, t, d


def _decode_field(fields: dict, key: str) -> str:
    """从 Redis Stream fields dict 解码字节/字符串。"""
    first_key = next(iter(fields.keys()), None)
    actual_key = key.encode() if isinstance(first_key, bytes) else key
    val = fields.get(actual_key)
    if val is None:
        return ""
    return val.decode() if isinstance(val, bytes) else val
