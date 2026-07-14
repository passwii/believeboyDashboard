# PR 描述：AI Chat Pydantic AI Native · Phase 2

> **PR 替换建议**：`gh pr create --title "feat(ai): AI Chat Pydantic AI Native · Phase 2（web_search 切到 Pydantic AI + 删 legacy）" --body-file docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase2-pr-description.md --base main --head feat/ai-chat-pydantic-ai-phase2`

---

## 标题

```
feat(ai): AI Chat Pydantic AI Native · Phase 2（web_search 切到 Pydantic AI + 删 legacy）
```

## 关联

- 主权威路线图：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md`
- Phase 1 PR #133：已合 main（async + Pydantic AI driver 垂直切片）
- Phase 1 计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1.md`
- Phase 2 计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase2.md`
- 阶段跟踪：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`
- 架构文档：`docs/ai-chat-native-architecture.md` § 9.3 / § 10

## 目标

承接 Phase 1 的 Pydantic AI driver 基础设施，把 `enable_web_search=True` 用户也切到 Pydantic AI 编排，统一所有 AI chat 用户的代码路径，删除 Phase 1 临时保留的旧 httpx 同步流（`_legacy_stream_response`）。

## 改动文件清单

### 新建（3 个）

| 文件 | 行数 | 职责 |
|---|---|---|
| `backend/scripts/spike_searxng_tavily_adapter.py` | ~110 | 一次性 spike 脚本（任务 1）— 实测 SearXNG adapter 兼容性 |
| `backend/tests/services/test_searxng_adapter_spike.py` | ~80 | spike 断言固化（防 regression）— 3 单测 |
| `backend/scripts/verify_ai_chat_phase2.py` | ~440 | 烟雾脚本（任务 6）— 4 测试：Pydantic AI / 400 / web_search / 客户端 abort |

### 修改（5 个）

| 文件 | 变更 |
|---|---|
| `backend/app/services/ai/stream_mapper.py` | 加 `FunctionToolCallEvent → tool_calls`（任务 2）+ `FunctionToolResultEvent → sources + tool_done`（任务 3）共 2 分支；`_normalize_tool_content` 兼容 list[dict] / dict；`MapperState` 加 `last_tool_part` / `search_source_cards` / `search_time_range` / `last_search_query` 字段 |
| `backend/app/services/ai/agent.py` | `build_chat_agent(..., web_search: bool = False)`：True 时注册 Pydantic AI 自带 `tavily_search_tool`（client 指向 SearXNG adapter），并追加 web_search 行为指令 |
| `backend/app/api/v1/endpoints/ai_chat.py` | `stream_message` 路由矩阵简化（统一走 Pydantic AI）；**删除 `_legacy_stream_response` 函数**（约 240 行）；端点层在 `FunctionToolCallEvent` 后 yield `tool_searching`（与既有 ndjson 协议兼容）；持久化层写 `search_sources` / `search_time_range` 到 `assistant_row` |
| `backend/requirements.txt` | 追加 `tavily-python`（Pydantic AI Tavily tool 运行时依赖） |
| `backend/tests/api/test_ai_chat_stream_native.py` | e2e 改造：删除 legacy byte-for-byte 测试；新增 `test_web_search_true_uses_pydantic_ai_tavily_tool`（mock tool + TestModel call_tools 触发完整事件序列）+ `test_web_search_true_does_not_call_legacy_stream_with_tool_calling`（防 regression）|
| `docs/ai-chat-native-architecture.md` | § 9.3 标 Phase 2 已落地；§ 10 追加 tavily-python 依赖 |
| `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md` | 阶段状态：Phase 1 9/9 + Phase 2 7/7；已落 commits 追加 7 个；决策日志补充 2 条 Phase 2 关键决策 |

## 行为变化

| # | 改动 | 旧行为（Phase 1）| 新行为（Phase 2）|
|---|---|---|---|
| 1 | `enable_web_search=True` 路径 | 走旧 `_legacy_stream_response`（httpx 同步流）| 走 Pydantic AI driver（同 `enable_web_search=False` 路径），由 agent 自动调用 `tavily_search` 工具 |
| 2 | 工具调用逻辑 | 端点层 `build_payload_messages_with_tools` + `stream_with_tool_calling` | 端点层直接 `agent.run_stream_events` + mapper 产 `tool_calls` / `sources` / `tool_done` 事件 |
| 3 | `tool_searching` 事件 | 端点层从 `stream_with_tool_calling` 透传 | 端点层在 `FunctionToolCallEvent` 后手动 yield（mapper 每次只产一条 ndjson）|
| 4 | 端点代码量 | ~835 行（双路径）| ~593 行（单路径，删 ~240 行 legacy）|
| 5 | `regenerate + enable_web_search=False` 行为 | HTTP 400「重新生成仅在启用联网搜索时支持」| **保留**：保守防 Tavily tool 对 regenerate 行为未验证 |
| 6 | `search_sources` 持久化 | 端点层从 `event.get("sources")` 收 | 端点层从 `state["search_source_cards"]` 收（mapper 写入）|

## 端点路由矩阵（Phase 2）

| `enable_web_search` | `regenerate` | 路径 | 备注 |
|---|---|---|---|
| `False` | `False` | ✅ Pydantic AI 路径 | 与 Phase 1 一致 |
| `False` | `True`  | ❌ `HTTP 400 重新生成仅在启用联网搜索时支持` | 保留（保守）|
| `True`  | `False` | ✅ Pydantic AI + tavily_search_tool | **Phase 2 收口** |
| `True`  | `True`  | ✅ Pydantic AI + tavily_search_tool | **Phase 2 收口** |

## 显式冻结（不在本 PR 范围）

- ❌ 不动前端代码（`consumeStream` 与 ndjson 协议零改动）
- ❌ 不动 `stream_utils.build_stream_*` / `chat_service.*` / `cancel.py` / `search.py` / `tools.py` / `llm.py`
- ❌ 不解决 SearXNG 中文搜索质量问题（独立 ticket）
- ❌ 不优化 tool 调用循环的 token 成本（独立 ticket）
- ❌ 不引入 streaming tool calls（独立 ticket）
- ❌ 不自动生成会话标题（Phase 1 推迟项保持）

## 关键决策（spike 揭示）

| 决策 | 原因 |
|---|---|
| SearXNG adapter 完全兼容 Tavily API | spike 实测 POST `/search` 返回标准 Tavily dict（results 是 list，每项含 title/url/content/score/raw_content），决策走 Pydantic AI 自带 `tavily_search_tool`，不走自定义 tool 备选路径 |
| `tavily-python` 0.7.x 参数名是 `api_base_url` | 与 Pydantic AI `tavily_search_tool` 文档示例的 `base_url=` 不一致；spike 实测揭示 |
| mapper `_handle_tool_result` content 解析路径 | `list[dict]`（Pydantic AI Tavily tool 标准返回）+ 兼容 `dict` 含 'results' 键（防 SearXNG adapter 后续变更）|

## 测试覆盖

**新增 14 个测试**（mapper 7 + factory 3 + spike 3 + e2e 2 - 删除 2 个 legacy）：
- `tests/services/test_stream_mapper.py`：3 + 4 = 7 个新单测（tool_calls / tool_result / 兼容性 / 别名）
- `tests/services/test_agent_factory.py`：3 个新单测（默认无 tool / web_search 注册 / client 用 settings base_url）
- `tests/services/test_searxng_adapter_spike.py`：3 个新单测（dict 响应 / results 列表 / 必填字段）
- `tests/api/test_ai_chat_stream_native.py`：2 个新 e2e（web_search 走 Pydantic AI / 不调用 legacy stream_with_tool_calling）
- 删除 2 个 legacy 测试（`test_legacy_path_preserved_when_enable_web_search_true` + `test_legacy_stream_response_injects_attached_file_into_system_prompt`，功能被 mapper 替代）

**全量后端测试**：

| 范围 | main | 本分支 | 差异 |
|---|---|---|---|
| 通过 | 751 | 807 | **+56**（mapper 15 + factory 9 + dep 1 + spike 3 + search_source_cards 17 + native 11 + 1 pipeline regression-free）|

## 端到端真 LLM 烟雾（`scripts/verify_ai_chat_phase2.py`）

| # | 路径 | 结果 | 时长 |
|---|---|---|---|
| 1 | Pydantic AI（enable_web_search=False）| ✓ start → chunk → usage → done | 3.9s |
| 2 | 路由矩阵（regenerate + no web_search）| ✓ HTTP 400 | <1s |
| 3 | **Pydantic AI + Tavily（enable_web_search=True）**| ✓ start → chunks → tool_calls × 3 → tool_searching × 3 → sources × 3 → tool_done × 3 → 31 chunks → usage → done | 18.4s |
| 3b | 持久化校验（Phase 2 增量）| ✓ assistant_message.search_sources 6 条 / search_time_range "day" 已写入 | — |
| 4 | 客户端中途 abort | ✓ 5 chunks 后强制断开，服务端 3.0s 优雅退出 | 3.0s |

**SearXNG adapter 真实响应**（spike 输出）：

```json
{
  "query": "今天北京天气",
  "follow_up_questions": null,
  "answer": null,
  "images": [],
  "results": [
    {
      "url": "https://www.weather.com.cn/weather/101010100.shtml",
      "title": "北京天气预报,北京7天天气预报,北京15天天气预报,北京天气查询",
      "content": "北京天气预报，及时准确发布中央气象台天气信息...",
      "score": 0.9,
      "raw_content": null
    },
    ...
  ],
  "response_time": 0.5,
  "request_id": "..."
}
```

## 风险点

| 风险 | 影响 | 缓解 |
|---|---|---|
| Pydantic AI tool call 循环不收敛 | 流式响应卡住 / token 成本飙升 | 暂不优化（独立 ticket）；smoke 测试通过（18.4s 内完成 3 轮 tool 循环 + 31 chunk 文本）|
| SearXNG 中文搜索质量差 | 用户体验下降 | 独立 ticket；本 PR 不解决 |
| mapper 多 tool_call 循环时 `state["search_source_cards"]` 覆盖 | 早期 call 的 sources 丢失 | 当前实现：保留最后一次 call 的 sources（与模型最终回答基于的最后一次 search 一致）；smoke 测试 6 条 sources 正常持久化 |
| Pydantic AI 2.9 在不同 provider 上的事件顺序可能差异 | 模型兼容性需观察 | Phase 1 已观察一周未出现；Phase 2 同样策略 |

## 回滚策略

- **单 commit revert**：每个 commit 独立可 revert
- **回退 mapper tool_calls/tool_result 分支**：删除 mapper 中 2 个分支即可，端点不再触发（agent tool 调用结果不映射到 ndjson，前端不会显示 sources 卡片）
- **回退 factory tavily 注册**：`build_chat_agent` 的 `web_search` 参数默认 False；端点不传 `web_search=` 即不注册
- **回退端点切 Pydantic AI**：把 `stream_message` 的 `web_search=payload.enable_web_search` 改为 `web_search=False` 即可，所有用户走无 tool 路径

## 部署注意事项

- 部署到 VPS 后**重启 believeboy-api 服务**（pre-push hook 会自动做：`alembic upgrade head → systemctl restart believeboy-api`）
- 本 PR 无 alembic migration（纯代码 + 单测），DB schema 不变
- 追加依赖 `tavily-python`，需 `pip install` 触发（pre-push hook 会自动）
- 无前端改动（前端 `consumeStream` 不变，UX 零差异）
- 建议周观察期监控 Pydantic AI 2.9 tool 循环稳定性（如有问题回滚本分支）