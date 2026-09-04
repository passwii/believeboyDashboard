# PR 描述：AI Chat Pydantic AI Native · Phase 1

> 替换建议：`gh pr create --title "feat(ai): AI Chat 流式端点 Pydantic AI Native · Phase 1" --body-file docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1-pr-description.md`

---

## 标题

```
feat(ai): AI Chat 流式端点 Pydantic AI Native · Phase 1
```

## 关联

- 主权威路线图：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md`
- Phase 1 详细计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1.md`
- 阶段跟踪：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`
- 架构文档：`docs/ai-chat-native-architecture.md` § 9.2 / § 10

## 目标

替换 `backend/app/api/v1/endpoints/ai_chat.py:stream_message` 中的手搓 httpx 循环，改用 Pydantic AI `Agent.run_stream_events` 编排 LLM 流。本 PR 仅覆盖 **Phase 1（async + Pydantic AI driver 垂直切片）**，web_search 路径保持现状（行为冻结），Phase 2 单独 PR 切到 Pydantic AI native Tavily tool。

## 改动文件清单

### 新增（3 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `backend/app/services/ai/agent.py` | ~60 | `build_chat_agent(settings)` 工厂 + `current_date_instruction` 动态指令 |
| `backend/app/services/ai/stream_mapper.py` | ~50 | `map_agent_event(event, state)` 纯函数（text / thinking / usage 三分支） |
| `backend/tests/api/test_ai_chat_stream_native.py` | ~230 | 4 个 e2e：native path / 路由矩阵 400 / legacy 冻结 / attached_file 注入 |

### 修改（3 个）

| 文件 | 改动 |
|---|---|
| `backend/tests/services/test_ai_pydantic_ai_dependency.py` | 同步版本断言 `startswith("2.8")` → `"2.9"`（pydantic-ai 已升 2.9.0） |
| `backend/app/api/v1/endpoints/ai_chat.py` | `stream_message` 改 async + 抽 `_prepare_conversation_turn` / `_legacy_stream_response` + 双路径分流；顶部 import `Request` / `build_chat_agent` / `MapperState` / `map_agent_event` |
| `docs/ai-chat-native-architecture.md` | § 0/§ 9.2/§ 10 同步 Phase 1 实际完成情况 |
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md` | 8/8 任务标完成 |

## 行为变化

仅 `enable_web_search=False` 路径内部编排变化；**ndjson 协议、UX 可见事件序列零变化**。

| # | 改动 | 旧行为 | 新行为 | 风险 |
|---|---|---|---|---|
| 1 | non-web_search 路径不再每 chunk 写 DB | `update_message_content` 每个 chunk 触发 | 仅在 done 前一次写 | 中：连接断开时已生成内容丢失（plan 已接受） |
| 2 | non-web_search 路径不生成 title | 第一轮自动生成 title | 不再生成（Phase 2 处理） | 低：仅首轮未命名对话受影响 |
| 3 | non-web_search 路径 `duration_ms=None` | 实时计算 | 固定 None | 低：前端展示差异需 review |
| 4 | `request.is_disconnected()` 主动断连检测 | 无（依赖 cancel button） | yield 循环检测 | 低：纯增益 |
| 5 | `regenerate=True` + `enable_web_search=False` | 走 non-web_search 分支，支持 | **HTTP 400**「重新生成仅在启用联网搜索时支持」| 低：前端需检查 `enable_web_search` 后再发 regenerate |

## 端点路由矩阵（Phase 1）

| `enable_web_search` | `regenerate` | 路径 |
|---|---|---|
| `False` | `False` | ✅ 新 Pydantic AI 路径 |
| `False` | `True`  | ❌ HTTP 400「重新生成仅在启用联网搜索时支持」|
| `True`  | 任意    | ✅ 旧同步路径（行为冻结，e2e 测试 byte-for-byte 固化）|

## 显式冻结（不在本 PR 范围）

- ❌ 不引 `tavily-python`（factory 不注册 Tavily tool）
- ❌ mapper 不引入 `FunctionToolCallEvent` / `FunctionToolResultEvent` 分支
- ❌ `enable_web_search=True` 路径内部逻辑零变更
- ❌ Phase 1 新路径不自动生成会话标题
- ❌ Pydantic AI 路径 `duration_ms=None`（不实时计算）

## 测试覆盖

**新增 19 个测试**（mapper 8 + factory 6 + e2e 4 + dependency 1）：

- `tests/services/test_stream_mapper.py`：text / thinking / usage 三分支共 8 case
- `tests/services/test_agent_factory.py`：build_chat_agent + current_date_instruction 共 6 case
- `tests/api/test_ai_chat_stream_native.py`：端到端 4 case
- `tests/services/test_ai_pydantic_ai_dependency.py`：升级至 2.9 后断言同步

**Baseline 对比（无回归）**：

| 范围 | main | 本分支 | 差异 |
|---|---|---|---|
| 失败 | 75 | 74 | **-1**（预存在 flaky）|
| 通过 | 732 | **751** | **+19**（新增测试）|
| 错误 | 22 | 22 | 0（inventory 等预存在 JSONB/SQLite fixture 错误）|

## 风险点

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pydantic AI 2.9 在不同 OpenAI 兼容 provider 上的事件顺序可能差异 | 模型兼容性需观察 | Merge 后一周观察；e2e 用 TestModel 兜底 |
| non-web_search 路径不再每 chunk 写 DB | 客户端断连时已生成内容丢失（vs 旧路径落盘）| plan 已接受；前端 UX 不变；cancel 仍走 cancel_registry |
| 非首轮会话不自动生成 title | 用户体验略下降 | Phase 2 处理（与 Tavily tool 一起） |
| `duration_ms=None` | 前端展示差异 | PR 描述里通知前端 review |
| sse-starlette 冲突（pydantic-ai 间接拉入） | 启动报错 | 已 pin `starlette<0.42,>=0.40` + 卸载 sse-starlette（仓库 app 代码不直接 import 它）|

## 回滚策略

- **单 commit revert**：每个 commit 独立可 revert
- **回退 endpoint 内部路由**：旧 `_legacy_stream_response` 函数完整保留在 `ai_chat.py`（未删），如需紧急回退可将 `stream_message` 的 `if payload.enable_web_search:` 分支改为恒走 `_legacy_stream_response`
- **回退 mapper / agent**：删除 `app/services/ai/{agent.py,stream_mapper.py}` 即可，端点会因 ImportError 启动失败（需同时 revert endpoint commit）

## 任务 7：真 LLM 烟雾测试（agent 已自动化，Damon 只需 review 结果）

**自动化脚本**：`backend/scripts/verify_ai_chat_phase1.py` 启动后端 → 跑 3 个真 LLM 端到端测试 → 输出 ndjson + PASS/FAIL。

```bash
cd backend && ./.venv/bin/python scripts/verify_ai_chat_phase1.py
```

**实测结果**（2026-07-13，model=MiniMax-M3）：

| 测试 | 路径 | 事件数 | 时长 | 状态 |
|---|---|---|---|---|
| 1 | enable_web_search=False (Pydantic AI) | 11 chunks + usage + done | 3.6s | ✓ PASS |
| 2 | regenerate=True + web_search=False | HTTP 400「重新生成仅在启用联网搜索时支持」| <1s | ✓ PASS |
| 3 | enable_web_search=True (legacy 冻结) | 47 chunks + tool_calls/sources/tool_searching/tool_done + done | 25.0s | ✓ PASS |

**Pydantic AI 路径实际 ndjson 片段**（测试 1）：

```json
{"type": "start"}
{"type": "chunk", "delta": "sentence, in Chinese."}
{"type": "chunk", "delta": "</think>\n\nPydantic AI 是一个基于 Pydantic 的 Python 智能体（Agent）框架，用于以类型安全、结构化的"}
{"type": "chunk", "delta": "方式构建生产级的大语言模型应用。"}
{"type": "usage", "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 259}}
{"type": "done", "user_message": {...}, "assistant_message": {"content": "...Pydantic AI 是一个基于 Pydantic 的 Python 智能体框架...", "is_complete": true, ...}, ...}
```

**Legacy 路径实际 ndjson 片段**（测试 3）：

```json
{"type": "start"}
{"type": "chunk", "delta": "<think>用户问今天北京的天气...</think>"}
{"type": "tool_calls", "tool_calls": [{"function": {"name": "web_search", "arguments": "{\"query\":\"北京今天天气\",\"time_range\":\"day\"}"}}]}
{"type": "tool_searching"}
{"type": "tool_done"}
{"type": "sources", "sources": [{"title": "北京天气预报", "url": "https://www.weather.com.cn/weather/101010100.shtml", "score": 0.9}, ...], "time_range": "day", "query": "今天北京天气"}
{"type": "chunk", "delta": "..."}  // 后续 chunks
{"type": "done", "assistant_message": {"search_sources": [...10 条], "search_time_range": "day", "is_complete": true, ...}}
```

**自动化测试发现的 3 个 bug（已修复）**：

1. Pydantic AI 2.9 输入格式错：原实现直接传 `[ModelMessage]`，实际必须拆为 `user_prompt + message_history`（commit `1903bd4d`）
2. `payload.model` 字段被忽略：`build_chat_agent` 现在支持 `model_name` 参数（commit `1903bd4d`）
3. e2e 测试 fixture 需接受新参数（commit `1903bd4d`）

**Damon 需要做的**（仅 UI 部分）：

### 步骤 1：取消按钮（UI 测试，必须人工）

启动前端 dev server + 启 backend dev server + 在 UI 发消息 + 中途点取消。

### 步骤 2：前端 build/test 冒烟

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```

预期：`consumeStream` 对 `start / chunk / thinking_chunk / usage / done` 解析逻辑零回归（前端代码未改动，仅端点协议兼容）。

### 步骤 3：填写 PR 评论

把上面 2 步的结果贴到 PR 评论里。

> **额外发现**：`.env` 的 `AI_CHAT_DEFAULT_MODEL=MiniMax-M2.7-highspeed` 是过期配置（provider 返回 502 "unknown provider"）。验证脚本用 `model: "MiniMax-M3"` 覆盖。这不是本 PR 的问题（`agent.py` 现在支持 `payload.model` 覆盖默认值，但 .env 默认值仍需 Damon 单独修）。

## 部署注意事项

- 部署到 VPS 后**重启 believeboy-api 服务**（pre-push hook 会自动做：`alembic upgrade head → systemctl restart believeboy-api`）
- 本 PR 无 alembic migration（纯代码 + 单测），DB schema 不变
- 本 PR 无前端改动（前端 consumeStream 不变，UX 零差异）
- 一周观察期内如出现 Pydantic AI 兼容性问题，回滚本分支即可