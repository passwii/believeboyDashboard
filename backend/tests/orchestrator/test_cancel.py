"""CancelRegistry 单测:Redis + InProcess 双实现。"""
import pytest

from app.services.ai.orchestrator.cancel import (
    RedisCancelRegistry,
    InProcessCancelRegistry,
)


# ── Redis 实现 ──

@pytest.mark.asyncio
async def test_redis_register_sets_live_key(redis_cancel, fake_redis):
    await redis_cancel.register(42)
    assert await fake_redis.exists("ai:chat:42:live") == 1


@pytest.mark.asyncio
async def test_redis_is_live_true_after_register(redis_cancel):
    await redis_cancel.register(42)
    assert await redis_cancel.is_live(42) is True


@pytest.mark.asyncio
async def test_redis_cancel_returns_true(redis_cancel):
    await redis_cancel.register(42)
    cancelled = await redis_cancel.request_cancel(42)
    assert cancelled is True


@pytest.mark.asyncio
async def test_redis_is_live_false_after_cancel(redis_cancel):
    await redis_cancel.register(42)
    await redis_cancel.request_cancel(42)
    assert await redis_cancel.is_live(42) is False


@pytest.mark.asyncio
async def test_redis_cancel_not_active_returns_false(redis_cancel):
    """取消不存在的流 → False。"""
    cancelled = await redis_cancel.request_cancel(999)
    assert cancelled is False


@pytest.mark.asyncio
async def test_redis_double_cancel_returns_false(redis_cancel):
    """二次取消已取消的流 → False。"""
    await redis_cancel.register(42)
    await redis_cancel.request_cancel(42)
    cancelled2 = await redis_cancel.request_cancel(42)
    assert cancelled2 is False


# ── InProcess 实现 ──

@pytest.mark.asyncio
async def test_inprocess_register_sets_active(inprocess_cancel):
    await inprocess_cancel.register(42)
    assert await inprocess_cancel.is_live(42) is True


@pytest.mark.asyncio
async def test_inprocess_cancel_returns_true(inprocess_cancel):
    await inprocess_cancel.register(42)
    assert await inprocess_cancel.request_cancel(42) is True
    assert await inprocess_cancel.is_live(42) is False


@pytest.mark.asyncio
async def test_inprocess_cancel_not_active_returns_false(inprocess_cancel):
    assert await inprocess_cancel.request_cancel(999) is False


@pytest.mark.asyncio
async def test_inprocess_double_cancel_returns_false(inprocess_cancel):
    await inprocess_cancel.register(42)
    await inprocess_cancel.request_cancel(42)
    assert await inprocess_cancel.request_cancel(42) is False
