# 设计文档:AI Chat 架构重设计(协议优先 · 6 阶段)

- 关联 issue:无(全局 AI 改造,跨前后端)
- 状态:设计稿 v1(待用户审查)
- 范围:本次仅产出设计文档,**不写实现代码**;确认后由 writing-plans 拆实现计划
- 日期:2026-07-17

> **核心约束(用户拍板):** 现有 `ai_chat.py` / `stream_mapper.py` / `agent.py` 等代码视为「**参考痛点**」,**不当作设计基础**。本设计从成熟实践(Anthropic Messages SSE、Vercel AI SDK、Pydantic AI 官方、FastAPI SSE 模式)出发,系统化重建 AI chat 架构。所有 AI 后端走 **Pydantic 系统化** 路线。

---

## 1. 目标与非目标

**目标**

- 重做 AI chat 端到端架构,根治 7 个用户确认的功能性/体验盲点。
- 建立**协议层(Protocol)** 单一真实来源:后端 encoder + 前端 codec 对称,任何一端可独立演进。
- 后端 AI 编排全面 Pydantic 化(`pydantic.BaseModel` typed messages、typed tools、typed errors、typed events),替换散落的 dict / 字符串。
- 端到端**可观测**(P1 留 hook,P3 落地 metrics),**可取消**(双向),**可扩展**(换 Agent / 换 LLM provider 不动协议)。

**非目标(YAGNI,本期不做)**

- 不引入 LangChain / LangServe / Vercel AI SDK 作为运行时依赖(只参考其设计模式)。
- 不重做 LLM provider 路由(已存在的 `ai_chat_provider_base_url` 配置沿用)。
- 不解决 SearXNG 中文搜索质量(独立 ticket,Phase P6 单独处理)。
- 不改前端 UI 视觉设计(动效、布局、配色);只动 `useChatStream` 协议层。
- 不引入 streaming tool calls(原生 Pydantic AI 单次 tool call 即可,流式 tool 是独立 ticket)。
- 不改前端 NextAuth、proxy 路由、消息持久化表结构。

---

## 2. 已确认的关键决策

来自对话中用户拍板:

| # | 问题 | 决策 |
|---|------|------|
| Q1 | 重设计理由 | **A. 功能性 bug / 体验问题**(从根上理干净,不是打补丁) |
| Q2 | 7 个盲点范围 | **全部纳入**:取消不工作、regenerate 400、可观测性、错误处理、并发 cancel、SearXNG 质量、e2e |
| Q3 | 阶段切分 | **方案 A 协议优先**(P1 协议重设计 → P2 路由 → P3 可观测 → P4 并发 → P5 e2e → P6 搜索) |
| Q4 | 协议参考 | **Anthropic Messages SSE 风格**(`message_start / content_block_* / message_delta / message_stop / ping / error`) |
| Q5 | 取消跨 worker | 假设要 **Redis pub/sub**;P1 进程内 Event 起步,P4 换 Redis |
| Q6 | 传输格式 | **`text/event-stream`**(替换现有 `application/x-ndjson`) |
| Q7 | 现有代码处置 | **不集成**(现有 ai_chat.py / stream_mapper.py / agent.py 不作设计基础) |
| Q8 | 文档落点 | Spec → `docs/superpowers/specs/`;Plan → `docs/superpowers/plans/<slug>/` 子目录 |

---

## 3. 架构总览

### 3.1 系统分层(4 层后端 + 2 层前端 + 1 协议层)

```
┌───────────────────────── Frontend (Next.js) ─────────────────────────┐
│                                                                       │
│  useChatStream(protocol)          ← 协议层 + React hook(新)          │
│   ├─ Protocol codec (encode/decode SSE 事件)                         │
│   ├─ Transport (fetch + AbortController)                             │
│   ├─ Cancel: 主动 fetch + 端点 /cancel(新)                           │
│   └─ State: messages / status / error                                │
│                                                                       │
│  ChatPanel → protocol → fetch /api/ai/...                             │
└─────────────────────────┬─────────────────────────────────────────────┘
                          │  text/event-stream over HTTPS
                          │  协议: Anthropic-style 事件序列
                          │  取消: 独立 POST /cancel 端点(纯 HTTP)
                          ▼
┌───────────────────────── Backend (FastAPI) ──────────────────────────┐
│                                                                       │
│  Router (瘦化)                                                        │
│   POST /conversations/{id}/stream    ← 流式端点                       │
│   POST /conversations/{id}/cancel    ← 取消端点(新)                   │
│                                                                       │
│  Orchestrator (新)                                                    │
│   ├─ 生命周期: start → running → done / aborted / error              │
│   ├─ Cancel registry(P1 进程内 Event;P4 Redis pub/sub)               │
│   ├─ Observability hooks(start/cancel/finish/usage)                  │
│   └─ Errors: typed error 事件 + 退避策略                              │
│                                                                       │
│  Pydantic AI Agent(沿用,不改)                                         │
│   ├─ Tools(web_search 等)                                             │
│   └─ Pydantic-typed messages                                          │
│                                                                       │
│  Persistence(SQLAlchemy, sync session)                                │
│   └─ 在流开始/结束各触一次,中间不持连接                                │
└───────────────────────────────────────────────────────────────────────┘

          Protocol Layer(协议层,后端 + 前端对称)
          ┌─────────────────────────────────┐
          │ events.py / events.ts            │
          │ encoder.py / codec.ts            │
          │ errors.py / errors.ts            │
          │ MessageStart / ContentBlockStart │
          │ ContentBlockDelta / MessageStop  │
          │ ErrorCode(Python enum + TS union)│
          └─────────────────────────────────┘
```

### 3.2 核心设计原则

1. **协议层独立** — 纯事件定义 + SSE 编解码,不知道 Pydantic AI / FastAPI / React。
2. **编排器是粘合层** — 协议层 ↔ Agent ↔ Persistence;生命周期、取消、可观测性 hook 集中此处。
3. **端点只做路由** — 鉴权 + DB 初始化 + 调 `StreamRunner.run()`,无业务逻辑。
4. **错误 typed 化** — `ErrorCode` 枚举贯穿协议 / 后端 / 前端;前端按码分支,不做字符串匹配。
5. **取消双向** — 客户端调独立 `/cancel` 端点,后端 cancel registry 标记;不再依赖 `request.is_disconnected()` 单独路径。

### 3.3 现有代码处置(明确)

| 现有文件 | 处置 |
|---|---|
| `backend/app/services/ai/agent.py` | **保留并加强**:加 typed Messages、typed Tools |
| `backend/app/services/ai/chat.py` | **保留**:DB 操作与 `DEFAULT_CONVERSATION_TITLE` 沿用 |
| `backend/app/services/ai/search.py` | **保留**:`build_search_source_cards` 沿用 |
| `backend/app/services/ai/stream_utils.py` | **瘦身**:只留低层 byte 工具,删编码器 |
| `backend/app/services/ai/stream_mapper.py` | **删除**:职责并入 `protocol/events.py` + `orchestrator/runner.py` |
| `backend/app/services/ai/cancel.py` | **删除**:迁移到 `orchestrator/cancel.py` |
| `backend/app/api/v1/endpoints/ai_chat.py` | **重写**:路由 + 调 StreamRunner |
| `frontend/components/chat/hooks/use-chat-stream.ts` | **重写**:基于 protocol + 主动 `/cancel` |
| `frontend/lib/api/ai-chat-stream.ts` | **重写**:基于 protocol codec |

---

## 4. 协议事件定义(Anthropic Messages SSE 风格)

### 4.1 传输

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache, no-transform`
- 每行: `data: {json}\n\n`(空行分隔事件)
- `data: [DONE]` 不用(用 `message_stop` 替代,Anthropic 风格)

### 4.2 事件序列(正常路径)

```
message_start
  content_block_start        {index, content_block: {type, ...}}
  content_block_delta × N    {index, delta: {type, ...}}
  content_block_stop         {index}
  ...可重复多个 content_block...
message_delta                {usage, stop_reason}
message_stop
```

### 4.3 事件类型清单

| 事件 | Payload | 触发时机 |
|---|---|---|
| `message_start` | `{message_id, model, role: "assistant", created_at}` | 流开始,一次 |
| `content_block_start` | `{index, content_block: {type, ...type-specific}}` | 文本/思考/工具块开始 |
| `content_block_delta` | `{index, delta: {type: "text_delta"\|"thinking_delta"\|"input_json_delta", text\|partial_json}}` | 内容增量 |
| `content_block_stop` | `{index}` | 内容块结束 |
| `message_delta` | `{usage: {input_tokens, output_tokens, total_tokens}, stop_reason: null\|"end_turn"\|"tool_use"\|"cancelled"}` | 消息级元信息更新 |
| `message_stop` | `{}` | 流正常结束,一次 |
| `ping` | `{}` | keepalive(每 15s,防止代理超时) |
| `error` | `{error: {code, message, retry_after?}}` | 错误,见 §5 |

### 4.4 content_block.type 扩展

| type | 用途 | content_block 字段 |
|---|---|---|
| `text` | 助手文本输出 | (无,初始) |
| `thinking` | 思考链(reasoning) | (无,初始) |
| `tool_use` | LLM 调用工具 | `{id, name, input}` (input 流式通过 `input_json_delta`) |
| `tool_result` | 工具返回结果(本仓库扩展) | `{tool_use_id, content, is_error, sources?}` |

> **Anthropic 官方不显式发 `tool_result`**(他们把 tool_result 折进 user 消息,新一轮对话由 user 角色带回去);本仓库显式发出,前端可直接渲染 search sources。

### 4.5 Pydantic 定义(后端)

```python
# protocol/events.py
from __future__ import annotations
from typing import Annotated, Literal, Union
from pydantic import BaseModel, Field


# ── content blocks ──
class TextBlock(BaseModel):
    type: Literal["text"] = "text"

class ThinkingBlock(BaseModel):
    type: Literal["thinking"] = "thinking"

class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict = Field(default_factory=dict)

class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str | list
    is_error: bool = False
    sources: list[dict] | None = None  # 扩展:tavily 搜索结果 cards


ContentBlock = Annotated[
    Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock],
    Field(discriminator="type"),
]


# ── deltas ──
class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str

class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    text: str

class InputJSONDelta(BaseModel):
    type: Literal["input_json_delta"] = "input_json_delta"
    partial_json: str

Delta = Annotated[
    Union[TextDelta, ThinkingDelta, InputJSONDelta],
    Field(discriminator="type"),
]


# ── events ──
class MessageStart(BaseModel):
    type: Literal["message_start"] = "message_start"
    message_id: str
    model: str
    role: Literal["assistant"] = "assistant"
    created_at: int  # unix ms

class ContentBlockStart(BaseModel):
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: ContentBlock

class ContentBlockDelta(BaseModel):
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: Delta

class ContentBlockStop(BaseModel):
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int

class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

class MessageDelta(BaseModel):
    type: Literal["message_delta"] = "message_delta"
    usage: Usage
    stop_reason: Literal["end_turn", "tool_use", "cancelled", "refusal"] | None = None

class MessageStop(BaseModel):
    type: Literal["message_stop"] = "message_stop"

class Ping(BaseModel):
    type: Literal["ping"] = "ping"

class ProtocolError(BaseModel):
    code: str  # ErrorCode.value
    message: str
    retry_after: int | None = None  # 仅 RATE_LIMIT / TIMEOUT 时设置

class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    error: ProtocolError


ProtocolEvent = Annotated[
    Union[
        MessageStart, ContentBlockStart, ContentBlockDelta, ContentBlockStop,
        MessageDelta, MessageStop, Ping, ErrorEvent,
    ],
    Field(discriminator="type"),
]
```

---

## 5. 错误码(ErrorCode)

### 5.1 枚举定义

```python
# protocol/errors.py
from enum import Enum

class ErrorCode(str, Enum):
    NETWORK = "network"            # 网络层失败(fetch / DNS / TLS)
    TIMEOUT = "timeout"            # LLM 响应超时(> settings.ai_chat_timeout_seconds)
    LLM_5XX = "llm_5xx"            # LLM provider 5xx
    LLM_4XX = "llm_4xx"            # LLM 4xx(参数/上下文长度)
    RATE_LIMIT = "rate_limit"      # 限流(429)
    CONTENT_FILTER = "content_filter"  # LLM 内容安全拒绝
    CANCELLED = "cancelled"        # 用户主动取消
    VALIDATION = "validation"      # 输入校验失败(空内容/超长)
    INTERNAL = "internal"          # 未捕获异常
    PERSISTENCE = "persistence"    # DB 写失败
    TOOL_ERROR = "tool_error"      # 工具调用失败(SearXNG 5xx / 解析失败)
```

### 5.2 前端动作矩阵

| Code | 显示 toast | 自动重试 | 用户重试按钮 |
|---|---|---|---|
| `NETWORK` | ✅ | ✅ exponential backoff(1s/2s/4s,最多 3 次) | ✅ |
| `TIMEOUT` | ✅ | ✅ 1 次(30s 后) | ✅ |
| `LLM_5XX` | ✅ | ✅ 1 次 | ✅ |
| `LLM_4XX` | ✅(具体原因) | ❌ | ✅ |
| `RATE_LIMIT` | ✅ | ❌(等 `retry_after` 秒后由用户触发) | ✅ |
| `CONTENT_FILTER` | ✅ | ❌ | ✅(修改输入) |
| `CANCELLED` | ❌(静默) | ❌ | n/a |
| `VALIDATION` | ✅ + 红框 | ❌ | n/a(改输入) |
| `INTERNAL` | ✅ + 上报 | ❌ | ✅ |
| `PERSISTENCE` | ✅(数据可能丢失) | ✅ 1 次(仅 retry 持久化) | ✅ |
| `TOOL_ERROR` | ⚠️ 占位提示,继续流 | ❌ | n/a |

---

## 6. 取消协议(端到端,5 步)

```
1. Client: useChatStream.stop()
     ├─ controller.abort()                       # 关本地 SSE 读取
     └─ fetch POST /conversations/{id}/cancel   # 通知后端
            ↓
2. Server: cancel_stream endpoint
     ├─ 鉴权 + 校验 conversation 归属
     └─ cancel_registry.mark(conversation_id)  # 进程内 Event.set() / Redis pub
            ↓
3. Server: StreamRunner 下次 LLM 迭代前
     ├─ if cancel_registry.is_set(conversation_id):
     │    raise CancelledError
     │    # 编码 error{CANCELLED} + message_stop
     └─ else: continue streaming
            ↓
4. Server: 清理
     ├─ db.rollback(未提交的部分写入)
     ├─ cancel_registry.unregister(conversation_id)
     └─ 关闭 SSE 连接
            ↓
5. Client: 收到(或未收到)error{CANCELLED}
     ├─ 若已 abort 主动关闭:无更多事件需处理
     └─ 若 SSE 仍开:codec 解析 error{CANCELLED} → 静默清理,不显示 toast
```

**乐观取消**:Client 不等服务端 ack,`stop()` 立即清空 streaming 状态,UI 立即恢复可编辑。后端延迟取消(最多一次 LLM 迭代)不影响 UX。

**`request.is_disconnected()` 保留作为兜底**:仅在客户端断网(无法调 `/cancel`)时触发,日志标注为 "client_disconnect_unclean"。

---

## 7. 组件与数据流

### 7.1 后端模块结构

```
backend/app/
├── services/ai/
│   ├── protocol/                # 协议层(新)
│   │   ├── events.py            #   ProtocolEvent / ContentBlock / Delta / Usage
│   │   ├── encoder.py           #   SSEEncoder: ProtocolEvent → "data: {json}\n\n" bytes
│   │   ├── errors.py            #   ErrorCode enum + ProtocolError
│   │   └── __init__.py
│   ├── orchestrator/            # 编排器(新)
│   │   ├── runner.py            #   StreamRunner: 调 Pydantic AI Agent → emit ProtocolEvent
│   │   ├── cancel.py            #   CancelRegistry(P1 进程内 Event;P4 Redis pub/sub)
│   │   ├── lifecycle.py         #   状态机: idle / running / done / aborted / error
│   │   └── __init__.py
│   ├── observability/           # 可观测性(P1 留 hook,P3 落地)
│   │   ├── logger.py            #   结构化 JSONL logger
│   │   ├── metrics.py           #   Prometheus 接口(P3 实现)
│   │   └── __init__.py
│   ├── agent.py                 # (P1 不动)P1 之后,typed Messages 增强可作独立 ticket
│   ├── chat.py                  # (保留)DB 操作
│   ├── search.py                # (保留)build_search_source_cards
│   ├── stream_utils.py          # (瘦身)只留低层 byte 工具
│   ├── stream_mapper.py         # (删除)
│   └── cancel.py                # (删除,迁移到 orchestrator/cancel.py)
└── api/v1/endpoints/ai_chat.py  # (重写)路由 + 调 StreamRunner
```

### 7.2 前端模块结构

```
frontend/components/chat/
├── protocol/                    # 协议层(新,与后端对称)
│   ├── events.ts                #   TS union types
│   ├── codec.ts                 #   SSE bytes ↔ TypedEvent
│   ├── errors.ts                #   ErrorCode TS union
│   └── index.ts
├── hooks/
│   ├── useChatStream.ts         # 重写:基于 protocol + 主动 /cancel
│   └── useCancelStream.ts       # (新)取消 hook
└── lib/api/ai-chat-stream.ts    # 重写:基于 protocol codec
```

### 7.3 单轮对话数据流

```
[User clicks send]
  ↓
useChatStream.send(content, options)
  ↓ fetch POST /api/ai/.../stream
[Server: route handler]
  ├─ 鉴权 + DB 初始化(创建 user / assistant message rows)
  ├─ cancel_event = registry.register(conversation_id)
  └─ StreamRunner.run() → AsyncGenerator[bytes]
       ├─ protocol.encode(MessageStart(...))
       ├─ for ev in agent.run_stream_events(...):
       │    ├─ text delta        → ContentBlockStart(text) / Delta(text_delta) / Stop
       │    ├─ thinking delta    → ContentBlockStart(thinking) / Delta(thinking_delta) / Stop
       │    ├─ tool_use          → ContentBlockStart(tool_use, name, id) / Delta(input_json_delta) / Stop
       │    ├─ tool execution    → 调 tavily_search_tool()
       │    ├─ tool_result       → ContentBlockStart(tool_result, sources) / Stop
       │    └─ final             → MessageDelta(usage, stop_reason) + MessageStop
       └─ protocol.encode(MessageStop())
  ↓ SSE close
[Client: consumeStream]
  ↓ codec.parse(line) → TypedEvent → callback chain
  onStart / onTextDelta / onThinkingDelta / onToolUse / onToolResult / onUsage / onDone
```

### 7.4 关键解耦点(怎么改不互相破坏)

| 边界 | 上游 | 下游 | 改什么不互相破坏 |
|---|---|---|---|
| 协议层 | — | 编排器 / 前端 codec | 改事件类型 → 改两端 codec,中间不动 |
| 编排器 | 协议层 | Pydantic AI Agent | 换 Agent(自研 / LangChain / Anthropic SDK)→ 改 `runner.py` |
| 端点 | 编排器 | FastAPI 路由 | 换传输(SSE → WebSocket)→ 改路由 + encoder 即可 |
| 前端 protocol | — | useChatStream / UI | 加事件类型 → 改 codec + 加 callback |
| useChatStream | protocol | ChatPanel UI | 改 hook → UI 不用动(契约不变) |

---

## 8. 阶段规划(6 phases,顺次实施)

| Phase | 范围 | 解决的盲点 | 估时 | PR 数 |
|---|---|---|---|---|
| **P1 协议重设计** | protocol 模块(后端 + 前端对称)+ 编排器 + 端点重写 + useChatStream 重写;后端 ai_chat.py 完全替换;前端 useChatStream 替换 | #1(取消)+ #4(错误)+ 部分 #2(路由矩阵随端点重写顺带清) | 2-3 周 | 2-3 |
| **P2 路由/端点清理** | 端点路由矩阵重新设计:取消 `regenerate + enable_web_search=False → 400` 限制;`enable_web_search` 与 `regenerate` 解耦;统一错误码与前端映射 | #2(完整)+ #4(完整) | 0.5-1 周 | 1 |
| **P3 可观测性** | Prometheus metrics(token/延迟/取消率/错误率);结构化 JSONL logger;OpenTelemetry trace(可选);Grafana dashboard 模板 | #3 | 1-2 周 | 1-2 |
| **P4 并发/可扩展** | cancel_registry 改 Redis pub/sub;多 worker 验证;压测脚本(locust / k6);Sticky session / 客户端 cancel 路由策略 | #5 | 1-2 周 | 1-2 |
| **P5 e2e 体系** | Playwright + 后端真流 + 前端 UI 全链路;覆盖 happy / 取消 / 错误 / web_search / 自动标题 / 取消超时 | #7 | 1-2 周 | 1-2 |
| **P6 搜索质量**(独立) | SearXNG 中文质量优化(spike + query 改写 + 结果重排) | #6 | 1-2 周 | 1-2 |

**Phase 依赖**:
- P1 必须先(P2/P3/P4/P5 都依赖新协议)
- P2 与 P3 可并行(都依赖 P1,互不依赖)
- P4 依赖 P1 cancel registry 接口稳定
- P5 依赖 P1 协议稳定 + P3 部分 metrics 上线
- P6 完全独立(产品/运营问题,任何时候可启动)

**总估时**:7-12 周(单线)或 5-8 周(P2/P3 并行,全速推进)。

---

## 9. 测试策略(四层,每层独立)

### 9.1 协议层纯单测

**后端** `tests/protocol/test_encoder.py`:
- 给定 `MessageStart(...)` → 给定 `"data: {\"type\":\"message_start\",...}\\n\\n"` bytes
- 给定 `ContentBlockDelta(index=0, delta=TextDelta(text="hi"))` → 给定 bytes
- 多种事件类型 round-trip

**前端** `protocol/codec.test.ts`:
- 给定 SSE bytes → 给定 TypedEvent(用 vitest)
- 解析 `data: {...}\n\n` 边界
- 解析不完整 JSON / 心跳行

### 9.2 编排器单测

`tests/orchestrator/test_runner.py`:
- fake Agent(`async def` 返回固定 Pydantic AI 事件序列)→ 断言 emit 的 ProtocolEvent 序列
- fake cancel registry(`is_set()` 提前返回 True)→ 断言在下一个事件前 raise CancelledError
- fake Agent 抛错 → 断言 emit `ErrorEvent(code=LLM_5XX)` 后停止

### 9.3 端点 e2e

`tests/api/test_ai_chat_stream_v2.py`:
- TestModel + TestClient(沿用 Phase 1/2/3 经验)
- 覆盖:
  - happy path: 文本流 / 思考流 / 工具流
  - 取消: `POST /cancel` 后断言 `error{CANCELLED}` + `message_stop`
  - 错误: mock Agent 抛 5xx → 断言 `error{LLM_5XX}`
  - 工具: `call_tools=["tavily_search"]` 触发完整 tool 序列
  - 自动标题: 首轮默认标题 → 验证 `MessageStop` 后 conversation title 变化(协议层是否带 title 更新待定,见 §10 开放问题)

### 9.4 端到端(P5)

`e2e/chat-stream.spec.ts` (Playwright):
- 真后端 + 真前端 UI
- 覆盖: 输入 → 流式渲染 → 停止 → 取消响应 → 错误处理 → 多轮对话

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| P1 协议设计 1-2 周后发现需要小调整 | P2-P5 跟着微调,工时 +20% | 协议层 Pydantic discriminated union 强类型;协议变更是 Pydantic 错误,编译/测试时立刻暴露 |
| 现有 `stream_mapper.py` 删除风险 | 现有 4 个 mapper 测试要重写 | 1:1 翻译到 `protocol/events.py` 测试 + `orchestrator/runner.py` 测试 |
| 前端 `useChatStream` 重写风险 | 现有 chat UI 可能全断 | e2e (P5) 兜底;P1 期间保留旧 hook,新 hook 走 feature flag |
| Pydantic AI 2.9.x 事件顺序与协议设计不符 | mapper 要适配 | P1 mapper 设计阶段先做 spike 验证(已有 Phase 1 spike 经验) |
| Redis 引入 | 部署复杂度 +1 | P4 引入,提前与 ops 沟通;若不接受可降级为 sticky session + 进程内 Event(降级方案) |
| SearXNG 中文搜索质量 | 与架构重设计耦合低 | P6 独立,可推迟到 AI chat 架构稳定后 |
| 跨 worker 取消延迟(Redis pub/sub 自身 <100ms,但 LLM 迭代间隔可能 1-5s) | 用户感知取消有 1-5s 延迟 | 乐观取消:UI 立即清状态,后端延迟是后台 |

---

## 11. 决策日志

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-17 | 协议选 Anthropic Messages SSE 风格 | 事件结构清晰,tool_use / thinking 是 first-class,有公开 spec 锚定,以后可切 Vercel AI SDK |
| 2026-07-17 | 错误码 9+2 个(RATE_LIMIT / CONTENT_FILTER 独立于 LLM_4XX) | 前端动作差异显著;LLM_4XX 4xx 不可重试,RATE_LIMIT 需等 retry_after |
| 2026-07-17 | 取消协议 5 步(独立 /cancel 端点) | 不依赖 SSE 连接,客户端可主动调,支持多 worker(经 Redis) |
| 2026-07-17 | tool_result 显式作为 content_block(本仓库扩展) | 前端可直接渲染 search sources,无需根据 tool_use_id 反查 |
| 2026-07-17 | P1 期间保留旧 `useChatStream`,新 hook feature flag | 降低上线风险;旧 hook 走 ndjson 路径作为回退 |
| 2026-07-17 | 现有 `ai_chat.py` / `stream_mapper.py` / `agent.py` 不作设计基础 | 用户明确要求;现有设计是"原始无序" |
| 2026-07-17 | Spec 落 `docs/superpowers/specs/`,Plan 落 `docs/superpowers/plans/<slug>/` 子目录 | 用户指示;遵守 plans/README.md 约定 |

---

## 12. 开放问题(待 P1 实施时决策)

| 问题 | 默认倾向 | 何时定 |
|---|---|---|
| 自动标题是否进入 protocol(新增 `MessageDelta.title` 字段) | **否**;自动标题走单独 `POST /conversations/{id}/title` 端点 + 流结束时调 | P1 端点重写时 |
| `attach_file` 是否进入 protocol(新增 `file` content_block 类型) | **否**;继续在端点 prompt 构造时注入 | P1 |
| `regenerate` 是否进入 protocol(独立事件序列) | **是**;P1 顺带做,删除 `enable_web_search=False → 400` 限制 | P1 |
| SSE keepalive 间隔 | 15s(Anthropic 默认) | P1 |
| 是否引入 SSE retry / resume(Last-Event-ID) | **否**;对话场景重连即从头;P3 之后再评估 | P3 之后 |
| `ping` 事件是否暴露给前端 callback | **是**;让前端可观测连接健康 | P1 |
| 错误事件是否需要 `retry_after` 字段 | **是**;RATE_LIMIT 必须有,其他可选 | P1 |
| `MessageStop` 是否带 `conversation_id` / `message_id` 给前端 refresh | **是**;但走 `assistant_message` 字段而非另开事件 | P1 |

---

## 13. 后续

- spec 确认后,由 **writing-plans** 技能创建 6 个 phase 的实现 plan
- 全部 plan 写到 `docs/superpowers/plans/2026-07-17-ai-chat-architecture-redesign/` 子目录(从一开始就建子目录,避免完成时迁移)
- 每个 phase 单独 plan + 单独 PR 评审
