"""StreamRunner 核心测试。

覆盖 V2 spec §14.3 验收标准 1-6(跨 worker 除外)。
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from pydantic_ai import Agent
from pydantic_ai.capabilities import Thinking
from pydantic_ai.models.test import TestModel

from app.services.ai.orchestrator.runner import StreamRunner, CancelledError
from app.services.ai.protocol.errors import ErrorCode
from app.services.ai.protocol.events import MessageStop, validate_event


def _create_fake_agent(output_text: str = "Hello from spike agent!") -> Agent:
    return Agent(
        model=TestModel(custom_output_text=output_text),
        system_prompt="test",
        capabilities=[Thinking()],
        tools=[],
    )


async def _collect_events(bus, conv_id: int, timeout: float = 5.0):
    events = []
    try:
        async with asyncio.timeout(timeout):
            async for entry_id, entry_type, data in bus.listen(conv_id):
                if entry_type == "begin":
                    continue
                if entry_type == "end":
                    break
                if entry_type in ("event", "error"):
                    events.append(validate_event(data))
                    if isinstance(events[-1], MessageStop):
                        break
    except (asyncio.TimeoutError, TimeoutError):
        pass
    return events


# ─── 验收 1: happy path ──

@pytest.mark.asyncio
async def test_run_emits_message_start_blocks_stop(runner, bus):
    conv_id = 1
    agent = _create_fake_agent("Hello spike!")
    task = asyncio.create_task(runner.run(conv_id, agent, "hi", model_name="test-model"))
    events = await _collect_events(bus, conv_id)
    await task

    assert len(events) > 0
    types = [e.type for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"
    assert "content_block_start" in types
    assert "content_block_delta" in types
    assert "content_block_stop" in types
    assert "message_delta" in types

    # 文本内容
    deltas = [e for e in events if e.type == "content_block_delta"]
    text = "".join(d.delta.text for d in deltas if d.delta.type == "text_delta")
    assert "Hello spike!" in text


# ─── 验收 2: 取消 ──

@pytest.mark.asyncio
async def test_cancel_emits_error_cancelled(runner, bus, monkeypatch):
    conv_id = 2
    agent = _create_fake_agent("slow...")
    original_iter = agent.iter

    @asynccontextmanager
    async def slow_iter(*args, **kwargs):
        await asyncio.sleep(0.3)
        async with original_iter(*args, **kwargs) as run:
            yield run

    monkeypatch.setattr(agent, "iter", slow_iter)

    task = asyncio.create_task(runner.run(conv_id, agent, "hi", model_name="test-model"))
    await asyncio.sleep(0.1)
    cancelled = await runner.cancel(conv_id)
    assert cancelled is True

    events = await _collect_events(bus, conv_id)
    await task

    errors = [e for e in events if e.type == "error"]
    assert len(errors) == 1
    assert errors[0].error.code == ErrorCode.CANCELLED


@pytest.mark.asyncio
async def test_cancel_not_active_returns_false(runner):
    assert await runner.cancel(999) is False


# ─── 验收 3: 重连 ──

@pytest.mark.asyncio
async def test_resume_from_last_event_id(runner, bus):
    conv_id = 3
    agent = _create_fake_agent("Resume test!")
    task = asyncio.create_task(runner.run(conv_id, agent, "hi", model_name="test-model"))

    first_batch = []
    async for chunk in runner.subscribe(conv_id, from_id="0"):
        first_batch.append(chunk)
        if len(first_batch) >= 2:
            break

    # 提取最后一个 id
    last_id = None
    for chunk in first_batch:
        text = chunk.decode("utf-8")
        for line in text.split("\n"):
            if line.startswith("id: "):
                last_id = line[4:].strip()

    assert last_id is not None

    rest = []
    async for chunk in runner.subscribe(conv_id, from_id=last_id):
        rest.append(chunk)
    await task

    assert len(rest) > 0
    last_text = rest[-1].decode("utf-8")
    assert "message_stop" in last_text


# ─── 验收 4: 错误 ──

@pytest.mark.asyncio
async def test_crash_emits_typed_error(runner, bus, monkeypatch):
    conv_id = 4
    agent = _create_fake_agent()

    @asynccontextmanager
    async def crashing_iter(*args, **kwargs):
        raise RuntimeError("Simulated LLM 500")
        yield  # noqa: unreachable

    monkeypatch.setattr(agent, "iter", crashing_iter)

    task = asyncio.create_task(runner.run(conv_id, agent, "hi", model_name="test-model"))
    events = await _collect_events(bus, conv_id)
    await task

    errors = [e for e in events if e.type == "error"]
    assert len(errors) == 1
    assert errors[0].error.code == ErrorCode.INTERNAL
    assert "Simulated LLM 500" in errors[0].error.message
    assert events[-1].type == "message_stop"


# ─── 验收 5: InProcess 降级 ──

@pytest.mark.asyncio
async def test_inprocess_cancel_with_bus(bus, inprocess_cancel, monkeypatch):
    conv_id = 6
    local_runner = StreamRunner(bus=bus, cancel_registry=inprocess_cancel)
    agent = _create_fake_agent("InProcess test")
    original_iter = agent.iter

    @asynccontextmanager
    async def slow_iter(*args, **kwargs):
        await asyncio.sleep(0.3)
        async with original_iter(*args, **kwargs) as run:
            yield run

    monkeypatch.setattr(agent, "iter", slow_iter)

    task = asyncio.create_task(local_runner.run(conv_id, agent, "hi", model_name="test-model"))
    await asyncio.sleep(0.1)
    cancelled = await local_runner.cancel(conv_id)
    assert cancelled is True

    events = await _collect_events(bus, conv_id)
    await task

    errors = [e for e in events if e.type == "error"]
    assert len(errors) == 1
    assert errors[0].error.code == ErrorCode.CANCELLED
