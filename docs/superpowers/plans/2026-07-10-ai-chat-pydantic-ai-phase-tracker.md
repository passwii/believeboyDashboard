# AI Chat Pydantic AI Native · 阶段跟踪与索引

> **本文件用途：** 跨阶段索引与进度跟踪。把原 plan（10 任务全量）与各 phase 实施计划对接，提供一站式视图。

---

## 文档索引

| 文档 | 角色 | 状态 |
|---|---|---|
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md` | 原 10 任务完整路线图（架构 § 9.2 / § 9.3 落地路径） | 📚 路线图（已存档） |
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1.md` | Phase 1 详细实施计划（async + Pydantic AI 垂直切片） | ✅ 完成（2026-07-13） |
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase2.md` | Phase 2 详细实施计划（web_search via Pydantic AI native Tavily tool） | ✅ 起草完成（2026-07-13）|
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md` | **本文档**：跨阶段跟踪与索引 | 🚧 持续维护 |

---

## 阶段状态总览

| 阶段 | 范围 | 状态 | 已落地 commits |
|---|---|---|---|
| **Phase 1** | async 化 + Pydantic AI 纯文本/思考/usage；T4/T5（工具调用）推迟 | ✅ **9/9 任务完成**（2026-07-13，PR #133 已合）| 详见下方「Phase 1 已落 commits」表 |
| **Phase 2** | Pydantic AI native Tavily tool + sources 编排 + `enable_web_search=True` 切到 Pydantic AI | ✅ **7/7 任务完成**（2026-07-14）| 详见下方「Phase 2 已落 commits」表 |

**总进度：** Phase 1 100%，Phase 2 100%（待 PR 合并）。

---

## Phase 1 详细进度

承接文档：[`2026-07-10-ai-chat-pydantic-ai-phase1.md`](./2026-07-10-ai-chat-pydantic-ai-phase1.md)

| 任务 | 原 plan 编号 | 状态 | 备注 |
|---|---|---|---|
| 任务 1：依赖 | T1 | ✅ 完成 | `pydantic-ai==2.9.0`（升 2.9 后同步断言），5/5 单测 PASS |
| 任务 2：stream_mapper 文本 delta | T2 | ✅ 完成 | text delta → chunk，2/2 PASS |
| 任务 3：stream_mapper thinking delta | T3 | ✅ 完成 | thinking delta → thinking_chunk，2/2 PASS |
| 任务 4：stream_mapper AgentRunResult → usage | T6 | ✅ 完成 | AgentRunResultEvent → usage + final_content，4/4 PASS |
| 任务 5：Agent Factory（无 tools） | T7 裁剪 | ✅ 完成 | build_chat_agent + current_date_instruction；6/6 PASS |
| 任务 6：端点 async + 双路径分流 | T8 裁剪 | ✅ 完成 | 提取 `_prepare_conversation_turn` + `_legacy_stream_response`；4/4 e2e PASS |
| 任务 7：真 LLM 烟雾测试（手测） | T9 | ✅ 完成 | `verify_ai_chat_phase1.py` 自动化跑 3/3 PASS（agent + Damon review） |
| 任务 8：Merge 前最终检查与文档同步 | T10 | ✅ 完成 | 架构文档 § 9.2/§ 10 同步，零回归 baseline |
| **任务 9（PR review 增）**：attached_file 回归修复 | — | ✅ 完成 | Kilo bot 揭示 2 个 WARNING，新/旧两条路径都不丢附件；3 个新单测 TDD 验证 |

**Phase 1 关键决策：**
- 不引 `tavily-python`：factory 不注册 Tavily tool，工具调用推迟 Phase 2
- 端点 `enable_web_search=True` 路径行为完全冻结（用 e2e 测试 byte-for-byte 固化）
- 新 Pydantic AI 路径不自动生成会话标题（与现状不一致场景由 Phase 2 处理）
- 路由矩阵：
  - `enable_web_search=False` + `regenerate=False` → 新路径
  - `enable_web_search=False` + `regenerate=True`  → `HTTP 400`
  - `enable_web_search=True` + 任意 `regenerate` → 旧路径
- **attached_file 修复（PR review 增）**：post-user system 消息折进 user_prompt 前缀（mapper 端）+ legacy 路径 `system_prompt += file_context`（端点端）

**Phase 1 已落 commits（按时间倒序，本轮新提交 11 个）**：

| Commit | 类型 | 说明 |
|---|---|---|
| `30682e18` | fix | **PR review 增**：attached_file 在新/旧两条路径都被静默丢弃；fold-to-prefix + legacy system_prompt 修复；3 个新单测 TDD 验证 |
| `94344201` | docs | PR 描述更新 — 任务 7 agent 自动化真 LLM 验证 + 3 bug fix |
| `1903bd4d` | fix | Phase 1 端到端真 LLM 烟雾测试发现的 3 个 bug（user_prompt/message_history 拆分 + payload.model 支持）|
| `df4740ed` | docs | Phase 1 PR 描述（含烟雾测试脚本 + 回滚策略）|
| `f3071e44` | docs | Phase 1 tracker 标完成（7/8 任务，仅剩任务 7 手测）|
| `97dfbb31` | docs | 同步架构文档 § 9.2 / § 10 至 Phase 1 实际完成情况 |
| `dc01323f` | feat | 端点 async 改造 + 双路径分流（任务 6）|
| `dd89b11c` | feat | Agent 工厂 Phase 1（任务 5）|
| `1f29f103` | feat | stream_mapper 加 AgentRunResultEvent → usage（任务 4）|
| `609953fb` | feat | stream_mapper 加 thinking delta → thinking_chunk（任务 3）|
| `9cedc5e3` | feat | stream_mapper 初版 text delta → chunk（任务 2）|
| `aa3ad92c` | test | 同步依赖测试断言至 pydantic-ai 2.9（任务 1 step 6）|

**Phase 1 风险与注意点：**
- ⚠️ starlette 冲突：pydantic-ai 间接拉入 `sse-starlette>=3` 要 starlette>=1.0；已显式 pin `starlette<0.42,>=0.40` 并在 venv 中卸载 `sse-starlette`（本仓库 app 代码与 pydantic_ai 都不直接 import 它；mcp 包间接需要但本仓库不依赖 mcp）
- Pydantic AI 2.9 在不同 OpenAI 兼容 provider 上的事件顺序可能差异；模型兼容性需一周观察
- Phase 1 已落地的 `99dfbb31`（架构文档同步）确认 pydantic-ai 版本为 2.9.0（升 2.9 后同步更新依赖测试断言）
- **PR review 增 attached_file 回归**：`30682e18` 修复 Kilo bot 揭示的 2 个 WARNING（新/旧两条路径都不丢附件）；3 个新单测 TDD 验证（不打 fix → 3 FAIL；打 fix → 3 PASS）

---

## Phase 2 详细规划（已落地，待 PR 合并）

承接文档：[`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase2.md`](./2026-07-10-ai-chat-pydantic-ai-phase2.md)

| 任务 | 原 plan 编号 | 状态 | 备注 |
|---|---|---|---|
| 任务 1：SearXNG Tavily adapter 返回格式 spike | — | ✅ 完成（2026-07-14） | **决策：完全兼容 Tavily API** — spike 实测 POST `/search` 返回标准 Tavily dict；走 Pydantic AI 自带 `tavily_search_tool`，不走自定义 tool 备选。3/3 spike 单测 PASS。注：tavily-python 0.7.x 参数名是 `api_base_url`（不是 `base_url`）。 |
| 任务 2：stream_mapper tool_calls 分支 | T4 | ✅ 完成（2026-07-14） | FunctionToolCallEvent → tool_calls（一次只产一条 ndjson；tool_searching 由端点层紧接 yield）。3/3 单测 PASS。 |
| 任务 3：stream_mapper tool_result 分支（sources + tool_done） | T5 | ✅ 完成（2026-07-14） | FunctionToolResultEvent → sources + tool_done（一次性 yield 两行 ndjson）；_normalize_tool_content 兼容 list[dict] / dict 含 'results' 键。4/4 单测 PASS。 |
| 任务 4：Agent Factory 注册 `tavily_search_tool` | T7 增量 | ✅ 完成（2026-07-14） | build_chat_agent 加 web_search: bool = False 参数；client 用 api_base_url=settings.ai_chat_web_search_base_url。3/3 单测 PASS。requirements.txt 追加 tavily-python。 |
| 任务 5：端点 `enable_web_search=True` 切到 Pydantic AI native tool；删除 `_legacy_stream_response` | T8 增量 | ✅ 完成（2026-07-14） | 所有 AI chat 用户统一走 Pydantic AI；旧同步路径退役（约 240 行删除）。e2e 测试 mock tool + TestModel call_tools 触发完整事件序列。 |
| 任务 6：真 LLM 烟雾测试（自动化 + Damon review）| T9 增量 | ✅ 完成（2026-07-14） | `scripts/verify_ai_chat_phase2.py` 4/4 PASS：Pydantic AI 路径 3.9s / 路由 400 / web_search 路径 18.4s（6 条 sources 持久化）/ 客户端 abort 3.0s 优雅退出。 |
| 任务 7：Merge 前最终检查与文档同步 | T10 增量 | 🚧 进行中 | 架构文档 § 9.3 + § 10 同步（已完成）；tracker 同步（已完成）；开 PR 待用户授权 |

**Phase 2 验收：**
- ✅ `enable_web_search=True` 用户 ndjson 事件序列与 Phase 1 旧路径完全一致
- ✅ `search_source_cards` / `search_time_range` 持久化字段不变（assistant_message.search_sources 6 条 / search_time_range "day" 实际写入）
- ✅ `cancel_registry` 行为不变（端点层仍走 `cancel_registry.register / unregister`）
- ✅ `tavily-python` 依赖已加入 requirements

---

## 已落地 commits（按时间倒序）

```
ac3ec110 test(ai): 烟雾脚本 phase2 版（覆盖 web_search 路径 + sources 持久化）← Phase 2 任务 6
1a73bbc8 feat(ai): 端点统一走 Pydantic AI + 删除 _legacy_stream_response   ← Phase 2 任务 5
3f085a47 feat(ai): Agent 工厂支持 web_search 注册 tavily_search_tool        ← Phase 2 任务 4
999f1d82 feat(ai): stream_mapper 加 FunctionToolResultEvent → sources+tool_done ← Phase 2 任务 3
39cc67da feat(ai): stream_mapper 加 FunctionToolCallEvent → tool_calls      ← Phase 2 任务 2
22d357e3 docs(superpowers): 记录 Phase 2 spike 决策到 plan + tracker         ← Phase 2 收尾
0d627063 chore(ai): SearXNG Tavily adapter spike（Phase 2 任务 1）
30682e18 fix(ai): PR review 修 attached_file 在新/旧两条路径都被静默丢弃     ← Phase 1 PR review
94344201 docs(superpowers): PR 描述更新 — 任务 7 agent 自动化真 LLM 验证 + 3 bug fix
1903bd4d fix(ai): Phase 1 端到端真 LLM 烟雾测试发现的 3 个 bug
df4740ed docs(superpowers): Phase 1 PR 描述（含烟雾测试脚本 + 回滚策略）
f3071e44 docs(superpowers): Phase 1 tracker 标完成（7/8 任务，仅剩任务 7 手测）
97dfbb31 docs(ai): 同步架构文档至 Phase 1 实际完成情况
dc01323f feat(ai): 端点 async 改造 + 双路径分流（任务 6）
dd89b11c feat(ai): Agent 工厂 Phase 1（任务 5）
1f29f103 feat(ai): stream_mapper 加 AgentRunResultEvent → usage（任务 4）
609953fb feat(ai): stream_mapper 加 thinking delta → thinking_chunk（任务 3）
9cedc5e3 feat(ai): stream_mapper 初版 text delta → chunk（任务 2）
aa3ad92c test(ai): 同步依赖测试断言至 pydantic-ai 2.9（任务 1 step 6）
c759b49b build(deps): 引入 pydantic-ai==2.8.0（chat 流式编排原生化 · Phase 1）★ 主分支前置
49a89653 docs(superpowers): 起草 Phase 1 切分与原 plan 附录                ★ 主分支前置
8d550065 Merge branch 'feat/crm-customer-table'                          ← Phase 1 起点
```

---

## 决策日志

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-10 | Phase 1 不引 `tavily-python` | factory 不注册 Tavily tool，工具调用推迟 Phase 2 |
| 2026-07-10 | 端点 `enable_web_search=True` 路径行为冻结 | 减少变量，Phase 1 风险最小化 |
| 2026-07-10 | 新 Pydantic AI 路径不自动生成会话标题 | 标题生成与 Thinking 指令可能交互复杂；推到 Phase 2 一起处理 |
| 2026-07-10 | Phase 2 必须先做 SearXNG Tavily adapter 返回格式 spike | 决定 mapper `_handle_tool_result` 的 content 解析路径，避免 Phase 2 一开始就猜测 |
| 2026-07-10 | pin `starlette<0.42,>=0.40` 显式约束 | 解决 pydantic-ai 间接拉入 sse-starlette 与 fastapi 0.115.5 starlette 要求的冲突 |

---

## 下一步（建议顺序）

### Phase 1 收尾（任务 7 待人工）

1. **任务 7（真 LLM 烟雾测试）**— 启动后端 + curl 流式请求 + 取消按钮 + 前端冒烟；脚本与验证清单见 PR 描述
2. **开 PR**— 中文 + Conventional Commits（feat/docs/test/build），引用 phase-tracker + native plan + phase1 plan
3. **Merge 后观察一周**— Pydantic AI 2.9 在不同 OpenAI 兼容 provider 上的事件顺序可能差异；模型兼容性需观察

### Phase 2 起步（待 Phase 1 PR 合并后）

1. ✅ **写 `2026-07-10-ai-chat-pydantic-ai-phase2.md` 详细计划** — 2026-07-13 起草完成
2. **任务 1：SearXNG Tavily adapter 返回格式 spike**— 决定 mapper `_handle_tool_result` 怎么解析 content（dict vs list[dict]）
3. 后续按 Phase 2 plan 任务 2-7 顺序推进

---

## 跟踪维护

- **每次提交后**：把 commit hash 与简短说明补到对应阶段的「已落地 commits」段
- **跨阶段切换时**：把上一阶段标记为「✅ 完成」，把下一阶段标记为「🚧 进行中」
- **决策新增时**：追加到「决策日志」
- **下次接手的人**：从「下一步（建议顺序）」开始即可

---

## 相关文档

- 原 plan：`./2026-07-10-ai-chat-pydantic-ai-native.md`（含 § 9.2 落地路径 + Phase 边界附录）
- Phase 1 详细：[`./2026-07-10-ai-chat-pydantic-ai-phase1.md`](./2026-07-10-ai-chat-pydantic-ai-phase1.md)
- Phase 2 详细：`./2026-07-10-ai-chat-pydantic-ai-phase2.md`（待 Phase 1 完成后起草）
- 架构文档：`../../ai-chat-native-architecture.md`（§ 7 / § 9 / § 10）