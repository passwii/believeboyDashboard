# 设计文档:AI 应用层方案打磨 V2(执行/分发解耦 · Redis Stream · 协议层落地)

- 关联 issue:无(全局 AI 改造,跨前后端)
- 状态:设计稿 V2(待用户审查)
- 前置文档:[V1 — AI Chat 架构重设计](./2026-07-17-ai-chat-architecture-redesign-design.md)(2026-07-17)
- 范围:本次仅产出设计文档 + Spike 验证,**不写生产实现代码**;确认后由 writing-plans 拆实现计划
- 日期:2026-07-19

> **核心定位**:V1 是"协议优先"的架构蓝图;V2 是在 **Pydantic AI driver 已落地(Phase 1-3)** 基础上,经过开源研究后对**执行架构**的打磨。重点变化:执行/分发解耦 + Redis Stream 取消/重连 + `agent.iter()` node 模型。

---

## 1. 背景与现状

### 1.1 已落地(V1 Phase 1-3 / V2 前置)

| 已完成 | 说明 |
|---|---|
| Pydantic AI driver | `agent.run_stream_events()` 接入,替换旧 httpx 路径 |
| Tavily search tool | `tavily_search_tool` 注册,web_search=True 走 Pydantic AI |
| 事件映射 | `stream_mapper.py`:pydantic-ai 事件 → ndjson 字节 |
| 取消端点 | `/cancel` + 进程内 `threading.Event` registry |
| 自动标题 | Phase 3:首轮自动生成 conversation title |
| 测试 | `test_ai_chat_stream_native.py` 覆盖 happy/tool/prompt 转换 |

### 1.2 未落地(V1 设计了但没做)

| 未完成 | 影响 |
|---|---|
| 协议层 `protocol/` | 事件仍是自定义 ndjson(`start`/`chunk`/`done`),非 Anthropic Messages SSE |
| 编排器 `orchestrator/` | 逻辑堆在 endpoint,agent 与 HTTP 生命周期耦合 |
| `stream_mapper.py` 删除 | 仍在原位 |
| 取消端点前端接入 | `/cancel` 端点存在但前端 `useChatStream.stop()` 不调用它 |
| 取消事件 | `_CancelledError` 分支不发 `error{cancelled}` |
| typed ErrorCode | 错误退化为字符串 |
| 跨 worker 取消 | 进程内 Event,多 worker 失效 |

### 1.3 V2 要解决的核心问题

1. **取消前后端没接上**(前端不调 `/cancel`,`_CancelledError` 不发结束事件)
2. **agent 执行与 HTTP 请求耦合**(同步 DB 操作阻塞 event loop;客户端断连影响 agent)
3. **协议层未落地**(自定义 ndjson,前端字符串匹配错误,无 typed ErrorCode)
4. **跨 worker 取消**(P4 延后,但项目已有 Redis,可提前)

---

## 2. 开源研究摘要(5 个参考实现)

| 仓库 | 路径 | 核心启发 |
|---|---|---|
| `opale-ai/pydantic-ai-stream` | `openSourceProjects/pydantic-ai-stream` | ⭐⭐⭐⭐⭐ 执行/分发解耦 + Redis Stream;`agent.iter()` node 模型;取消 = `GETDEL live_key`;跨 worker 天然生效 |
| `anthropics/anthropic-sdk-python` | `openSourceProjects/anthropic-sdk-python` | ⭐⭐⭐⭐ Messages SSE 协议层 Pydantic 定义源头;6 事件 discriminated union |
| `montoyitadevelp/StreamingPydanticAI` | `openSourceProjects/StreamingPydanticAI` | ⭐⭐ 确认标准 `text/event-stream` + `data:{json}\n\n` 格式 |
| `Foxpace/fastapi-pydantic-ai-example` | `openSourceProjects/fastapi-pydantic-ai-example` | ⭐ 非流式,参考价值低 |
| `leonh/redis-streams-fastapi-chat` | `openSourceProjects/redis-streams-fastapi-chat` | ⭐⭐ Redis Stream + FastAPI 模式印证 |

### 2.1 最关键发现:opale-ai 证明「执行/分发解耦 + Redis Stream」P1 就该上

opale-ai 的核心模式:

```
POST /chat 端点:
  1. asyncio.create_task(run_agent())     ← agent 后台跑
  2. yield from deps.listen()              ← 从 Redis Stream xread 订阅

run_agent():
  async with agent.iter(...) as run:
    async for node in run:                  ← node 级迭代
      await deps.add(event)                ← 每事件 xadd 到 Redis Stream

POST /cancel 端点:
  await deps.cancel()                       ← GETDEL live_key
```

**三个免费能力**:
1. **跨 worker 取消**:`GETDEL live_key`,agent 循环 `is_live()` 检查 → raise。无需 sticky session。
2. **断连重连**:Redis Stream 保留历史,客户端重连 `xread(from=last_id)` 续上。
3. **agent 生命周期独立**:客户端关浏览器,agent 仍可跑完或被 cancel。

### 2.2 Anthropic 官方协议层验证

`anthropic-sdk-python/src/anthropic/types/raw_message_stream_event.py`:

```python
RawMessageStreamEvent = Annotated[
    Union[
        RawMessageStartEvent,        # type: Literal["message_start"]
        RawMessageDeltaEvent,        # type: Literal["message_delta"]
        RawMessageStopEvent,         # type: Literal["message_stop"]
        RawContentBlockStartEvent,   # type: Literal["content_block_start"]
        RawContentBlockDeltaEvent,   # type: Literal["content_block_delta"]
        RawContentBlockStopEvent,    # type: Literal["content_block_stop"]
    ],
    PropertyInfo(discriminator="type"),  # V1 用 Field(discriminator="type"),语义等价
]
```

V1 §4.5 的 Pydantic discriminated union 写法完全正确。官方没有 `error`/`ping` 事件类型(error 走 HTTP 层)——V1 把它们加入 union 是本仓库合理扩展。

---

## 3. V1 → V2 关键决策对比

| # | 决策点 | V1 | V2 | 变更原因 |
|---|---|---|---|---|
| Q1 | 取消架构 | P1 进程内 Event → P4 换 Redis | **P1 直接 Redis Stream + live key** | 项目已有 Redis;opale-ai 验证可行;P4 提前消除 |
| Q2 | agent API | `run_stream_events()` | **`agent.iter()` node 模型** | node 粒度可观测;多轮 tool 调用更清晰;opale-ai 验证 |
| Q3 | 断连重连 | 否(P3 后评估) | **纳入**:Redis Stream `last_id` resume | 解耦模式免费获得;对话场景有价值 |
| Q4 | 进程内降级 | 未提及 | **保留,限 CancelRegistry** | 单测确定性;Redis 挂时 cancel 仍工作;成本极低 |
| Q5 | origin 字段 | 未提及 | **不引入** | 保持 Anthropic 协议纯净;可观测走结构化日志 |
| — | 传输格式 | `text/event-stream` + `data:{json}\n\n` | **沿用** | 不变 |
| — | 事件类型 | Anthropic Messages SSE 6 事件 + error/ping 扩展 | **沿用** | 不变 |
| — | ErrorCode | 11 类 enum | **沿用** | 不变(opale-ai 没做,这是 V1 优势) |
| — | 端点瘦身 | 路由 + 调 StreamRunner | **沿用,且更瘦**(只订阅 Redis Stream) | 解耦后端点不再持有 agent 生命周期 |

---

## 4. 架构总览(V2)

### 4.1 系统分层

```
┌───────────────────────── Frontend (Next.js) ─────────────────────────┐
│                                                                       │
│  useChatStream(protocol)          ← 协议层 + React hook               │
│   ├─ Protocol codec (encode/decode SSE 事件)                         │
│   ├─ Transport (fetch + AbortController + resume last-event-id)      │
│   ├─ Cancel: fetch /cancel + AbortController                        │
│   └─ State: messages / status / error                                │
│                                                                       │
│  ChatPanel → protocol → fetch /api/ai/...                             │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │  text/event-stream over HTTPS
                          │  协议: Anthropic-style 事件序列
                          │  取消: POST /cancel(独立)
                          │  重连: Last-Event-ID header
                          ▼
┌───────────────────────── Backend (FastAPI) ──────────────────────────┐
│                                                                       │
│  Router (瘦化)                                                       │
│   POST /conversations/{id}/stream    ← 订阅 Redis Stream,转发 SSE    │
│   POST /conversations/{id}/cancel    ← GETDEL live_key               │
│   GET  /conversations/{id}/resume    ← 从 last-event-id 续传          │
│                                                                       │
│  Orchestrator (编排器 — 解耦模式)                                     │
│   ├─ run()         → asyncio.create_task,后台执行 agent              │
│   │   ├─ agent.iter() node 级迭代                                     │
│   │   ├─ 事件 xadd 到 Redis Stream                                    │
│   │   └─ cancel 检查:is_live() 每 node 迭代前                        │
│   ├─ subscribe()   → AsyncGenerator: xread Redis Stream → SSE bytes   │
│   ├─ CancelRegistry (接口)                                            │
│   │   ├─ RedisCancelRegistry (生产)                                  │
│   │   └─ InProcessCancelRegistry (单测/降级)                          │
│   └─ Observability hooks                                             │
│                                                                       │
│  Protocol Layer (协议层 — 纯定义)                                     │
│   ├─ events.py    ProtocolEvent / ContentBlock / Delta / Usage        │
│   ├─ encoder.py   SSEEncoder: ProtocolEvent → "data: {json}\n\n"     │
│   └─ errors.py     ErrorCode enum + ProtocolError                    │
│                                                                       │
│  Pydantic AI Agent (沿用,不改 agent.py 核心)                          │
│   ├─ agent.iter() node graph 迭代                                     │
│   └─ Tools(tavily_search)                                            │
│                                                                       │
│  Persistence (SQLAlchemy, sync session)                               │
│   └─ 在 stream 开始/结束触一次,中间不持连接(to_thread)                │
│                                                                       │
│  Redis (已有 — Celery 在用)                                           │
│   ├─ Stream: ai:chat:{conv_id}     ← 事件流(xadd / xread)            │
│   ├─ Live key: ai:chat:{conv_id}:live ← 存活标记(SET / GETDEL)      │
│   └─ TTL: Stream 过期清理(24h)                                      │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.2 核心设计原则(V2 调整)

1. **协议层独立** — 纯事件定义 + SSE 编解码,不知道 Redis / Pydantic AI / FastAPI / React。(V1 不变)
2. **编排器解耦** — agent 执行与 HTTP 请求生命周期分离;事件经 Redis Stream 中转。(**V2 新增**)
3. **端点只做订阅** — 鉴权 + DB 初始化 + 订阅 Redis Stream + 转发 SSE。不持有 agent。(**V2 调整**)
4. **错误 typed 化** — `ErrorCode` 枚举贯穿三端。(V1 不变)
5. **取消双向 + 跨 worker** — 客户端调 `/cancel` → `GETDEL live_key` → agent 下次 `is_live()` 检测到 → raise。(**V2 强化**)
6. **重连基于 Stream offset** — 客户端断线重连带 `Last-Event-ID`,服务端从该 offset 续传。(**V2 新增**)

### 4.3 与 V1 架构差异图

```
V1 架构(原设计):
  HTTP 端点 → StreamRunner.run() → agent → yield 事件 → HTTP 响应
  (agent 与 HTTP 请求生命周期耦合;取消靠进程内 Event)

V2 架构(打磨后):
  HTTP 端点 → subscribe(Redis Stream) → yield SSE
       ↑                                    ↑
       │  解耦                               │  xadd
  POST /cancel                        Orchestrator.run()
  (GETDEL live_key)                   (asyncio.create_task)
                                           ↓
                                      agent.iter() node 迭代
                                           ↓
                                      is_live() 检查 → raise if cancelled
```

---

## 5. 协议层(沿用 V1 §4,确认 + 补充)

### 5.1 传输

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`(防 nginx 缓冲)
- 每行: `data: {json}\n\n`(空行分隔事件)
- `data: [DONE]` 不用(用 `message_stop` 替代)
- **V2 新增**:响应头携带 `id: {redis_stream_entry_id}`(每个 SSE 事件附 Redis Stream entry ID,供 `Last-Event-ID` 重连)

### 5.2 事件序列(正常路径)

```
message_start
  content_block_start        {index, content_block: {type, ...}}
  content_block_delta × N    {index, delta: {type, ...}}
  content_block_stop         {index}
  ...可重复多个 content_block...
message_delta                {usage, stop_reason}
message_stop
```

### 5.3 事件类型清单(沿用 V1 §4.3)

| 事件 | Payload | 触发时机 |
|---|---|---|
| `message_start` | `{message_id, model, role: "assistant", created_at}` | 流开始,一次 |
| `content_block_start` | `{index, content_block: {type, ...}}` | 文本/思考/工具块开始 |
| `content_block_delta` | `{index, delta: {type, text\|partial_json}}` | 内容增量 |
| `content_block_stop` | `{index}` | 内容块结束 |
| `message_delta` | `{usage, stop_reason}` | 消息级元信息更新 |
| `message_stop` | `{}` | 流正常结束,一次 |
| `ping` | `{}` | keepalive(每 15s) |
| `error` | `{error: {code, message, retry_after?}}` | 错误(含取消) |

### 5.4 content_block.type 扩展(沿用 V1 §4.4)

| type | 用途 | content_block 字段 |
|---|---|---|
| `text` | 助手文本输出 | (无,初始) |
| `thinking` | 思考链 | (无,初始) |
| `tool_use` | LLM 调用工具 | `{id, name, input}` |
| `tool_result` | 工具返回结果(本仓库扩展) | `{tool_use_id, content, is_error, sources?}` |

### 5.5 Pydantic 定义(沿用 V1 §4.5,确认正确)

V1 §4.5 的 Pydantic 定义经 Anthropic 官方 SDK 验证,写法完全正确。核心结构:

```python
# protocol/events.py
ContentBlock = Annotated[
    Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock],
    Field(discriminator="type"),
]

Delta = Annotated[
    Union[TextDelta, ThinkingDelta, InputJSONDelta],
    Field(discriminator="type"),
]

ProtocolEvent = Annotated[
    Union[
        MessageStart, ContentBlockStart, ContentBlockDelta, ContentBlockStop,
        MessageDelta, MessageStop, Ping, ErrorEvent,
    ],
    Field(discriminator="type"),
]
```

> Anthropic 官方用 `PropertyInfo(discriminator="type")`(Stainless 生成器产物),语义与 `Field(discriminator="type")` 等价。我们用后者(Pydantic 原生)。

---

## 6. 编排器(Orchestrator — V2 核心变化)

### 6.1 模块结构

```
backend/app/services/ai/
├── protocol/                    # 协议层(新 — 沿用 V1 设计)
│   ├── events.py               #   ProtocolEvent / ContentBlock / Delta / Usage
│   ├── encoder.py              #   SSEEncoder: ProtocolEvent → "data: {json}\n\n" bytes
│   ├── errors.py               #   ErrorCode enum + ProtocolError
│   └── __init__.py
├── orchestrator/               # 编排器(新 — V2 解耦模式)
│   ├── runner.py               #   StreamRunner: run()(后台) + subscribe()(订阅)
│   ├── cancel.py               #   CancelRegistry 接口 + Redis/InProcess 两个实现
│   ├── stream_bus.py           #   RedisStreamBus: xadd/xread 封装
│   ├── lifecycle.py            #   状态机: idle / running / done / aborted / error
│   └── __init__.py
├── observability/              # 可观测性(P1 留 hook,P3 落地)
│   ├── logger.py               #   结构化 JSONL logger
│   ├── metrics.py              #   Prometheus 接口(P3 实现)
│   └── __init__.py
├── agent.py                    # (保留)build_chat_agent 沿用
├── chat.py                     # (保留)DB 操作
├── search.py                   # (保留)build_search_source_cards
├── stream_utils.py             # (瘦身)只留低层 byte 工具
├── stream_mapper.py            # (删除)职责并入 protocol + runner
└── cancel.py                   # (删除)迁移到 orchestrator/cancel.py
```

### 6.2 StreamRunner 核心接口

```python
# orchestrator/runner.py(伪代码,展示结构)

class StreamRunner:
    """编排器:解耦 agent 执行与 HTTP 订阅,经 Redis Stream 中转事件。

    生命周期:
    - run(): asyncio.create_task 后台执行 agent;事件 xadd 到 Redis Stream
    - subscribe(): AsyncGenerator,从 Redis Stream xread,编码为 SSE bytes
    - cancel(): GETDEL live_key → agent 下次 is_live() 检测到 → raise
    """

    async def run(self, conversation_id, agent, user_prompt, message_history, ...):
        """后台执行 agent。不返回给 HTTP 端点,而是把事件写入 Redis Stream。"""
        await self.bus.start(conversation_id)  # SET live_key
        try:
            async with agent.iter(
                user_prompt, message_history=message_history, deps=self.deps
            ) as agent_run:
                async for node in agent_run:
                    if not await self.cancel_registry.is_live(conversation_id):
                        raise CancelledError()
                    if Agent.is_model_request_node(node):
                        await self._emit_node_begin(node)
                        async with node.stream(agent_run.ctx) as node_stream:
                            async for event in node_stream:
                                await self._emit_node_event(event)
                        await self._emit_node_end()
            # commit DB(用 to_thread 包同步操作)
            await asyncio.to_thread(self._persist_final_state, ...)
        except CancelledError:
            await self.bus.add_error(conversation_id,
                ProtocolError(code=ErrorCode.CANCELLED, message="用户取消"))
        except Exception as e:
            await self.bus.add_error(conversation_id,
                self._classify_error(e))  # LLM_5XX / TIMEOUT / RATE_LIMIT / ...
        finally:
            await self.bus.stop(conversation_id)  # DEL live_key + expire stream

    async def subscribe(self, conversation_id, last_event_id="0"):
        """HTTP 端点调此方法。从 Redis Stream xread,编码为 SSE bytes yield。"""
        async for entry_id, event in self.bus.listen(conversation_id, from_id=last_event_id):
            yield self.encoder.encode(event, id=entry_id)
            if event.type == "message_stop" or event.type == "error":
                break

    async def cancel(self, conversation_id):
        """取消:GETDEL live_key。跨 worker 生效。"""
        return await self.cancel_registry.request_cancel(conversation_id)
```

### 6.3 Redis Stream 事件格式

Redis Stream entry 字段:

```
key:   ai:chat:{conversation_id}
fields:
  type:   message_start | content_block_start | content_block_delta | ...
  data:   {json of ProtocolEvent}
```

- `type=begin`:流开始标记(opale-ai 风格,subscribe 用来确认流活跃)
- `type=event`:正常事件(data 字段是 ProtocolEvent JSON)
- `type=error`:错误事件(data 字段是 ProtocolError JSON)
- `type=end`:流结束标记(subscribe 收到后 break)

### 6.4 CancelRegistry 接口(Q4 决策)

```python
# orchestrator/cancel.py

class CancelRegistry(Protocol):
    """取消信号注册表接口。"""

    async def register(self, conversation_id: int) -> None:
        """标记一个活跃流。"""
        ...

    async def is_live(self, conversation_id: int) -> bool:
        """检查流是否仍活跃(False = 已取消)。"""
        ...

    async def request_cancel(self, conversation_id: int) -> bool:
        """请求取消。返回 True 如果有活跃流被取消。"""
        ...


class RedisCancelRegistry(CancelRegistry):
    """生产实现:Redis live key。

    - register: SET ai:chat:{conv_id}:live 1
    - is_live:  EXISTS ai:chat:{conv_id}:live
    - cancel:   GETDEL ai:chat:{conv_id}:live
    """

class InProcessCancelRegistry(CancelRegistry):
    """降级/单测实现:进程内 asyncio.Event。

    无 Redis 依赖;单测更快更确定。
    """
```

---

## 7. 取消协议(V2 更新 — 基于 opale-ai 模式)

### 7.1 端到端流程(6 步,V1 的 5 步 + 重连)

```
1. Client: useChatStream.stop()
     ├─ controller.abort()                        # 关本地 SSE 读取
     └─ fetch POST /conversations/{id}/cancel    # 通知后端(异步,不等 ack)
            ↓
2. Server: cancel endpoint
     ├─ 鉴权 + 校验 conversation 归属
     └─ cancel_registry.request_cancel(conv_id)  # GETDEL live_key
            ↓
3. Server: Orchestrator.run() 下次 node 迭代前
     ├─ if not await cancel_registry.is_live(conv_id):
     │    raise CancelledError()
     │    # → bus.add_error(ProtocolError(CANCELLED))
     └─ else: continue streaming
            ↓
4. Server: 清理
     ├─ await asyncio.to_thread(db.rollback)      # 未提交的部分写入回滚
     ├─ bus.stop()                                # DEL live_key + expire stream
     └─ StreamRunner 结束(后台 task 完成)
            ↓
5. Client: 收到 error{CANCELLED}(如果 SSE 仍开)
     ├─ codec 解析 error{CANCELLED} → 静默清理,不显示 toast
     └─ 若已 abort:无更多事件需处理
            ↓
6. Client(可选):重连
     ├─ 记录最后收到的 SSE event id(Redis Stream entry_id)
     └─ 重新 fetch 带 Last-Event-ID header → 服务端从该 offset 续传
```

### 7.2 乐观取消(沿用 V1)

Client 不等服务端 ack,`stop()` 立即清空 streaming 状态,UI 立即恢复可编辑。后端延迟取消(最多一次 node 迭代)不影响 UX。

### 7.3 `request.is_disconnected()` 保留作为兜底

仅在客户端断网(无法调 `/cancel`)时触发。后端 `subscribe()` 循环检测断连,主动触发 cancel。

---

## 8. 断连重连(V2 新增)

### 8.1 机制

Redis Stream 天然保留历史 entry。客户端断线重连时,带 `Last-Event-ID` header(值为最后收到的 Redis Stream entry_id),服务端从该 ID 之后续传。

### 8.2 SSE 响应格式

每个 SSE 事件携带 `id` 字段(Redis Stream entry_id):

```
id: 1719897600000-0
data: {"type":"message_start","message_id":"...","model":"...","role":"assistant","created_at":1719897600000}

id: 1719897600001-0
data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}

```

客户端解析 `id` 并存储,重连时放入 `Last-Event-ID` header。

### 8.3 端点

```
POST /conversations/{id}/stream       — 首次请求(无 Last-Event-ID)或重连(带 Last-Event-ID)
POST /conversations/{id}/cancel      — 取消(独立)
```

> 不单独开 `/resume` 端点;`/stream` 端点根据 `Last-Event-ID` header 自动判断是从头开始还是续传。

### 8.4 边界情况

| 场景 | 处理 |
|---|---|
| Stream 已过期(TTL 24h) | `subscribe` 返回 `error{INTERNAL, "stream expired"}` |
| agent 已完成(live_key 不存在但 Stream 有 `end` 标记) | 从 `last_event_id` 续传到 `end` 后正常关闭 |
| agent 已取消(live_key 不存在,Stream 有 `error{cancelled}`) | 续传到 `error` 后正常关闭 |
| 重复 `run()`(同一 conv 两个并发流) | `register` 检测 live_key 已存在 → 返回 `error{VALIDATION, "stream already active"}` |

---

## 9. agent.iter() Node 模型(V2 变更 — 替代 run_stream_events)

### 9.1 为什么换

| `run_stream_events()`(当前) | `agent.iter()`(V2) |
|---|---|
| 事件扁平,不区分第几次 LLM 调用 | **node 级迭代**,每次 model request 是一个 node |
| 多轮 tool 调用时事件混在一起 | 可观测"第 1 次思考""第 2 次思考(带 tool 结果)" |
| 取消粒度:每个 part event | 取消粒度:每个 **node 迭代前**(更精确) |
| 无 node begin/end 标记 | 有 node begin/end(可映射到未来协议扩展) |

### 9.2 核心模式(opale-ai 验证)

```python
async with agent.iter(
    user_prompt, message_history=message_history, deps=deps
) as agent_run:
    async for node in agent_run:
        # 取消检查点:每次 node 迭代前
        if not await cancel_registry.is_live(conversation_id):
            raise CancelledError()

        if Agent.is_model_request_node(node):
            # node 开始 → 可选:发可观测事件(不进协议层,走结构化日志)
            await bus.add(conversation_id, ProtocolEvent(...))  # message_start 等

            async with node.stream(agent_run.ctx) as node_stream:
                async for event in node_stream:
                    # event: PartStartEvent / PartDeltaEvent / PartEndEvent / FinalResultEvent
                    protocol_event = map_node_event_to_protocol(event, state)
                    if protocol_event:
                        await bus.add(conversation_id, protocol_event)

            # node 结束
    # agent_run.result 包含最终结果(usage / new_messages)
```

### 9.3 node 事件 → ProtocolEvent 映射

| pydantic-ai node 事件 | ProtocolEvent | 说明 |
|---|---|---|
| 第一个 ModelRequestNode 开始 | `MessageStart` | 流开始 |
| `PartStartEvent` + `TextPart` | `ContentBlockStart{text}` | 文本块开始 |
| `PartStartEvent` + `ThinkingPart` | `ContentBlockStart{thinking}` | 思考块开始 |
| `PartStartEvent` + `ToolCallPart` | `ContentBlockStart{tool_use}` | 工具调用开始 |
| `PartDeltaEvent` + `TextPartDelta` | `ContentBlockDelta{text_delta}` | 文本增量 |
| `PartDeltaEvent` + `ThinkingPartDelta` | `ContentBlockDelta{thinking_delta}` | 思考增量 |
| `PartDeltaEvent` + `ToolCallPartDelta` | `ContentBlockDelta{input_json_delta}` | 工具参数增量 |
| `PartEndEvent` + `ToolCallPart` | `ContentBlockStop` | 工具调用参数完整 |
| `PartEndEvent` + `TextPart` | `ContentBlockStop` | 文本块结束 |
| `FinalResultEvent` | `MessageDelta{usage, stop_reason}` | 最终结果 |
| agent_run 结束 | `MessageStop` | 流结束 |
| tool 执行完成(via ToolReturnPart) | `ContentBlockStart{tool_result}` + `ContentBlockStop` | 工具结果(本仓库扩展) |

### 9.4 与当前 `stream_mapper.py` 的关系

`stream_mapper.py` 的 `map_agent_event()` 逻辑**迁移**到 `orchestrator/runner.py` 的 `_emit_node_event()` 方法。映射逻辑本身变化不大(都是 PartDeltaEvent → ContentBlockDelta),但:
- 输出从 ndjson bytes 改为 `ProtocolEvent` Pydantic 对象(由 encoder 统一编码)
- 增加了 node 级别的 begin/end 生命周期(可观测用)
- tool_result 映射为 `ContentBlockStart{tool_result}` + `ContentBlockStop`(而非当前的 `sources` + `tool_done` 自定义事件)

---

## 10. 错误分类(V2 强化 — ErrorCode 落地)

### 10.1 ErrorCode 枚举(沿用 V1 §5.1)

```python
class ErrorCode(str, Enum):
    NETWORK = "network"
    TIMEOUT = "timeout"
    LLM_5XX = "llm_5xx"
    LLM_4XX = "llm_4xx"
    RATE_LIMIT = "rate_limit"
    CONTENT_FILTER = "content_filter"
    CANCELLED = "cancelled"
    VALIDATION = "validation"
    INTERNAL = "internal"
    PERSISTENCE = "persistence"
    TOOL_ERROR = "tool_error"
```

### 10.2 异常 → ErrorCode 分类器(V2 新增)

```python
# orchestrator/runner.py

def classify_error(exc: Exception) -> ProtocolError:
    """把任意异常分类为 typed ProtocolError。"""
    if isinstance(exc, CancelledError):
        return ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
    if isinstance(exc, asyncio.TimeoutError):
        return ProtocolError(code=ErrorCode.TIMEOUT, message="LLM 响应超时")
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 429:
            return ProtocolError(code=ErrorCode.RATE_LIMIT, message="限流",
                                 retry_after=_parse_retry_after(exc))
        if 500 <= status < 600:
            return ProtocolError(code=ErrorCode.LLM_5XX, message=f"LLM {status}")
        if 400 <= status < 500:
            return ProtocolError(code=ErrorCode.LLM_4XX, message=f"LLM {status}")
    if isinstance(exc, SQLAlchemyError):
        return ProtocolError(code=ErrorCode.PERSISTENCE, message="数据库错误")
    # 默认
    return ProtocolError(code=ErrorCode.INTERNAL, message=str(exc) or "内部错误")
```

### 10.3 前端动作矩阵(沿用 V1 §5.2,确认)

---

## 11. 前端模块结构(V2 更新)

```
frontend/components/chat/
├── protocol/                    # 协议层(新,与后端对称)
│   ├── events.ts               #   TS union types(对应 ProtocolEvent)
│   ├── codec.ts                #   SSE bytes ↔ TypedEvent(含 id 解析)
│   ├── errors.ts               #   ErrorCode TS union + 重试策略
│   └── index.ts
├── hooks/
│   ├── useChatStream.ts        # 重写:基于 protocol + 主动 /cancel + resume
│   └── useCancelStream.ts      # (新)取消 hook:fetch /cancel + AbortController
└── lib/api/
    └── ai-chat-stream.ts       # 重写:基于 protocol codec
```

### 11.1 useChatStream 关键变化

```typescript
// V2 关键:stop() 调后端 /cancel + 存 last-event-id 供重连
const stop = useCallback(() => {
  // 1. abort 本地 fetch
  abortRef.current?.abort()
  // 2. 通知后端(异步,不等 ack — 乐观取消)
  fetch(`/api/ai-chat/conversations/${cid}/cancel`, { method: 'POST' })
  setIsStreaming(false)
}, [])

// V2 关键:重连支持
const resume = useCallback(async () => {
  const lastEventId = lastEventIdRef.current
  const res = await fetch(`/api/ai-chat/conversations/${cid}/stream`, {
    headers: { 'Last-Event-ID': lastEventId ?? '' },
  })
  // ... consumeStream(res, callbacks)
}, [])
```

### 11.2 codec.ts 解析 SSE(含 id 字段)

```typescript
// 标准 SSE 解析:data: {json}\n\n + id: {stream_entry_id}
function parseSSEChunk(chunk: string): { id?: string; event: ProtocolEvent }[] {
  // 解析 "id: xxx\ndata: {json}\n\n" 格式
  // 存储 id 供 Last-Event-ID 重连
}
```

---

## 12. 阶段规划(V2 更新 — P4 合并进 P1)

| Phase | 范围 | V1 vs V2 | 估时 |
|---|---|---|---|
| **P1 协议+编排器+取消** | protocol 模块 + orchestrator(Redis Stream 解耦) + agent.iter + 端点重写 + useChatStream 重写 + **取消前端接入** + **resume** | V2: P1 吸收 V1 的 P4(Redis cancel) | 3-4 周 |
| **P2 路由/端点清理** | 取消 `regenerate + web_search=False → 400`;解耦;统一错误码 | 不变 | 0.5-1 周 |
| **P3 可观测性** | Prometheus metrics + 结构化 JSONL logger + OpenTelemetry(可选) | 不变 | 1-2 周 |
| ~~P4 并发/可扩展~~ | ~~cancel_registry 改 Redis~~ | **V2: 合并进 P1** | ~~1-2 周~~ |
| **P5 e2e 体系** | Playwright + 后端真流 + 前端 UI 全链路 | 不变 | 1-2 周 |
| **P6 搜索质量** | SearXNG 中文质量优化 | 不变 | 1-2 周 |

**V2 总估时**:6-9 周(P1 加重但 P4 消除,净增约 1 周)。

---

## 13. 测试策略(V2 更新)

### 13.1 协议层纯单测(沿用 V1 §9.1)

- `tests/protocol/test_encoder.py`:ProtocolEvent → SSE bytes round-trip
- `tests/protocol/test_events.py`:discriminated union 校验、非法 type 拒绝

### 13.2 编排器单测(V2 更新 — fakeredis)

```
tests/orchestrator/
├── conftest.py                 # fakeredis fixture
├── test_runner.py              # StreamRunner: fake agent.iter → 断言 Redis Stream 事件序列
├── test_cancel.py              # CancelRegistry: Redis + InProcess 双实现
├── test_resume.py              # 断连重连:subscribe(from_id=last_id) 续传
├── test_error_classification.py # classify_error: 各异常类型 → ErrorCode
└── test_stream_bus.py          # RedisStreamBus: xadd/xread/expiry
```

关键测试用例:

```python
# test_runner.py
async def test_run_emits_message_start_content_blocks_message_stop(fakeredis, fake_agent):
    """完整 happy path:agent.iter 产出文本 → Stream 事件序列正确。"""
    runner = StreamRunner(bus=RedisStreamBus(fakeredis), cancel_registry=...)
    task = asyncio.create_task(runner.run(conv_id, fake_agent, "hi", []))
    events = [e async for e in runner.subscribe(conv_id)]
    assert events[0].type == "message_start"
    assert any(e.type == "content_block_delta" for e in events)
    assert events[-1].type == "message_stop"

async def test_cancel_emits_error_cancelled(fakeredis, fake_agent):
    """取消:GETDEL live_key → agent 下次 is_live() 检测到 → error{cancelled}。"""
    runner = StreamRunner(bus=RedisStreamBus(fakeredis), cancel_registry=...)
    task = asyncio.create_task(runner.run(conv_id, fake_agent_slow, "hi", []))
    await asyncio.sleep(0.1)  # 让 agent 开始
    await runner.cancel(conv_id)
    events = [e async for e in runner.subscribe(conv_id)]
    assert any(e.type == "error" and e.error.code == "cancelled" for e in events)

async def test_resume_from_last_event_id(fakeredis, fake_agent):
    """重连:subscribe(from_id=last_id) 只返回 last_id 之后的事件。"""
    runner = StreamRunner(...)
    task = asyncio.create_task(runner.run(conv_id, fake_agent, "hi", []))
    # 消费前 3 个事件
    first_batch = []
    async for e in runner.subscribe(conv_id):
        first_batch.append(e)
        if len(first_batch) == 3:
            last_id = e.id
            break
    # 重连,续传
    rest = [e async for e in runner.subscribe(conv_id, from_id=last_id)]
    assert rest[0].id != last_id  # 从 last_id 之后开始
    assert rest[-1].type == "message_stop"

async def test_error_emits_typed_error(fakeredis, fake_agent_5xx):
    """agent 抛 5xx → error{llm_5xx}。"""
    events = [e async for e in runner.subscribe(conv_id)]
    assert any(e.type == "error" and e.error.code == "llm_5xx" for e in events)
```

### 13.3 端点 e2e(沿用 V1 §9.3 + V2 增量)

```
tests/api/test_ai_chat_stream_v2.py:
├── happy path: 文本流 / 思考流 / 工具流
├── 取消: POST /cancel → error{cancelled} + message_stop
├── 错误: mock agent 抛 5xx → error{llm_5xx}
├── resume: 断连重连带 Last-Event-ID → 续传
├── 并发: 同 conv 两个并发流 → 第二个 error{validation}
└── 自动标题: 首轮默认标题 → MessageStop 后 title 变化
```

### 13.4 前端单测

```
frontend/lib/api/__tests__/ai-chat-stream.test.ts:
├── codec 解析 SSE bytes → TypedEvent
├── id 字段提取 + Last-Event-ID 存储
├── error{cancelled} → 静默(不调 onError toast)
├── error{rate_limit} → 带 retry_after
└── 断线重连:模拟 abort → resume → 续传
```

### 13.5 测试基础设施

| 工具 | 用途 |
|---|---|
| `fakeredis` (`fakeredis.aioredis.FakeRedis`) | 编排器单测,无需真实 Redis |
| `pydantic-ai TestModel` | fake agent,`agent.iter()` 可用 TestModel 驱动 |
| `pytest-asyncio` | 异步测试 |
| `TestClient` (FastAPI) | 端点 e2e |

---

## 14. Spike 计划(最小验证)

### 14.1 目标

验证 V2 核心架构(执行/分发解耦 + Redis Stream + 取消 + 重连)在项目环境中**端到端可跑通**。

### 14.2 Spike 范围

```
openSourceProjects/ai-app-layer-spike/
├── README.md                   # Spike 说明 + 运行方式
├── pyproject.toml              # 依赖:fastapi, pydantic-ai, redis, fakeredis
├── spike/
│   ├── protocol.py             # 最小 ProtocolEvent 定义(3-4 个事件够验证)
│   ├── encoder.py              # SSE encoder
│   ├── stream_bus.py           # RedisStreamBus(xadd/xread/listen)
│   ├── cancel.py               # CancelRegistry(Redis + InProcess)
│   ├── runner.py               # StreamRunner(run + subscribe + cancel)
│   ├── agent_factory.py        # fake agent(TestModel 或自定义 node 序列)
│   └── app.py                  # FastAPI 端点(/stream + /cancel)
├── tests/
│   ├── conftest.py             # fakeredis fixture
│   ├── test_runner.py          # happy path + cancel + resume + error
│   └── test_endpoint.py        # FastAPI TestClient e2e
└── Makefile                    # make test / make run
```

### 14.3 Spike 验收标准

| # | 场景 | 验收 |
|---|---|---|
| 1 | happy path | POST /stream → 收到 message_start → content_block_delta ×N → message_stop |
| 2 | 取消 | POST /cancel → 收到 error{cancelled} → agent 后台停止 |
| 3 | 重连 | 消费 3 个事件后断开 → 重连带 Last-Event-ID → 续传剩余事件 |
| 4 | 错误 | agent 抛异常 → 收到 error{对应 ErrorCode} |
| 5 | 跨 worker 模拟 | 两个进程(两个 fakeredis 不行,需真 Redis)→ 进程 A cancel → 进程 B 的 agent 停止 |
| 6 | InProcess 降级 | 不用 Redis,InProcessCancelRegistry → 取消仍工作 |

### 14.4 Spike 约束

- **不连真后端**:独立 FastAPI app,fake agent(TestModel / 自定义)
- **不连真 LLM**:用 `TestModel` 或手写 fake node 序列
- **Redis**:单测用 fakeredis;跨 worker 验证用 `docker run redis`
- **不碰前端**:纯后端 Spike,curl / httpx 验证

---

## 15. 风险与缓解(V2 更新)

| 风险 | 影响 | 缓解 |
|---|---|---|
| Redis Stream 内存增长 | 长对话占用 Redis 内存 | Stream TTL 24h + `MAXLEN ~ 10000` 截断 |
| `agent.iter()` API 与 `run_stream_events()` 行为差异 | node 事件序列可能不同 | Spike 先验证;映射表 §9.3 覆盖 |
| fakeredis 对 Stream 支持完整度 | 单测可能漏时序 bug | fakeredis 2.x 支持 Stream;Spike 用真 Redis 验证一次 |
| 后台 task 异常无人感知 | agent crash 但 HTTP 已返回 | `run()` 的 except 把 error 写入 Stream;subscribe 消费到 error 后关闭 |
| resume 时 agent 已结束 | 客户端重连但流已结束 | subscribe 检测 `end` 标记 → 正常关闭(不发 error) |
| V1 代码迁移风险(删除 stream_mapper/cancel) | 现有测试要重写 | 1:1 翻译;保留旧代码到 P1 PR 合并后再删 |

---

## 16. 决策日志

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-19 | 执行/分发解耦 + Redis Stream(opale-ai 模式) | 项目已有 Redis;跨 worker 取消 + 断连重连免费获得;P4 消除 |
| 2026-07-19 | `agent.iter()` 替代 `run_stream_events()` | node 粒度可观测;取消检查点更精确;opale-ai 验证 |
| 2026-07-19 | 断连重连纳入 P1 | 解耦模式免费获得;Redis Stream last_id 机制天然支持 |
| 2026-07-19 | CancelRegistry 保留进程内降级 | 单测确定性;Redis 挂时 cancel 仍工作;成本极低(一个接口两个实现) |
| 2026-07-19 | 不引入 origin 字段 | 保持 Anthropic 协议纯净;可观测走结构化日志 |
| 2026-07-19 | 协议层沿用 V1 设计(Anthropic Messages SSE) | 经 Anthropic 官方 SDK 验证;V1 写法正确 |
| 2026-07-19 | P4 合并进 P1 | Redis Stream 解耦在 P1 直接到位,无需延后 |

---

## 17. 开放问题(待 Spike / P1 实施时决策)

| 问题 | 默认倾向 | 何时定 |
|---|---|---|
| Redis Stream MAXLEN / TTL 具体值 | MAXLEN ~10000 + TTL 24h | Spike |
| `agent.iter()` 的 `node.stream()` 是否支持 Thinking capability | 需 Spike 验证 | Spike |
| resume 超时窗口(agent 跑完多久后 Stream 仍可 resume) | TTL 24h 内均可 | Spike |
| 后台 task 的 GC(客户端永不重连时) | Stream TTL 自动清理 + live_key TTL 1h | P1 |
| 是否需要 `GET /conversations/{id}/stream/status` 查询流状态 | **否**;前端用 resume 试探即可 | P1 后评估 |
| attached_file 注入方式是否随 agent.iter 变化 | **不变**;仍 fold 进 user_prompt | P1 |

---

## 18. 后续

1. **本文档确认后** → 做 Spike(`openSourceProjects/ai-app-layer-spike/`),验证 §14 验收标准
2. **Spike 通过后** → 由 writing-plans 创建 P1 实现 plan,放 `docs/superpowers/plans/2026-07-19-ai-application-layer-v2/`
3. **V1 spec 标注** "已被 V2 取代"(不删除,保留历史)

---

## 附录 A:V1 与 V2 完整文件处置对比

| 文件 | V1 处置 | V2 处置 | 变更 |
|---|---|---|---|
| `services/ai/agent.py` | 保留并加强 | 保留;`build_chat_agent` 沿用;换 `agent.iter()` | API 变 |
| `services/ai/chat.py` | 保留 | 保留 | 不变 |
| `services/ai/search.py` | 保留 | 保留 | 不变 |
| `services/ai/stream_utils.py` | 瘦身 | 瘦身(或删除,encoder 接管) | V2 更彻底 |
| `services/ai/stream_mapper.py` | 删除 | 删除(迁移到 `orchestrator/runner.py`) | 不变 |
| `services/ai/cancel.py` | 删除 | 删除(迁移到 `orchestrator/cancel.py`) | 不变 |
| `api/v1/endpoints/ai_chat.py` | 重写 | 重写(更瘦:只 subscribe + cancel) | V2 更瘦 |
| `protocol/`(新) | 新建 | 新建(沿用 V1 设计) | 不变 |
| `orchestrator/`(新) | 新建(run + cancel + lifecycle) | 新建(增 stream_bus + Redis 解耦) | **V2 核心** |
| `frontend/.../useChatStream.ts` | 重写 | 重写(增 cancel 调用 + resume) | V2 增强 |
| `frontend/.../ai-chat-stream.ts` | 重写 | 重写(codec 解析 id 字段) | V2 增强 |
