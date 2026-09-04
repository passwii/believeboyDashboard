"""RedisStreamBus 单测。"""
import pytest

from app.db.redis import create_redis_client
from app.services.ai.protocol.events import MessageStart, MessageStop


def test_create_redis_client_returns_async_redis():
    """工厂返回 redis.asyncio.Redis 实例。"""
    client = create_redis_client(host="localhost", port=6379, password="", db=0)
    assert client is not None
    assert hasattr(client, "xadd")
    assert hasattr(client, "xread")
    assert hasattr(client, "aclose")


@pytest.mark.asyncio
async def test_bus_start_sets_live_key_and_begin_entry(bus, fake_redis):
    """start(): SET live_key + XADD begin 标记。"""
    await bus.start(42)
    assert await fake_redis.exists("ai:chat:42:live") == 1
    entries = await fake_redis.xrange("ai:chat:42")
    assert len(entries) == 1
    _, fields = entries[0]
    assert fields[b"type"] == b"begin"


@pytest.mark.asyncio
async def test_bus_stop_deletes_live_key_and_adds_end(bus, fake_redis):
    """stop(): XADD end + DEL live_key + EXPIRE stream。"""
    await bus.start(42)
    await bus.stop(42)
    assert await fake_redis.exists("ai:chat:42:live") == 0
    entries = await fake_redis.xrange("ai:chat:42")
    types = [f[b"type"] for _, f in entries]
    assert b"end" in types


@pytest.mark.asyncio
async def test_bus_add_event_returns_entry_id(bus):
    """add(): 写入 ProtocolEvent,返回 entry_id。"""
    await bus.start(42)
    ev = MessageStart(message_id="m1", model="gpt-4", created_at=1700000000000)
    entry_id = await bus.add(42, ev)
    assert isinstance(entry_id, str)
    assert "-" in entry_id


@pytest.mark.asyncio
async def test_bus_is_live_true_after_start(bus):
    await bus.start(42)
    assert await bus.is_live(42) is True


@pytest.mark.asyncio
async def test_bus_is_live_false_after_stop(bus):
    await bus.start(42)
    await bus.stop(42)
    assert await bus.is_live(42) is False


@pytest.mark.asyncio
async def test_bus_listen_yields_events(bus):
    """listen() yield 所有条目(含 begin),遇 end 自动停止(不 yield end)。"""
    await bus.start(42)
    ev1 = MessageStart(message_id="m1", model="gpt-4", created_at=1700000000000)
    await bus.add(42, ev1)
    await bus.stop(42)  # 加 end 标记

    events = []
    async for entry_id, entry_type, data in bus.listen(42):
        events.append((entry_type, data))

    # begin 被 yield(过滤在 subscribe 层),end 触发 return(不 yield)
    assert any(t == "begin" for t, _ in events)
    assert any(t == "event" for t, _ in events)
    assert not any(t == "end" for t, _ in events)  # end 不 yield,generator 直接停止
