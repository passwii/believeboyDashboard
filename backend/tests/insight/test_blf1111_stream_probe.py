"""BLF-1111：SSE 空闲期不得停读（传输探针，场景 A / B）。

现象（真实 run，两个独立客户端一致）：正文 100 帧在 Redis 里是 11.3s→13.0s
逐帧写入的，客户端却在 14.55s **一次性收到全部**，done 在 14.74s——首帧投递滞后
3.3s、到达跨度 0.0s。

根因是 ``_replay_and_follow`` 的空闲分支：``XREAD BLOCK`` 返回空后会
``await asyncio.sleep(_DB_POLL_SECONDS)``，**连读流一起停了**——live tail 只能按
~7s（2s block + 5s sleep）的节拍推进，睡眠期间写进来的帧醒来后一次投完。屏幕
后果是「空白 ~15s → 整篇一次性出现」（ledger 面板）。

这里的探针是 issue 验收 §2 指定的回归用例（真实 ``InsightStreamSubscriber`` +
合成 producer，不涉及 LLM）：

- 场景 A：订阅后静默超过 ``_DB_POLL_SECONDS``，再逐帧发布 → 修复前首帧滞后
  ~2098ms（p50 1186ms）、到达跨度 **0.0s**；修复后应 < 300ms 且跨度 ≈ 发布跨度。
- 场景 B（对照）：把 ``_DB_POLL_SECONDS`` 调到远小于帧间隔，结构与 A 一致 ——
  证明投递节拍已与 DB 回读周期解耦。

用 fakeredis：其阻塞 ``XREAD`` 在 ``XADD`` 时立即唤醒（实测 0.4ms，与 issue 里
场景 B 的 0.4ms 同量级），所以这里量到的是订阅者的行为，不是替身的假象。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from uuid import uuid4

import fakeredis.aioredis
import pytest
import pytest_asyncio

from app.schemas.insight import (
    InsightError,
    InsightErrorCode,
    InsightResumeInfo,
    InsightRunDetail,
    InsightStage,
    InsightStatus,
    make_error,
)
from app.services.insight import subscriber as subscriber_module
from app.services.insight.events import ErrorEvent
from app.services.insight.stream_bus import EVENT_FIELD, stream_key
from app.services.insight.subscriber import InsightStreamSubscriber

#: 场景帧数 / 间隔：与 issue 里的探针一致（20 帧 @100ms ≈ 1.9s 发布跨度）。
_FRAMES = 20
_INTERVAL = 0.1

#: 首帧投递滞后上限 / 到达跨度下限。修复前分别是 ~2098ms 与 0.0s，中间没有灰区，
#: 所以这两个门槛既不会误报、也不会漏掉回归。
_MAX_FIRST_FRAME_LAG = 0.3
_MIN_ARRIVAL_SPAN = 1.5


@pytest.fixture(autouse=True)
def _fast_subscriber_timing(monkeypatch):
    monkeypatch.setattr(subscriber_module, "_READ_BLOCK_MS", 20)
    monkeypatch.setattr(subscriber_module, "_DB_POLL_SECONDS", 0.05)


@pytest_asyncio.fixture
async def fake_redis() -> Any:
    redis = fakeredis.aioredis.FakeRedis()
    yield redis
    await redis.aclose()


def _detail(
    rid: str,
    *,
    status: InsightStatus = InsightStatus.GENERATING,
    error: InsightError | None = None,
) -> InsightRunDetail:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    return InsightRunDetail(
        schema_version=1,
        run_id=rid,  # type: ignore[arg-type]
        attempt=1,
        role_id="schedule_report_summary",
        role_version=1,
        project_id=42,
        country="US",
        status=status,
        stage=InsightStage.GENERATING,
        progress_percent=40,
        outputs={},
        error=error,
        resume=InsightResumeInfo(
            latest_event_id=None, current_attempt=1, history_available=True
        ),
        created_at=now,
        updated_at=now,
    )


def _delta(rid: str, seq: int) -> dict:
    """一帧真流式正文（非终态，所以订阅会一直跟随）。"""
    return {
        "schema_version": 1,
        "run_id": rid,
        "attempt": 1,
        "seq": seq,
        "type": "content.delta",
        "slot": "main",
        "block_id": "b1",
        "format": "markdown",
        "delta": f"第{seq}段",
    }


async def _measure(
    redis: Any,
    *,
    silence: float,
    frames: int = _FRAMES,
    interval: float = _INTERVAL,
) -> tuple[list[float], float]:
    """跑一次「先静默、再逐帧发布」，返回（各帧到达时刻, 首帧发布时刻）。

    订阅者与 producer 并发：producer 先静默 ``silence`` 秒（让订阅者进入空闲
    分支），再从第一帧开始按 ``interval`` 逐帧 ``XADD``。
    """
    rid = str(uuid4())
    subscriber = InsightStreamSubscriber(redis)
    arrivals: list[float] = []

    async def consume() -> None:
        async for _event, _sse_id in subscriber.subscribe(
            run_id=rid, last_event_id=None, detail=_detail(rid)
        ):
            arrivals.append(time.monotonic())
            if len(arrivals) >= frames:
                return

    async def produce() -> float:
        await asyncio.sleep(silence)
        published_at = time.monotonic()
        for seq in range(1, frames + 1):
            await redis.xadd(
                stream_key(rid), {EVENT_FIELD: json.dumps(_delta(rid, seq))}
            )
            await asyncio.sleep(interval)
        return published_at

    consumer = asyncio.create_task(consume())
    published_at = await produce()
    await asyncio.wait_for(consumer, timeout=30)
    return arrivals, published_at


@pytest.mark.asyncio
async def test_scenario_a_idle_silence_does_not_batch_frames(
    fake_redis: Any, monkeypatch
) -> None:
    """场景 A：静默超过 DB 回读周期后逐帧发布 → 必须逐帧到达。

    修复前这里两个断言都挂：首帧要等下一次空闲唤醒（~2s+ 的节拍），20 帧在
    同一瞬间投完（到达跨度 0.0s）。
    """
    monkeypatch.setattr(subscriber_module, "_DB_POLL_SECONDS", 0.2)
    arrivals, published_at = await _measure(fake_redis, silence=0.3)

    assert len(arrivals) == _FRAMES
    first_frame_lag = arrivals[0] - published_at
    arrival_span = arrivals[-1] - arrivals[0]
    assert first_frame_lag < _MAX_FIRST_FRAME_LAG, (
        f"首帧投递滞后 {first_frame_lag * 1000:.1f}ms"
        f"（上限 {_MAX_FIRST_FRAME_LAG * 1000:.0f}ms）——空闲期把读流也停了"
    )
    assert arrival_span > _MIN_ARRIVAL_SPAN, (
        f"到达跨度只有 {arrival_span:.3f}s（应 ≈ 发布跨度 "
        f"{(_FRAMES - 1) * _INTERVAL:.3f}s）——帧被批量投递"
    )


@pytest.mark.asyncio
async def test_scenario_b_matches_scenario_a(fake_redis: Any, monkeypatch) -> None:
    """场景 B（对照）：DB 回读周期远小于帧间隔时，投递结构与 A 一致。

    issue 里的对照组就是这条（修复前 B 只是因为 sleep 变短才看起来正常，A 却
    批量投递）。修复后 A ≈ B 说明节拍只由 ``XREAD BLOCK`` 给。
    """
    from app.services.insight import subscriber as subscriber_module

    monkeypatch.setattr(subscriber_module, "_DB_POLL_SECONDS", 0.05)
    arrivals, published_at = await _measure(fake_redis, silence=0.5)

    assert len(arrivals) == _FRAMES
    assert arrivals[0] - published_at < _MAX_FIRST_FRAME_LAG
    assert arrivals[-1] - arrivals[0] > _MIN_ARRIVAL_SPAN


@pytest.mark.asyncio
async def test_idle_tick_still_synthesizes_terminal_from_db_row(
    fake_redis: Any,
) -> None:
    """空闲期的 DB 回读判据必须保留。

    worker 死在发布终态帧之前：流是空的、行已成 cancelled。客户端仍须收到
    「快照 + 合成终态」，所以把 sleep 换成单调时钟节流不能顺手删掉这次回读。
    """
    rid = str(uuid4())
    subscriber = InsightStreamSubscriber(fake_redis)

    async def loader(_run_id: Any) -> InsightRunDetail:
        return _detail(
            rid,
            status=InsightStatus.CANCELLED,
            error=make_error(InsightErrorCode.CANCELLED, "已取消"),
        )

    subscriber.bind_detail_loader(loader)
    frames = [
        (event, sse_id)
        async for event, sse_id in subscriber.subscribe(
            run_id=rid, last_event_id=None, detail=_detail(rid)
        )
    ]

    assert [event.type for event, _ in frames] == ["snapshot", "error"]
    terminal = frames[-1][0]
    assert isinstance(terminal, ErrorEvent)
    assert terminal.error.code == InsightErrorCode.CANCELLED
