# AI Chat V2 · 前后端接入 + 临时 hack 清理（业务优先集成计划）

- 关联：V2 设计 [`../specs/2026-07-19-ai-application-layer-redesign-v2-design.md`](../specs/2026-07-19-ai-application-layer-redesign-v2-design.md)
- 承接：V2 Phase A（protocol）/ Phase B（orchestrator）已在分支 `feat/ai-app-layer-v2-p1` 完成（未合并）
- 本计划 = V2 **Phase C（端点 + 前端）+ Phase D（迁移 + 测试）** 的落地执行，叠加「业务优先 / 全程可回滚 / 临时 hack 清理」
- 日期：2026-07-21
- 状态：待用户确认决策点 D1–D4 后开工

---

## 0. 现状盘点（2026-07-21 实测）

### 0.1 已在 main（生产可用）

| 模块 | 状态 |
|---|---|
| Pydantic AI driver（Phase 1-3，PR #133/#134/#135 已合）| ✅ `agent.run_stream_events()` + Tavily tool + 自动标题 |
| 后端 REST：会话 CRUD / 消息历史 / 单条消息 DELETE+PATCH / config | ✅ `api/v1/endpoints/ai_chat.py` |
| 后端流式：`POST .../messages/stream`（**ndjson**）+ `POST .../stream/cancel`（**进程内 Event**）| ✅ 可用但「临时」 |
| 前端 `dashboard/ai/chat`：`AIChatWindow` 自管全部 backend 调用（load/send/regen/rename/delete）| ✅ UI 完整且已接线 |
| 前端 API 层：`lib/api/ai-chat.ts`（CRUD）+ `ai-chat-stream.ts`（ndjson consumer）+ `use-chat-stream.ts` | ✅ |

> 结论：**基础 chat / 对话 / 历史今天就能跑**（走 ndjson）。「没接入」指的是 **V2 新架构（protocol + orchestrator + Redis Stream）没接到前端**，且前端残留若干临时 hack。

### 0.2 已在分支 `feat/ai-app-layer-v2-p1`（完成但未合并，落后 main 4 commits）

| 模块 | 文件 | 行数 | 测试 |
|---|---|---|---|
| 协议层 | `protocol/events.py` `encoder.py` `errors.py` | 144 / 31 / 32 | `tests/protocol/` ✅ |
| 编排器 | `orchestrator/runner.py`（agent.iter 映射）`stream_bus.py`（Redis Stream）`cancel.py`（Redis+InProcess）| 211 / 113 / 88 | `tests/orchestrator/` ✅ |
| 可观测 | `observability/logger.py` | 16 | — |
| 前置 | `app/db/redis.py`（create_redis_client）+ config（`redis_db` / `ai_chat_redis_db=3` / `ai_chat_stream_prefix`）| +27 | — |
| ErrorCode enum（A1）| `protocol/errors.py` | — | 已单独合入 main（`3df9b934`）|

### 0.3 未做（= 本计划范围）

- V2 Phase C：后端 stream 端点改调 StreamRunner（SSE）+ cancel 改调 runner.cancel + 前端 protocol 层 + useChatStream/consumeStream 重写 + Next.js route handler
- V2 Phase D：删 `stream_mapper.py` / 旧 `cancel.py` / legacy ndjson + Playwright e2e
- 临时 hack 清理（见 §0.4）

### 0.4 已识别的「临时 hack」（用户明示「很多功能是临时做的」）

| # | 位置 | 现状 | 应有 |
|---|---|---|---|
| H1 | `ai-chat-window.tsx:100-107` `locallyDeletedIds` | 前端本地记「已删消息」，注释称「后端无消息级 DELETE」| 后端 **已有** `DELETE .../messages/{id}` + route handler `[messageId]/route.ts` → 直接接真端点 |
| H2 | `use-chat-stream.ts:92-96` `stop()` | 只 `abort()` 本地，**不通知后端**（V2 spec §1.2）| stop() 调 `POST .../stream/cancel`（乐观取消）|
| H3 | 错误传递 | 退化为字符串，前端字符串匹配 | typed `ErrorCode` 贯穿三端 + 重试策略矩阵 |
| H4 | 取消作用域 | 进程内 `threading.Event`，多 worker 失效 | Redis `GETDEL live_key`，跨 worker |
| H5 | 流协议 | 自定义 ndjson（`start/chunk/done`）| Anthropic Messages SSE（`message_start/content_block_*/message_stop`）|

---

## 1. 目标与非目标

**目标（业务优先）：**
1. V2 后端（protocol + orchestrator + Redis Stream）端到端接入前端
2. chat / 对话 / 历史 / 取消 / 联网搜索 / 自动标题 **全部通过新架构跑通并手测验证**
3. 清理 §0.4 临时 hack（H1–H5）
4. **全程不破坏现有可用系统**（feature flag 保护，旧路径保留到 Phase 5 才删 → 可瞬间回滚）

**非目标：**
- 不改 UI 视觉（`AIChatWindow` 动画/布局不动）
- 不重写会话/消息 REST CRUD（已可用，仅验证）
- 可观测性 metrics（V2 Phase P3，另立项）

---

## 2. 关键设计决策（待用户确认）

| # | 决策点 | 推荐 | 备选 |
|---|---|---|---|
| **D1** | 传输格式切换机制 | **后端 feature flag `ai_chat_use_v2_stream`（默认 False）+ 前端按 `Content-Type` 自适应**（`text/event-stream`→SSE codec，`application/x-ndjson`→旧 consumer）。前端零手动 flag，后端 flag 控制灰度，旧路径保留可回滚 | 前端手动 env flag（更脆，双端要同步翻）|
| **D2** | resume/断连重连是否本期做 | **本期做基础版**（前端存 `last-event-id`，重连带 `Last-Event-ID`，后端 subscribe 续传）—— V2 架构已免费支持，前端 wiring 增量小 | 推迟（仅存 id 不实现重连 UI）|
| **D3** | 在哪开发 Phase C | **在 `feat/ai-app-layer-v2-p1` 分支继续**（先 rebase 到 main），Phase 4 验证通过后整体合并 | 先合 V2 到 main 再开 Phase C 分支（栈断裂）|
| **D4** | 单条消息删除语义 | 复用后端已有 `DELETE .../messages/{id}`，确认其硬删/软删行为后前端直接接 | 新增软删字段 |

---

## 3. 阶段计划

### Phase 0 — 地基验证与合并（0.5–1 天）· 去风险

- [ ] 0.1 `git rebase main` 把 `feat/ai-app-layer-v2-p1` 拉到最新（落后 4 commits：supply-chain Redis 缓存等）
- [ ] 0.2 `cd backend && pytest tests/orchestrator tests/protocol -v` → 确认 Phase A/B 真 PASS（fakeredis）
- [ ] 0.3 `pytest tests/api/test_ai_chat* -v` → 确认现有 ai_chat 测试无回归
- [ ] 0.4 本地起 redis + 后端，`scripts/` 烟雾脚本或 curl 验证 `StreamRunner` happy path（message_start → content_block_delta → message_stop）
- **产出**：地基可信。若 0.2 失败 → 先修 Phase A/B，不进 Phase 1。

### Phase 1 — 后端端点接入 V2（feature flag 保护）（3–4 天）· V2 Phase C1

> ⚠️ **2026-07-21 修订（实测发现）**：现行 `stream_message` 含大量 V2 runner 未覆盖的业务逻辑——
> `_prepare_conversation_turn`（建 user_row + 空 assistant_row、**regenerate** 删旧行）、流后持久化
> （final_content / search_source_cards / search_time_range / usage / token 统计）、**Phase 3 自动标题**、
> 以及前端依赖的 `done` 事件载荷（序列化 message 行 + title + usage + title_regenerated）。
> V2 runner 是纯传输层（且 tool_result 截断 500 字、丢失 source 结构化数据）。**直接换传输会回归这些功能。**

**修订后设计（Option B：runner=agent 执行器，endpoint=业务逻辑 owner，全程保留功能）：**

- **runner 增强**：agent 跑完后从 `agent_run.result.all_messages()` 抽取业务载荷，发一个**内部事件 `stream_result`**
  （`full_text` + `search_source_cards` + `search_time_range` + `usage`），紧接 `message_stop` 之前。
  `_extract_search_meta` 逻辑下沉到 `search.py` 共享（runner / 旧端点复用）。`stream_result` 仅供 endpoint 消费，不转发客户端。
- **endpoint 重写（V2 路径）**：`_prepare_conversation_turn`（建行，含 regenerate）→ 首请求 `asyncio.create_task(runner.run(...))`，
  resume 请求（带 `Last-Event-ID`）只订阅 → `subscribe()` 逐事件：遇 `stream_result` 则持久化（update content/sources/usage + recalc + autotitle，**仅原始请求**），
  其余标准事件 `encode_sse` 转发客户端 → `message_stop` 后合成客户端 `done` 事件（序列化 user/assistant 行 + title + usage + title_regenerated）。
- **cancel**：`runner.cancel()`（Redis GETDEL，跨 worker）。**resume**：`Last-Event-ID` → `subscribe(from_id)`。
- **feature flag** `settings.ai_chat_use_v2_stream: bool = False`：False 走旧 ndjson（保留不删），True 走 V2 SSE。

**任务：**
- [ ] 1.1 TDD：`stream_result` 事件入 `protocol/events.py` + `tests/protocol/test_events.py` → 先 FAIL → PASS
- [ ] 1.2 `_extract_search_meta` 下沉 `search.py`；runner 跑完发 `stream_result`（含 source_cards/time_range/usage/full_text）+ `tests/orchestrator/test_runner.py` 扩展 → PASS
- [ ] 1.3 TDD：`tests/api/test_ai_chat_stream_v2.py`（happy / regenerate / cancel / resume / error 分类 / source 持久化 / autotitle / done 载荷）→ 先 FAIL
- [ ] 1.4 `stream_message` V2 路径重写（_get_stream_runner 模块级 + 业务逻辑保留 + done 合成）；`cancel_stream` 改 `runner.cancel()`
- [ ] 1.5 feature flag `ai_chat_use_v2_stream`（默认 False，旧 ndjson 路径保留）
- [ ] 1.6 `pytest tests/api/test_ai_chat_stream_v2.py tests/orchestrator tests/protocol -v` → 全 PASS
- [ ] 1.7 Commit：`feat(ai-chat): V2 stream 端点 — StreamRunner + stream_result + SSE + resume + feature flag(V2 Phase C1)`
- **产出**：后端 V2 端点可用，业务功能（regenerate/autotitle/sources/usage/done）零回归，flag 控制可瞬间回滚。

### Phase 2 — 前端协议层（纯新增，零风险）（1 天）· V2 Phase C2

- [ ] 2.1 TDD：`lib/api/__tests__/ai-chat-stream.test.ts`（parseSSEChunk：单事件 / 带 id / 多事件 / 半行缓冲 / error）→ 先 FAIL
- [ ] 2.2 `components/chat/protocol/events.ts`（TS union 对应后端 ProtocolEvent / ContentBlock / Delta / Usage）
- [ ] 2.3 `components/chat/protocol/codec.ts`（`parseSSEChunk`，解析 `id:` 供 resume）
- [ ] 2.4 `components/chat/protocol/errors.ts`（`ErrorCode` + `getRetryStrategy` 矩阵）+ `index.ts`
- [ ] 2.5 `npx vitest run lib/api/__tests__/ai-chat-stream.test.ts` → PASS
- [ ] 2.6 Commit：`feat(chat): 前端协议层 — TS types + codec + errors(V2 Phase C2)`
- **产出**：前端能解析 V2 SSE。

### Phase 3 — 前端接入 + 临时 hack 清理（核心业务）（2–3 天）· V2 Phase C3 + §0.4

- [ ] 3.1 重写 `lib/api/ai-chat-stream.ts` `consumeStream`：**按 `Content-Type` 自适应**（D1）—— `text/event-stream`→新 codec 路径（存 last-event-id），`application/x-ndjson`→保留旧 line-split 路径
- [ ] 3.2 重写 `use-chat-stream.ts`：`stop()` 调 `POST .../stream/cancel`（乐观，H2）；`lastEventIdRef` 存 id；send 带 `Last-Event-ID`（D2）
- [ ] 3.3 `app/api/.../messages/stream/route.ts`：透传 `Last-Event-ID`；`Content-Type` 随后端（不再写死 ndjson）
- [ ] 3.4 `ai-chat-window.tsx` 回调映射（新协议事件 → 现有 UI 回调，**不改 UI**）：
  - `content_block_delta.text_delta` → `onChunk`
  - `content_block_delta.thinking_delta` → `onThinking`
  - `content_block_start/stop.tool_result` → `onSources`（含 time_range/query meta）
  - `message_delta.usage` → `onUsage`
  - `message_stop` → `onDone`（user/assistant message 仍从 REST 或 done 等价事件取）
  - `error` → 按 `ErrorCode` 分流（H3：`cancelled` 静默，`rate_limit` 显示重试按钮）
- [ ] 3.5 **清理 H1**：删 `locallyDeletedIds`，接真 `DELETE /api/ai-chat/conversations/{id}/messages/{mid}`（确认 D4 后端行为）
- [ ] 3.6 `npx tsc --noEmit` + `pnpm lint` + `npx vitest run` → 全过
- [ ] 3.7 Commit：`feat(chat): 前端接入 V2 协议 + 清理消息删除/取消临时 hack(V2 Phase C3)`
- **产出**：前端完整接入 V2，H1–H3 清除。

### Phase 4 — 端到端验证 + 灰度切换（1–2 天）

- [ ] 4.1 **业务测试清单（手测，dev 环境 flag=True）**：
  - 对话：新建 / 切换 / 重命名 / 删除 / 自动标题（首轮）/ 手动重生成标题
  - 历史：切换会话回放 / 单条消息删除（H1 验证）/ 刷新不复活
  - 聊天：流式文本 / 思考链折叠 / token usage 显示
  - 联网搜索：sources 卡片 + time_range chip + 搜索词
  - 取消：生成中点停止 → 后端真停（H2/H4 验证，多 worker 可选）
  - 错误：rate_limit / 5xx → typed 提示 + 重试按钮（H3 验证）
  - resume（D2）：生成中断网重连 → 续传
- [ ] 4.2 部署：后端 `python productEnvAgent/deploy_vps.py --auto`（或 pre-push hook 自动）；前端 Vercel 自动
- [ ] 4.3 生产灰度：`ai_chat_use_v2_stream=False` 先观察 → 确认无问题翻 `True`
- [ ] 4.4 观察 1–2 天（错误率 / 取消成功率 / Redis Stream 内存）
- **产出**：V2 生产跑通，业务功能全部手测过。

### Phase 5 — 迁移清理（V2 Phase D）（1 天）

- [ ] 5.1 删 `services/ai/stream_mapper.py`、旧 `services/ai/cancel.py`、`stream_message` 内 legacy ndjson 分支
- [ ] 5.2 移除 feature flag（V2 成唯一路径）
- [ ] 5.3 Playwright e2e 固化（`frontend/tests/dashboard/ai-chat-*.spec.ts` 扩到全链路）
- [ ] 5.4 `pnpm lint && pnpm build && pnpm test` + `cd backend && pytest` 全过；文档同步（架构 §9.3/§10 + tracker）
- [ ] 5.5 Commit：`refactor(ai-chat): 移除 legacy ndjson 路径 + feature flag(V2 Phase D)`
- **产出**：代码库只剩 V2 一条路径。

---

## 4. 估时与风险

**总估时：8–11 工作日（2–2.5 周）**，与 V2 spec Phase C+D 一致。Phase 1–3 结束即有「V2 可用的 chat」（业务价值早点），Phase 4–5 是灰度 + 清理。

| 风险 | 缓解 |
|---|---|
| V2 Phase A/B 分支代码实际跑不过（未验证）| Phase 0 先跑测试，失败先修地基 |
| `agent.iter()` node 事件序列与映射表偏差 | Phase 0.4 烟雾脚本 + Phase 1 e2e 兜底 |
| 双格式前端（D1）复杂度 | Content-Type 自适应集中在 `consumeStream` 一处，旧路径 Phase 5 删 |
| Redis Stream 内存增长 | Stream TTL 24h + MAXLEN（V2 spec §15）|
| 生产切换风险 | feature flag 灰度 + 旧路径保留到 Phase 5 → 翻回 False 即回滚 |

---

## 5. 开工前需用户拍板

1. **D1**：传输切换 = 后端 flag + 前端 Content-Type 自适应？（推荐 ✅）
2. **D2**：resume 本期做基础版？（推荐 ✅）
3. **D3**：在 `feat/ai-app-layer-v2-p1` 分支继续开发 Phase C？（推荐 ✅）
4. **D4**：单条消息删除复用现有后端 DELETE 端点？（推荐 ✅，需确认硬删/软删）
5. 是否认可「Phase 1–3 先交付可用 V2 chat，Phase 4–5 灰度+清理」的节奏？
