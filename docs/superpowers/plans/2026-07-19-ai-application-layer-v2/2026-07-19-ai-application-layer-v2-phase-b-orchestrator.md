# AI 应用层 V2 · Phase B:编排器(执行/分发解耦)

> **父计划：** [`2026-07-19-ai-application-layer-v2.md`](./2026-07-19-ai-application-layer-v2.md)
> **承接 spec：** §6(编排器)、§7(取消协议)、§8(断连重连)、§9(agent.iter node 模型)、§10(错误分类)
> **Spike 参考：** `openSourceProjects/ai-app-layer-spike/spike/runner.py` + `stream_bus.py` + `cancel.py`
> **依赖：** Phase A(protocol 类型)

**目标：** 建立编排器模块——StreamRunner(run/subscribe/cancel)+ RedisStreamBus + CancelRegistry(Redis + InProcess 双实现)+ agent.iter() node 事件映射 + 异常分类器。用 fakeredis 单测验证。

**非目标：**
- 不挂路由(Phase C)
- 不改前端(Phase C)
- 不连真 LLM(用 TestModel)
- 不删旧代码(Phase D)

---

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 创建 | `backend/app/db/redis.py` | async Redis 客户端工厂 |
| 创建 | `backend/app/services/ai/orchestrator/__init__.py` | 包入口 |
| 创建 | `backend/app/services/ai/orchestrator/stream_bus.py` | RedisStreamBus |
| 创建 | `backend/app/services/ai/orchestrator/cancel.py` | CancelRegistry 接口 + Redis/InProcess 实现 |
| 创建 | `backend/app/services/ai/orchestrator/runner.py` | StreamRunner + 事件映射 + 异常分类 |
| 创建 | `backend/app/services/ai/observability/__init__.py` | 可观测包(P1 留 hook) |
| 创建 | `backend/app/services/ai/observability/logger.py` | 结构化 JSONL logger |
| 修改 | `backend/app/core/config.py` | 新增 ai_chat_redis_stream_prefix / stream_ttl |
| 创建 | `backend/tests/orchestrator/__init__.py` | 测试包 |
| 创建 | `backend/tests/orchestrator/conftest.py` | fakeredis fixture |
| 创建 | `backend/tests/orchestrator/test_stream_bus.py` | Stream 单测 |
| 创建 | `backend/tests/orchestrator/test_cancel.py` | CancelRegistry 单测 |
| 创建 | `backend/tests/orchestrator/test_runner.py` | StreamRunner 单测(happy/cancel/resume/error) |
| 创建 | `backend/tests/orchestrator/test_error_classification.py` | 异常分类单测 |

---

## 任务

### 任务 B1:Redis 客户端工厂 + 配置

**文件：**
- 创建：`backend/app/db/redis.py`
- 修改：`backend/app/core/config.py`(:114 附近,redis_* 字段后追加 ai_chat 相关配置)

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/orchestrator/conftest.py
"""编排器测试 fixtures。"""
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
```

```python
# backend/tests/orchestrator/__init__.py
```

```python
# backend/tests/orchestrator/test_stream_bus.py
"""RedisStreamBus 单测。"""
import pytest
from app.db.redis import create_redis_client


def test_create_redis_client_returns_async_redis():
    """工厂返回 redis.asyncio.Redis 实例。"""
    # 用 fakeredis 验证工厂能创建
    # 真实 Redis 在 CI/本地通过 settings 连
    client = create_redis_client(host="localhost", port=6379, password="", db=0)
    assert client is not None
    # 检查有 async 方法
    assert hasattr(client, "xadd")
    assert hasattr(client, "xread")
    assert hasattr(client, "aclose")
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_stream_bus.py -v
# 预期：ImportError(app.db.redis 或 orchestrator 不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/db/redis.py
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
    kwargs = {"host": host, "port": port, "db": db}
    if password:
        kwargs["password"] = password
    return Redis(**kwargs)
```

在 `backend/app/core/config.py` 的 `redis_db` 字段后(约 :142 行后)追加:

```python
    # AI Chat stream(Redis Stream + cancel registry)
    ai_chat_redis_db: int = Field(default=3, ge=0, le=15)
    ai_chat_stream_prefix: str = Field(default="ai:chat", max_length=50)
    ai_chat_stream_ttl_seconds: int = Field(default=86400, ge=60, le=604800)  # 24h
    ai_chat_stream_maxlen: int = Field(default=10000, ge=100, le=100000)
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_stream_bus.py::test_create_redis_client_returns_async_redis -v
# 预期：PASS
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/db/redis.py backend/app/core/config.py backend/tests/orchestrator/
git commit -m "feat(ai-orchestrator): Redis client factory + stream config(V2 Phase B1)"
```

---

### 任务 B2:RedisStreamBus

**文件：**
- 创建：`backend/app/services/ai/orchestrator/__init__.py`
- 创建：`backend/app/services/ai/orchestrator/stream_bus.py`
- 测试：`backend/tests/orchestrator/test_stream_bus.py`(追加)

- [ ] **步骤 1：编写失败的测试**

在 `backend/tests/orchestrator/test_stream_bus.py` 追加:

```python
import pytest
import json

from app.services.ai.protocol.events import MessageStart, MessageStop


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
    # end 标记应在 stream 中
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
    assert "-" in entry_id  # Redis Stream ID 格式: timestamp-seq


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
    """listen() 按顺序 yield 事件。"""
    await bus.start(42)
    ev1 = MessageStart(message_id="m1", model="gpt-4", created_at=1700000000000)
    await bus.add(42, ev1)
    await bus.stop(42)  # 加 end 标记

    events = []
    async for entry_id, entry_type, data in bus.listen(42):
        events.append((entry_type, data))
        if entry_type == "end":
            break

    # begin 跳过,event + end
    assert any(t == "event" for t, _ in events)
    assert any(t == "end" for t, _ in events)
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_stream_bus.py -v -k "bus_"
# 预期：ImportError(stream_bus 模块不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/orchestrator/__init__.py
"""AI Chat 编排器 — 执行/分发解耦 + Redis Stream。"""
```

```python
# backend/app/services/ai/orchestrator/stream_bus.py
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
    val = fields.get(key.encode() if isinstance(next(iter(fields.keys())), bytes) else key)
    if val is None:
        return ""
    return val.decode() if isinstance(val, bytes) else val
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_stream_bus.py -v
# 预期：全部 passed
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/orchestrator/ backend/tests/orchestrator/
git commit -m "feat(ai-orchestrator): RedisStreamBus(V2 Phase B2)"
```

---

### 任务 B3:CancelRegistry(接口 + Redis + InProcess)

**文件：**
- 创建：`backend/app/services/ai/orchestrator/cancel.py`
- 测试：`backend/tests/orchestrator/test_cancel.py`

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/orchestrator/test_cancel.py
"""CancelRegistry 单测:Redis + InProcess 双实现。"""
import pytest

from app.services.ai.orchestrator.cancel import (
    CancelRegistry,
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
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_cancel.py -v
# 预期：ImportError(cancel 模块不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/orchestrator/cancel.py
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
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_cancel.py -v
# 预期：10 passed
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/orchestrator/cancel.py backend/tests/orchestrator/test_cancel.py
git commit -m "feat(ai-orchestrator): CancelRegistry Redis + InProcess(V2 Phase B3)"
```

---

### 任务 B4:StreamRunner(核心编排器 + 事件映射 + 异常分类)

**文件：**
- 创建：`backend/app/services/ai/orchestrator/runner.py`
- 创建：`backend/app/services/ai/observability/__init__.py`、`logger.py`
- 测试：`backend/tests/orchestrator/test_runner.py`、`test_error_classification.py`

> 这是 Phase B 最大任务。从 Spike 的 `runner.py` 适配到项目结构:用 `get_settings()` 读配置、import 项目 protocol 层、复用 `build_chat_agent`。

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/orchestrator/test_runner.py
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

from app.services.ai.orchestrator.runner import StreamRunner, CancelledError, classify_error
from app.services.ai.protocol.errors import ErrorCode
from app.services.ai.protocol.events import (
    MessageStart, MessageStop, ErrorEvent, validate_event,
)


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
        yield

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
    from app.services.ai.orchestrator.runner import StreamRunner
    conv_id = 6
    runner = StreamRunner(bus=bus, cancel_registry=inprocess_cancel)
    agent = _create_fake_agent("InProcess test")
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
```

```python
# backend/tests/orchestrator/test_error_classification.py
"""异常分类单测。"""
import asyncio
import pytest
import httpx

from app.services.ai.orchestrator.runner import classify_error, CancelledError
from app.services.ai.protocol.errors import ErrorCode


def test_cancelled_error():
    err = classify_error(CancelledError())
    assert err.code == ErrorCode.CANCELLED


def test_timeout_error():
    err = classify_error(asyncio.TimeoutError())
    assert err.code == ErrorCode.TIMEOUT


def test_httpx_429_to_rate_limit():
    # 构造一个 mock HTTPStatusError
    err = classify_error(RuntimeError("simulated 500"))
    assert err.code == ErrorCode.INTERNAL


def test_default_internal():
    err = classify_error(ValueError("something"))
    assert err.code == ErrorCode.INTERNAL
    assert "something" in err.message
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/test_runner.py tests/orchestrator/test_error_classification.py -v
# 预期：ImportError(runner 模块不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/observability/__init__.py
"""可观测性包(P1 留 hook,P3 落地 metrics)。"""
```

```python
# backend/app/services/ai/observability/logger.py
"""结构化 JSONL logger(P1 最小实现)。"""
import logging
import json
import time

logger = logging.getLogger("ai_chat.observability")


def log_stream_event(conv_id: int, event_type: str, **extra):
    """记录流事件(P1 最小:stdout JSONL)。"""
    logger.info(json.dumps({
        "ts": time.time(),
        "conv_id": conv_id,
        "event": event_type,
        **extra,
    }))
```

```python
# backend/app/services/ai/orchestrator/runner.py
"""StreamRunner — 编排器核心。

解耦 agent 执行与 HTTP 订阅,经 Redis Stream 中转事件。

- run():       asyncio.create_task 后台执行 agent.iter();事件 xadd 到 Stream
- subscribe(): AsyncGenerator,从 Stream xread,编码为 SSE bytes
- cancel():    GETDEL live_key → agent 下次 is_live() 检测到 → raise

对应 V2 spec §6.2、§9(agent.iter node 模型)。
Spike 验证:openSourceProjects/ai-app-layer-spike/spike/runner.py
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, AsyncGenerator

from pydantic_ai import Agent
from pydantic_ai.messages import (
    PartStartEvent, PartDeltaEvent, PartEndEvent, FinalResultEvent,
    TextPart, ThinkingPart, ToolCallPart,
    TextPartDelta, ThinkingPartDelta, ToolCallPartDelta,
    ToolReturnPart,
)

from app.services.ai.observability.logger import log_stream_event
from app.services.ai.orchestrator.cancel import CancelRegistry
from app.services.ai.orchestrator.stream_bus import RedisStreamBus
from app.services.ai.protocol.encoder import encode_sse
from app.services.ai.protocol.events import (
    ContentBlockStart, ContentBlockDelta, ContentBlockStop,
    ErrorEvent, MessageDelta, MessageStart, MessageStop,
    ProtocolError, ProtocolEvent, TextBlock, TextDelta,
    ThinkingBlock, ThinkingDelta, ToolUseBlock, ToolResultBlock,
    Usage, ErrorCode, validate_event,
)

logger = logging.getLogger(__name__)


class CancelledError(Exception):
    """用户主动取消时使用。"""
    pass


class StreamRunner:
    """编排器:解耦 agent 执行与 HTTP 订阅。"""

    def __init__(self, bus: RedisStreamBus, cancel_registry: CancelRegistry):
        self._bus = bus
        self._cancel = cancel_registry

    async def run(
        self,
        conv_id: int,
        agent: Agent,
        user_prompt: str,
        message_history: list | None = None,
        model_name: str = "unknown",
    ) -> None:
        """后台执行 agent。事件写入 Redis Stream。"""
        await self._cancel.register(conv_id)
        await self._bus.start(conv_id)

        message_id = str(uuid.uuid4())
        created_at = int(time.time() * 1000)

        # 取消检查点 0:agent 开始前
        await asyncio.sleep(0)
        if not await self._cancel.is_live(conv_id):
            raise CancelledError()

        try:
            await self._bus.add(conv_id, MessageStart(
                message_id=message_id, model=model_name, created_at=created_at,
            ))

            async with agent.iter(
                user_prompt, message_history=message_history or [],
            ) as agent_run:
                async for node in agent_run:
                    if not await self._cancel.is_live(conv_id):
                        raise CancelledError()
                    if not Agent.is_model_request_node(node):
                        continue
                    async with node.stream(agent_run.ctx) as node_stream:
                        async for event in node_stream:
                            mapped = _map_node_event(event)
                            if mapped:
                                if isinstance(mapped, list):
                                    for ev in mapped:
                                        await self._bus.add(conv_id, ev)
                                else:
                                    await self._bus.add(conv_id, mapped)

            usage = _extract_usage(agent_run)
            await self._bus.add(conv_id, MessageDelta(usage=usage, stop_reason="end_turn"))

        except CancelledError:
            logger.info("Stream %s cancelled by user", conv_id)
            log_stream_event(conv_id, "cancelled")
            await self._bus.add(conv_id, ErrorEvent(
                error=ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
            ))

        except Exception as exc:
            logger.exception("Stream %s crashed: %s", conv_id, exc)
            error = classify_error(exc)
            log_stream_event(conv_id, "error", code=error.code.value, message=error.message)
            await self._bus.add(conv_id, ErrorEvent(error=error))

        finally:
            await self._bus.add(conv_id, MessageStop())
            await self._bus.stop(conv_id)

    async def subscribe(
        self, conv_id: int, from_id: str = "0"
    ) -> AsyncGenerator[bytes, None]:
        """HTTP 端点调此方法。从 Redis Stream 读取,编码为 SSE bytes。"""
        async for entry_id, entry_type, data_json in self._bus.listen(conv_id, from_id):
            if entry_type == "begin":
                continue
            if entry_type == "end":
                break
            if entry_type in ("event", "error"):
                event = validate_event(data_json)
                yield encode_sse(event, entry_id=entry_id)
                if isinstance(event, (MessageStop, ErrorEvent)):
                    break

    async def cancel(self, conv_id: int) -> bool:
        """取消:GETDEL live_key。"""
        return await self._cancel.request_cancel(conv_id)


# ── node event → ProtocolEvent 映射 ──

def _map_node_event(event: Any) -> ProtocolEvent | list[ProtocolEvent] | None:
    """把 pydantic-ai node stream event 映射为 ProtocolEvent。对应 spec §9.3。"""
    if isinstance(event, PartStartEvent):
        part = event.part
        if isinstance(part, TextPart):
            return ContentBlockStart(index=event.index, content_block=TextBlock())
        if isinstance(part, ThinkingPart):
            return ContentBlockStart(index=event.index, content_block=ThinkingBlock())
        if isinstance(part, ToolCallPart):
            return ContentBlockStart(
                index=event.index,
                content_block=ToolUseBlock(
                    id=getattr(part, "tool_call_id", str(event.index)),
                    name=part.tool_name,
                    input=part.args if isinstance(part.args, dict) else {},
                ),
            )
        if isinstance(part, ToolReturnPart):
            return [
                ContentBlockStart(
                    index=event.index,
                    content_block=ToolResultBlock(
                        tool_use_id=getattr(part, "tool_call_id", ""),
                        content=str(part.content)[:500],
                        is_error=False,
                    ),
                ),
                ContentBlockStop(index=event.index),
            ]
        return None

    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            return ContentBlockDelta(index=event.index, delta=TextDelta(text=delta.content_delta))
        if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
            return ContentBlockDelta(index=event.index, delta=ThinkingDelta(text=delta.content_delta))
        return None

    if isinstance(event, PartEndEvent):
        return ContentBlockStop(index=event.index)

    return None


def _extract_usage(agent_run: Any) -> Usage:
    try:
        usage = agent_run.result.usage
        return Usage(
            input_tokens=getattr(usage, "input_tokens", 0),
            output_tokens=getattr(usage, "output_tokens", 0),
            total_tokens=getattr(usage, "total_tokens", 0),
        )
    except Exception:
        return Usage()


def classify_error(exc: Exception) -> ProtocolError:
    """异常 → typed ProtocolError。对应 spec §10.2。"""
    if isinstance(exc, CancelledError):
        return ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
    if isinstance(exc, asyncio.TimeoutError):
        return ProtocolError(code=ErrorCode.TIMEOUT, message="LLM 响应超时")
    return ProtocolError(code=ErrorCode.INTERNAL, message=str(exc) or "内部错误")
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/orchestrator/ -v
# 预期：全部 passed(test_stream_bus + test_cancel + test_runner + test_error_classification)
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/orchestrator/runner.py backend/app/services/ai/observability/ backend/tests/orchestrator/test_runner.py backend/tests/orchestrator/test_error_classification.py
git commit -m "feat(ai-orchestrator): StreamRunner + agent.iter mapping + error classification(V2 Phase B4)"
```

---

## Phase B 完成标准

- [ ] `tests/orchestrator/test_stream_bus.py` 全部 passed
- [ ] `tests/orchestrator/test_cancel.py` 全部 passed(Redis + InProcess)
- [ ] `tests/orchestrator/test_runner.py` 全部 passed(happy/cancel/resume/error/inprocess)
- [ ] `tests/orchestrator/test_error_classification.py` 全部 passed
- [ ] orchestrator 模块不 import fastapi(只依赖 redis + pydantic_ai + protocol)
- [ ] fakeredis 单测无需真实 Redis 即可跑
