# AI Chat 原生方案架构（Native Architecture）

> **状态**：方向已锁。**Phase 1（async + Pydantic AI driver）已落地**（2026-07-13）；SearXNG 中文搜索优化仍挂起。
> **范围**：本文件只描述**最终方案**与**决策依据**。每条决策背后都有 spike 验证或真实端点测试，不再赘述。
> **Phase 2**：web_search 切到 Pydantic AI native Tavily tool（独立 PR，详见 § 9.3）。

---

## 0. 一句话方向

后端 `event_stream` 的手搓循环（含 `_stream_with_retries` / `stream_with_tool_calling` / 日期 patch）整段退役。换成 **Pydantic AI 编排 + 原生 `tavily_search_tool`（指向你自己的 SearXNG adapter，env 变量） + 日期抬到指令层**；`stream_utils` 编码器、`build_search_source_cards`、前端 `consumeStream` **全部原样保留**。

---

## 1. 七层架构图

```
┌──────────────────────────────────────────────────────────────┐
│ ① 前端 / NDJSON 消费层                                          │
│   consumeStream · 渲染 chunk / thinking_chunk / sources / done  │
│   ➤ 不变                                                     │
├──────────────────────────────────────────────────────────────┤
│ ② 传输协议层（契约）— 你现有 ndjson                             │
│   stream_utils.build_stream_* · application/x-ndjson           │
│   ➤ 不动                                                     │
├──────────────────────────────────────────────────────────────┤
│ ③ Agent 编排层 — Pydantic AI（替代手搓循环）              │
│   Agent(model, instructions, tools, capabilities)             │
│   run_stream_events() · 流式 / 工具 / thinking / 取消 全由框架  │
│   ➤ 替代 event_stream + stream_with_tool_calling             │
├──────────────────────────────────────────────────────────────┤
│ ④ 指令 / 上下文层（Grounding）                                 │
│   系统提示词（scenario 体系 / 语气）· current_date 动态注入      │
│   ➤ 日期从「search query patch」抬到这一层                │
├──────────────────────────────────────────────────────────────┤
│ ⑤ 能力层（Capabilities）                                       │
│   Thinking() · tavily_search_tool(client=                      │
│     AsyncTavilyClient(api_key="dummy",                         │
│       base_url=settings.ai_chat_web_search_base_url)) · 未来  │
│   scenario 工具                                                │
├──────────────────────────────────────────────────────────────┤
│ ⑥ 工具执行 / 数据层                                            │
│   SearXNG adapter（env 域名）· build_search_source_cards       │
│   （卡片造型保留）· conversation 表读写                        │
├──────────────────────────────────────────────────────────────┤
│ ⑦ 模型传输层（可选）                                           │
│   provider 直连（本方案不引 litellm）                          │
└──────────────────────────────────────────────────────────────┘
```

**关键原则**：以后任何新 feature 先问自己「归到哪一层」，不要散进 `event_stream` 里写 ad-hoc。

---

## 2. 关注点归位

| 关注点 | 归位 | 退掉 | 备注 |
|---|---|---|---|
| 日期 | ④ 动态指令 + ⑤ 模型填 `time_range` | search query 拼日期 patch | `time_range` 是否被 adapter 吃见 §6 |
| 搜索 | ⑤ `tavily_search_tool` → ⑥ adapter | `execute_web_search` 手写 HTTP | base_url 走 env 变量，绝不写死 |
| thinking | ⑤ `Thinking()` capability | 手搓 delta 聚合 | 跨厂商统一 |
| conversation | ⑥ 你的 `AIMessage`/`AIConversation` 表 | 无 | 全程不变 |
| 卡片 | ⑥ `build_search_source_cards` | 无 | 后续可重设计 |
| 流式/取消 | ③ `run_stream_events` + context manager 退出即关连接 | 手搓 generator + `threading.Event` | 进程内取消，未来 Redis 化另说 |

---

## 3. 为什么是「原生」而不是「包自己的搜索」

「原生」在 Pydantic AI 里有两个意思，必须分清：

- **`WebSearch(native=...)` 的 native 模式** → 用模型厂商自带搜索（OpenAI / Anthropic 原生 web search）。**会绕开你的 SearXNG adapter**。
- **`tavily_search_tool(client=AsyncTavilyClient(base_url=settings.ai_chat_web_search_base_url))`** → **用框架的 Tavily 工具，但 client 指向你的 adapter 域名**。

本方案选**后者**：它属于「原生工具族」（框架管 HTTP、解析、tool schema），同时尊重了你搭的 SearXNG adapter 投资。

---

## 4. 事件映射表（Pydantic AI → ndjson）

下表是经过 spike 验证的对应关系。所有右列都是你现有的 `stream_utils.build_stream_*`，**前端 `consumeStream` 一字不改**。

| Pydantic AI 事件 | → ndjson builder | 前端 `type` |
|---|---|---|
| `PartDeltaEvent(delta=TextPartDelta(content_delta=d))` | `build_stream_chunk(d)` | `chunk` |
| `PartDeltaEvent(delta=ThinkingPartDelta(content_delta=d))` | `build_stream_thinking_chunk(d)` | `thinking_chunk` |
| `FunctionToolCallEvent(part)` `part.tool_name == "web_search"`/`"tavily_search"` | `build_stream_tool_calls([part])` + `build_stream_tool_searching()` | `tool_calls` + `tool_searching` |
| `FunctionToolResultEvent(part)` `part.content` | `build_search_source_cards(ret)` → `build_stream_sources(cards, time_range, query)` + `build_stream_tool_done()` | `sources` + `tool_done` |
| `AgentRunResultEvent(result)` → `result.usage`（**属性，不是方法**） | `build_stream_usage(...)` | `usage` |
| 循环结束后 / `AgentRunResultEvent` | `build_stream_done(...)`（含 token_usage） | `done` |
| `except Exception` | `build_stream_error(str(exc))` | `error` |

**版本陷阱（已踩）**：`ev.result.usage()` 是**错误**写法（`'RunUsage' object is not callable`）。正确：`ev.result.usage`（属性）。

---

## 5. 测试证据

### 5.1 spike v1 — 事件映射
**环境**：Python 3.14.5 / pydantic-ai 2.8.0（独立 venv，见 `/tmp/spike_venv`）。
**模型**：`TestModel(call_tools=['web_search'])` 强制工具调用。
**真实事件序列**（库实际吐出的）：
```
PartStartEvent → PartEndEvent → FunctionToolCallEvent
→ FunctionToolResultEvent → PartStartEvent → FinalResultEvent
→ PartDeltaEvent ×2 → PartEndEvent → AgentRunResultEvent
```
**映射后 ndjson（10 个事件）**：start → tool_calls → tool_searching → sources(时间窗+query) → tool_done → chunk ×3 → usage → done。

### 5.2 spike v2 — 原生 tavily 工具 → 卡片
**核心证明**：原生 `tavily_search_tool(client=FakeAdapterClient())` 返回 `list[{title, url, content, score}]`，直接喂给 `build_search_source_cards` → 产出 `{title, url, snippet, domain, score}` 卡片。

**重要副发现**：原生工具只保留 `title/url/content/score`，**丢弃 `raw_content`**。所以卡片 `snippet` 退化为 `content`（无害）。adapter 吐的 `raw_content` 是字面字符串 `"None"`（怪癖，cards 不受影响，因为优先取 `content`）。

Spike 脚本：`/tmp/spike/spike.py`、`/tmp/spike/spike_v2.py`。

---

## 6. 真实端点测试（`https://search.believeboy.com/search`）

| Query | 类型 | Results | 备注 |
|---|---|---|---|
| `latest AI news`（英） | general/news | 3 ✅ | 通用引擎正常 |
| `Python 编程教程`（中）| tech | **3 ✅** | 中文可走 tech 引擎 |
| `今天天气`（中）| time-ephemeral | 0 ❌ | 时间敏感 query |
| `北京天气`（中）| time-ephemeral | 0 ❌ | 同上 |
| `人工智能 最新进展`（中）| general/news | 0 ❌ | 通用引擎中文返回失败 |
| `亚马逊跨境电商运营`（中）| general/business | 0 ❌ | 同上 |

**字段形状确认**：response 顶层含 `query/follow_up_questions/answer/images/results/response_time/request_id`（标准 Tavily）；每条 result 含 `url/title/content/score/raw_content`（与 `build_search_source_cards` 的读字段**完全对得上**）。

**base_url 配置路径**：
- env：`AI_CHAT_WEB_SEARCH_BASE_URL=https://search.believeboy.com`（`.env:113` / `.env.example`）
- pydantic-settings：`ai_chat_web_search_base_url`（`core/config.py:43`）
- 运行时：`settings.ai_chat_web_search_base_url.strip().rstrip("/")`

C1 wiring 一律用这个**变量**，不写死 localhost:8000。

---

## 7. 已修复的 Bug

### 7.1 `score` 字符串化导致卡片 score 永远为 None
- **现象**：live 端点返回 `"score": "0.9"`（字符串），`build_search_source_cards` 老代码 `isinstance(int, float)` 拒绝，卡片 `score` 字段永远 None。
- **patch**：`backend/app/services/ai/search.py:238` 改 try/except float，接受 int/float/str。
- **测试**：`backend/tests/services/test_ai_chat_search_source_cards.py`（13 个 case，全过）。
- **落地**：与本方案正交，**无论上不上原生都该修**，本轮顺手收掉。

---

## 8. 挂起项（独立 ticket，不阻塞本方案）

### 8.1 SearXNG 中文搜索质量
- **现状**：`config.example.yaml` 默认引擎只有 google/duckduckgo/brave + tech 引擎，**没有中文/中国区引擎**（Baidu/Bing CN/Yandex 都没有）。英文通用 + 中文 tech 类（`Python 编程教程`）通；中文 general/news/business 类卡 0。
- **不强行诊断的原因**：完整修需要进部署机看 `docker logs searxng`、可能开 bing/加 Baidu 引擎、重新 build+deploy，并实测。这一轮会发散到「大量重新实践」。
- **建议动作**：建独立 ticket `BEL-XXX SearXNG 中文搜索优化`，等部署窗口处理。
- **本方案对其不依赖**：原生 `tavily_search_tool` 集成 shape 与 search 返回 0 条还是 3 条**完全独立**。

---

## 9. 落地路径

### 9.1 已完成
- [x] 方向锁定（架构图、关注点归位、native 选型）；
- [x] 双段 spike 验证（事件映射 / 原生工具 → 卡片）；
- [x] 真实端点测试（含「中文 ≠ 全坏」的精确诊断）；
- [x] `score` 字符串 bug 修复 + 13 个测试。

### 9.2 已落地（Phase 1，2026-07-13）

[Phase 1] async + Pydantic AI driver 垂直切片落地。`enable_web_search=False` 用户路径切到 Pydantic AI；`enable_web_search=True` 路径行为冻结（legacy `_legacy_stream_response` byte-for-byte 保留）。

**新增模块**：
- `backend/app/services/ai/agent.py` — `build_chat_agent(settings)` 工厂 + `current_date_instruction` 动态指令
- `backend/app/services/ai/stream_mapper.py` — `map_agent_event(event, state)` 纯函数（text / thinking / usage 三分支）
- `backend/tests/api/test_ai_chat_stream_native.py` — 4 个 e2e（4/4 PASS）

**改动模块**：
- `backend/app/api/v1/endpoints/ai_chat.py` — `stream_message` 改 async + 双路径分流；`_prepare_conversation_turn` / `_legacy_stream_response` 辅助函数抽出

**Phase 1 显式冻结（不在本 PR 范围）**：
- ❌ 不引 `tavily-python`（factory 不注册 tools）
- ❌ mapper 不引入 `FunctionToolCallEvent` / `FunctionToolResultEvent` 分支
- ❌ `enable_web_search=True` 路径内部逻辑零变更（e2e 测试 byte-for-byte 固化）
- ❌ Phase 1 新路径不自动生成会话标题
- ❌ Pydantic AI 路径 `duration_ms=None`（不实时计算）

**端点路由矩阵（Phase 1）**：

| `enable_web_search` | `regenerate` | 路径 |
|---|---|---|
| `False` | `False` | ✅ 新 Pydantic AI 路径 |
| `False` | `True`  | ❌ HTTP 400「重新生成仅在启用联网搜索时支持」|
| `True`  | 任意    | ✅ 旧同步路径（行为冻结）|

**Phase 1 收益**：
- 解 P0-1（客户端断连）：async 路径 `await request.is_disconnected()`
- 解 P0-2（DB session 持有期）：Pydantic AI 路径仅在 yield 间隙持有 DB，不再每 chunk 写 DB
- 引入 Pydantic AI 2.9 编排 LLM 流，替代手搓 httpx 循环
- 前端 `consumeStream` 与 ndjson 协议零改动

### 9.3 已落地（Phase 2，2026-07-14）

- **新增模块**：
  - `backend/scripts/spike_searxng_tavily_adapter.py` — spike 脚本（task 1）
  - `backend/tests/services/test_searxng_adapter_spike.py` — spike 断言固化
  - `backend/scripts/verify_ai_chat_phase2.py` — 烟雾脚本（web_search 路径 + sources 持久化）
- **新增 mapper 能力**：
  - `FunctionToolCallEvent` + tavily_search/web_search → `tool_calls`（一次只产一条 ndjson；`tool_searching` 由端点层紧接 yield）
  - `FunctionToolResultEvent` → `sources` + `tool_done`（一次性 yield 两行 ndjson；`_normalize_tool_content` 兼容 list[dict] / dict 含 'results' 键）
- **Agent Factory 增量**：
  - `build_chat_agent(..., web_search=False)`：True 时注册 `tavily_search_tool(client=AsyncTavilyClient(api_key=, api_base_url=settings.ai_chat_web_search_base_url))`（**注意 tavily-python 0.7.x 参数名是 `api_base_url`，与 Pydantic AI 文档示例的 `base_url` 不一致**）
  - 同步追加 web_search 行为指令（提示模型何时调用工具）
- **端点收口**：
  - `stream_message` 路由矩阵简化：`enable_web_search=False / True` 均走 Pydantic AI
  - 删除 `_legacy_stream_response`（约 240 行旧 httpx 同步流）
  - 端点层在 `FunctionToolCallEvent` 后立即 yield `tool_searching`（与既有 ndjson 协议兼容）
  - 保留 `regenerate + web_search=False → 400` 行为（保守防 Tavily tool 对 regenerate 未验证）
- **决策记录**：
  - SearXNG adapter 完全兼容 Tavily API（spike 实测 POST /search 返回标准 Tavily dict），决策走 Pydantic AI 自带 `tavily_search_tool`，不走自定义 tool 备选路径
  - `tavily-python` 0.7.x 参数名是 `api_base_url`（不是 `base_url`）—— 与 Pydantic AI `tavily_search_tool` 文档示例不一致
  - mapper `_handle_tool_result` content 解析路径：`list[dict]`（Pydantic AI Tavily tool 标准返回）+ 兼容 `dict` 含 'results' 键

### 9.3 落地约束
- **替换路径**：建议独立分支 / PR，避免一次性 big-bang；
- **`base_url` 零写死**：任何新增代码引用搜索地址都走 `settings.ai_chat_web_search_base_url`；
- **前端零改动**：ndjson 协议保持兼容现有 `consumeStream`。

---

## 10. 版本与依赖

- Python 3.14.5（仓库当前）
- **pydantic-ai==2.9.0**（Phase 1 落地；spike 验证时为 2.8.0，PR 阶段仓库已升 2.9.0）
- pydantic-ai-slim[tavily]（原生 Tavily 工具可选依赖，**生产装 `pydantic-ai` 主包即可**）
- **tavily-python 0.7.26**（Phase 2 落地：Pydantic AI Tavily tool 运行时依赖；参数名 `api_base_url=`，详见 § 9.3 决策）
- **不引入** litellm（挂起项中明确）

> **间接依赖冲突（已踩）**：pydantic-ai 拉入 `sse-starlette>=3` 要求 `starlette>=1.0`，与 fastapi 0.115.5 要求的 `starlette<0.42` 冲突。
> 仓库 app 代码不直接使用 sse-starlette，venv 中**卸载 `sse-starlette`** 即可。mcp 包间接需要 sse-starlette，但本仓库不依赖 mcp。
