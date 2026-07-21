"""编排器测试 fixtures。"""
import pytest
import pytest_asyncio
import fakeredis.aioredis

from app.services.ai.orchestrator.stream_bus import RedisStreamBus
from app.services.ai.orchestrator.cancel import RedisCancelRegistry, InProcessCancelRegistry
from app.services.ai.orchestrator.runner import StreamRunner


@pytest_asyncio.fixture
async def fake_redis():
    redis = fakeredis.aioredis.FakeRedis()
    yield redis
    await redis.aclose()


@pytest_asyncio.fixture
async def bus(fake_redis):
    return RedisStreamBus(fake_redis)


@pytest_asyncio.fixture
async def redis_cancel(fake_redis):
    return RedisCancelRegistry(fake_redis)


@pytest_asyncio.fixture
async def runner(bus, redis_cancel):
    return StreamRunner(bus=bus, cancel_registry=redis_cancel)


@pytest.fixture
def inprocess_cancel():
    return InProcessCancelRegistry()
