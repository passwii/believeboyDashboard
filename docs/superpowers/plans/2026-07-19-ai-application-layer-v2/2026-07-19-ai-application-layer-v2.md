# AI 应用层 V2 · P1 实现计划(主索引)

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 落地 AI 应用层 V2 架构——执行/分发解耦 + Redis Stream + Anthropic Messages SSE 协议层 + agent.iter() node 模型 + 取消端到端 + 断连重连,替换当前 ndjson + stream_mapper + 进程内 Event 的 Phase 1-3 实现。

**架构：** 编排器(StreamRunner)把 agent 执行与 HTTP 订阅解耦:agent 后台 `asyncio.create_task` 跑,事件经 Redis Stream 中转;HTTP 端点只订阅 Stream 转发 SSE。取消 = `GETDEL live_key` → agent `is_live()` 检测 → raise。重连 = `Last-Event-ID` → `xread(from=last_id)` 续传。协议层用 Anthropic Messages SSE 风格的 Pydantic discriminated union(经官方 SDK 验证)。

**技术栈：** pydantic-ai 2.9.0(`agent.iter()`)、redis-py 5.2.1(async Stream)、fakeredis 2.36(单测)、FastAPI、pytest + pytest-asyncio、Next.js + TypeScript(前端 protocol codec)

**承接文档：**
- 设计 spec:`docs/superpowers/specs/2026-07-19-ai-application-layer-redesign-v2-design.md`
- Spike 验证:`openSourceProjects/ai-app-layer-spike/`(8/8 测试通过)
- V1 设计:`docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md`(已被 V2 取代,保留历史)

---

## P1 任务总览(4 phase,按依赖顺序)

| Phase | 文件 | 范围 | 依赖 |
|---|---|---|---|
| **Phase A** | [`-phase-a-protocol-layer.md`](./2026-07-19-ai-application-layer-v2-phase-a-protocol-layer.md) | 协议层:ProtocolEvent 定义 + SSE encoder + ErrorCode enum | 无(纯定义,可独立验证) |
| **Phase B** | [`-phase-b-orchestrator.md`](./2026-07-19-ai-application-layer-v2-phase-b-orchestrator.md) | 编排器:StreamRunner + RedisStreamBus + CancelRegistry + agent.iter() 映射 | Phase A(protocol 类型) |
| **Phase C** | [`-phase-c-endpoint-frontend.md`](./2026-07-19-ai-application-layer-v2-phase-c-endpoint-frontend.md) | 端点重写 + 前端 protocol codec + useChatStream + 取消 + 重连 | Phase A + B |
| **Phase D** | [`-phase-d-migration-tests.md`](./2026-07-19-ai-application-layer-v2-phase-d-migration-tests.md) | 删除旧代码 + 迁移测试 + e2e 完整覆盖 | Phase A + B + C |

**估时：** 3-4 周(Phase A 3-4 天 / Phase B 5-7 天 / Phase C 5-7 天 / Phase D 3-4 天)

---

## 文件改动总览

### 新建(后端)

| 文件 | 职责 | Phase |
|---|---|---|
| `backend/app/services/ai/protocol/__init__.py` | 协议层包 | A |
| `backend/app/services/ai/protocol/events.py` | ProtocolEvent / ContentBlock / Delta / Usage(Pydantic discriminated union) | A |
| `backend/app/services/ai/protocol/encoder.py` | SSEEncoder:ProtocolEvent → `id: ...\ndata: {json}\n\n` bytes | A |
| `backend/app/services/ai/protocol/errors.py` | ErrorCode enum + ProtocolError | A |
| `backend/app/services/ai/orchestrator/__init__.py` | 编排器包 | B |
| `backend/app/services/ai/orchestrator/runner.py` | StreamRunner:run()(后台) + subscribe() + cancel() | B |
| `backend/app/services/ai/orchestrator/cancel.py` | CancelRegistry 接口 + RedisCancelRegistry + InProcessCancelRegistry | B |
| `backend/app/services/ai/orchestrator/stream_bus.py` | RedisStreamBus:xadd/xread/listen/start/stop | B |
| `backend/app/services/ai/observability/__init__.py` | 可观测性包(P1 留 hook) | B |
| `backend/app/services/ai/observability/logger.py` | 结构化 JSONL logger(P1 最小实现) | B |
| `backend/app/db/redis.py` | Redis 客户端工厂(async,复用 settings.redis_*) | B |

### 新建(前端)

| 文件 | 职责 | Phase |
|---|---|---|
| `frontend/components/chat/protocol/index.ts` | 协议层入口 | C |
| `frontend/components/chat/protocol/events.ts` | TS union types(对应 ProtocolEvent) | C |
| `frontend/components/chat/protocol/codec.ts` | SSE bytes ↔ TypedEvent(含 id 解析) | C |
| `frontend/components/chat/protocol/errors.ts` | ErrorCode TS union + 重试策略 | C |

### 新建(测试)

| 文件 | 职责 | Phase |
|---|---|---|
| `backend/tests/protocol/test_encoder.py` | SSE 编码 round-trip | A |
| `backend/tests/protocol/test_events.py` | discriminated union 校验 | A |
| `backend/tests/orchestrator/conftest.py` | fakeredis fixture | B |
| `backend/tests/orchestrator/test_runner.py` | StreamRunner:happy/cancel/resume/error | B |
| `backend/tests/orchestrator/test_cancel.py` | CancelRegistry:Redis + InProcess | B |
| `backend/tests/orchestrator/test_stream_bus.py` | RedisStreamBus:xadd/xread/expiry | B |
| `backend/tests/orchestrator/test_error_classification.py` | classify_error 异常分类 | B |
| `backend/tests/api/test_ai_chat_stream_v2.py` | 端点 e2e(替代 test_ai_chat_stream_native.py) | D |
| `frontend/lib/api/__tests__/ai-chat-stream.test.ts` | codec 解析单测 | C |

### 修改

| 文件 | 变更 | Phase |
|---|---|---|
| `backend/app/api/v1/endpoints/ai_chat.py` | 重写 stream_message + cancel_stream(调 StreamRunner) | C |
| `backend/app/core/config.py` | 新增 `ai_chat_redis_stream_prefix` / `ai_chat_stream_ttl` 配置 | B |
| `backend/app/services/ai/agent.py` | 无改动(build_chat_agent 沿用) | — |
| `frontend/components/chat/hooks/use-chat-stream.ts` | 重写:protocol codec + /cancel + resume | C |
| `frontend/lib/api/ai-chat-stream.ts` | 重写:protocol codec | C |
| `frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts` | 改 Content-Type + Last-Event-ID 透传 | C |

### 删除(Phase D,确认新代码稳定后)

| 文件 | 说明 |
|---|---|
| `backend/app/services/ai/stream_mapper.py` | 职责并入 orchestrator/runner.py |
| `backend/app/services/ai/cancel.py` | 迁移到 orchestrator/cancel.py |
| `backend/tests/api/test_ai_chat_stream_native.py` | 被 test_ai_chat_stream_v2.py 替代 |

---

## 执行顺序

```
Phase A (协议层)  ────────────┐
                               │
Phase B (编排器)  ─────────────┤
                               │
Phase C (端点+前端)  ──────────┤
                               │
Phase D (迁移+e2e)  ──────────┘
```

Phase A 和 B 是后端内部,不影响线上(新代码不挂路由)。Phase C 挂路由 + 前端切换。Phase D 清理旧代码。

---

## 非 P1 范围(后续 phase)

- **P2 路由清理**:取消 `regenerate + web_search=False → 400` 限制
- **P3 可观测性**:Prometheus metrics + OpenTelemetry
- **P5 e2e**:Playwright 全链路
- **P6 搜索质量**:SearXNG 中文优化
- 流式 tool call(input_json_delta 完整支持)— 当前 tool 参数一次性发出
