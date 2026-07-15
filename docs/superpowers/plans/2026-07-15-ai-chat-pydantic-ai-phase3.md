# AI Chat Pydantic AI Native 实施 · Phase 3（自动生成会话标题）

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
> 步骤使用复选框（`- [ ]`）语法跟踪进度。
> **Phase 3 范围很小、风险低**：纯后端，复用既有 `generate_conversation_title`，前端协议零改动。

**承接文档：**
- 原 10 任务完整路线图：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md`
- Phase 1 详细计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1.md`（已 ✅ 合并 #133）
- Phase 2 详细计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase2.md`（已 ✅ 合并 #134）
- 跨阶段跟踪：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`
- 架构文档：`docs/ai-chat-native-architecture.md`（§ 9.3 当前标为「Phase 3 候选」）

**本计划聚焦：** 补齐被 Phase 1 / Phase 2 刻意推迟的「自动生成会话标题」——新 Pydantic AI 流式路径在第一次用户→助手回合后，自动用 LLM 生成会话标题并写回，使标题行为与旧路径一致（旧路径会在首轮自动出标题，新路径自 Phase 1 起一直留默认「新对话」）。

---

## Phase 边界

| 项 | 状态 | 说明 |
|---|---|---|
| 自动生成会话标题（首轮） | 🚧 Phase 3 | 本计划唯一目标 |
| T1–T10（原 10 任务） | ✅ Phase 1+2 | 已全部覆盖并合并 |
| 前端标题消费协议 | ✅ 已实现 | `use-chat-stream.ts:145` 已处理 `titleRegenerated` → `onTitleUpdate`，零改动 |
| 手动「重新生成标题」端点 | ✅ 已实现 | `ai_chat.py:158` `regenerate_conversation_title`，Phase 3 不改 |

**Phase 3 显式冻结（不在范围）：**
- 不改前端任何代码（协议已支持）
- 不改 `stream_utils.build_stream_*` / `chat_service.*` 既有方法签名
- 不改 `generate_conversation_title` / `regenerate_conversation_title` 的 LLM 提示词与归一化逻辑（`normalize_generated_title` 已复用）
- 不引入 streaming tool calls / 多轮标题等其他 ticket
- 不变更端点路由矩阵（`enable_web_search` / `regenerate` 行为完全不动）

---

## Phase 3 目标 & 非目标

**目标：**
- 新 Pydantic AI 流式路径在「首轮且会话仍是默认标题」时，自动调用 `generate_conversation_title(user_content, final_content)` 生成标题并持久化到 `conversation.title`
- `done` 事件携带更新后的 `conversation_title` 且 `title_regenerated=True`，让前端侧边栏即时刷新标题
- 当标题已被用户自定义（非默认「新对话」）时绝不覆盖
- `regenerate=True` 路径不改写标题（手动重生成走既有专用端点）
- 标题 LLM 调用失败 / 未配置 provider / 内容为空时：安静跳过，保留默认标题，`title_regenerated=False`，流式不报错

**非目标：**
- 不重做标题 LLM 提示词或模型选择（沿用 `resolve_title_model`）
- 不在每轮都重算标题（只在首次默认标题时算一次）
- 不改动前端

---

## 现状分析（已探查，落结论）

1. **会话默认标题**：`app/services/ai/chat.py:45` — `create_conversation` 把空标题规范为 `"新对话"`。
2. **流式路径不自动出标题**：`app/api/v1/endpoints/ai_chat.py` `event_stream` 在提交终态后（`ai_chat.py:406` `db.commit()`）直接 `build_stream_done(..., conversation_title=conversation.title, title_regenerated=False)`（`ai_chat.py:410-422`）。`conversation.title` 此时仍是默认值。
3. **生成函数已就绪**：`app/services/ai/llm.py:426` `generate_conversation_title(settings, user_content, assistant_content)`，且已在 `app/services/ai/__init__.py:40,109` 经 `app.services.ai` 包重新导出 → 端点可直接 `ai_chat_service.generate_conversation_title(...)`。该校验：provider 未配置 / user 或 assistant 内容为空 / API 失败均返回 `None`（不抛异常）。
4. **前端已支持**：`frontend/components/chat/hooks/use-chat-stream.ts:145` — `if (payload.titleRegenerated && payload.conversationTitle) callbacksRef.current.onTitleUpdate?.(payload.conversationTitle)`。协议字段 `conversation_title` / `title_regenerated` 已在 `ai-chat-stream.ts:82,86,272,276` 解析。**无需前端改动。**
5. **既有手动重生成范式可复用**：`ai_chat.py:158-179` `regenerate_conversation_title` 端点——调 `ai_chat_service.regenerate_conversation_title(settings, messages)`，成功后 `conversation.title = generated_title; db.commit()`。Phase 3 的自动路径提交方式与之同构。

---

## 设计

### 触发条件（精确）
在 `event_stream` 提交终态后、构造 `build_stream_done` 之前：

```
should_autotitle = (
    not regenerate                      # 手动 regenerate 路径不改写标题
    and conversation.title == "新对话"  # 仅默认标题时算一次，绝不覆盖自定义标题
    and bool(final_content)             # 助手有实际回复才生成（final_content 来自 state["final_content"]）
)
```

- `regenerate` 与 `final_content` 在 `event_stream` 闭包内已可用（`regenerate` 来自 `payload.regenerate`；`final_content = state.get("final_content") or ""`，见 `ai_chat.py:390`）。
- `conversation.title` 在闭包内可用（同一 ORM 实例）。

### 执行（非阻塞）
`generate_conversation_title` 内部是同步 `request_chat_completion`（HTTP）。端点为 async，必须用 `asyncio.to_thread` 包裹，避免阻塞事件循环：

```
title_regenerated = False
if should_autotitle:
    try:
        generated = await asyncio.to_thread(
            ai_chat_service.generate_conversation_title,
            settings, user_content, final_content,
        )
    except Exception:                       # 双保险：标题失败绝不影响 done 事件
        generated = None
        logger.warning("phase3 autotitle failed; keep default title")
    if generated:
        conversation.title = generated
        db.commit()
        title_regenerated = True
```

### 复用既有字段
将 `build_stream_done(...)` 的两处硬编码改为变量：

```
yield build_stream_done(
    ...,
    conversation_title=conversation.title,   # 已是更新后的值（ORM 实例已改）
    ...,
    title_regenerated=title_regenerated,     # 原为 False
)
```

- `conversation.title` 在 `db.commit()` 后即为新值（同一实例），无需 refresh 即可读。
- `settings` 由端点 `Depends(get_settings)` 注入，闭包可捕获（与 `regenerate` 端点一致，见 `ai_chat.py:161`）。若闭包未捕获，显式作为参数传入 `event_stream`。
- 需在 `ai_chat.py` 顶部加 `import asyncio`（当前未导入）。

### 边界与异常
- `generate_conversation_title` 自身已对「provider 未配置 / 空内容 / API 失败」返回 `None` → `title_regenerated=False`，标题不变。
- 外层 `try/except` 仅作双保险：任何意外异常都不应阻断 `done` 事件（否则前端拿不到完整响应）。
- 取消 / 异常分支（`ai_chat.py:423-427` `_CancelledError` / `except Exception`）不改——标题生成只在正常完成路径执行。

---

## 任务清单

- [ ] **任务 1：确认闭包变量可用 + 加 import**（探查已完成，实现时落地）
  - `ai_chat.py` 顶部加 `import asyncio`
  - 确认 `settings` / `user_content` / `regenerate` / `final_content` 在 `event_stream` 闭包内可见；不可见则作为参数传入
  - 复用 `ai_chat_service.generate_conversation_title`（已在 `app.services.ai` 导出，无需新增封装）

- [ ] **任务 2：端点流式路径接入自动标题（核心）**
  - 在 `ai_chat.py` `event_stream` 的 `db.commit()`（`ai_chat.py:409`）之后、`build_stream_done`（`ai_chat.py:410`）之前插入「触发条件判断 + `asyncio.to_thread` 调用 + 提交 + 计算 `title_regenerated`」
  - 将 `build_stream_done` 的 `conversation_title=conversation.title` 保持不变、`title_regenerated=False` 改为 `title_regenerated=title_regenerated`
  - 断言：仅默认标题首轮触发；自定义标题 / `regenerate=True` / 空助手内容均不触发

- [ ] **任务 3：单测（mock `generate_conversation_title`）**
  - 新增 `backend/tests/api/test_ai_chat_autotitle.py`（或并入 `test_ai_chat_stream_native.py`）：
    - 3a 首轮默认标题 → 调 `generate_conversation_title` → `done` 事件 `title_regenerated=True` 且 `conversation_title` 为新值；DB `conversation.title` 已更新
    - 3b 自定义标题（创建时给了非空 title）→ 不调 `generate_conversation_title` → `title_regenerated=False`
    - 3c `generate_conversation_title` 返回 `None`（provider 未配置 / mock 返回 None）→ 不抛异常，`title_regenerated=False`，默认标题保留
    - 3d `regenerate=True` 路径 → 不触发自动标题
  - mock 方式：`monkeypatch.setattr(ai_chat_service, "generate_conversation_title", lambda *a, **k: "生成的标题")`（与现有测试 monkeypatch `build_chat_agent` 风格一致）

- [ ] **任务 4：真 LLM 烟雾测试脚本 phase3**
  - 新增 `backend/scripts/verify_ai_chat_phase3.py`（沿用 phase1/phase2 脚本结构）：
    - 起后端 → 建会话（默认标题）→ 发首条消息（mock 标题 LLM 或真 LLM）→ 解析 `done` 事件 → 断言 `title_regenerated=True` 且标题非「新对话」、DB 已落库
    - 第二条消息 → 断言不再触发（`title_regenerated=False`）
  - 手测清单：真 LLM 跑一轮，确认侧边栏标题在首轮后刷新；provider 未配置时标题保持「新对话」且会话不报错

- [ ] **任务 5：Merge 前文档同步**
  - 架构文档 `docs/ai-chat-native-architecture.md` § 9.3：把「Phase 3 候选」改为「已落地（Phase 3，2026-07-15）」，补一段「自动标题：流式首轮默认标题时调 `generate_conversation_title`，`done` 事件 `title_regenerated=True`，前端 `onTitleUpdate` 零改动」
  - `phase-tracker.md`：Phase 3 行标 ✅ 完成；阶段状态总览补 Phase 3；决策日志补一行「自动生成会话标题 由 Phase 3 补齐」
  - 本 plan 标「起草完成」

---

## 验收

- ✅ 新会话首条消息完成后，侧边栏会话标题自动变为 LLM 生成的中文短标题（≤18 字，无引号/句号）
- ✅ DB `ai_conversation.title` 持久化为新标题（刷新页面仍在）
- ✅ `done` 事件 `title_regenerated=True` 且仅首轮为 True；后续轮 `title_regenerated=False`
- ✅ 用户自建会话（创建时给了自定义标题）标题不被覆盖
- ✅ `regenerate=True` 流式路径标题不变（手动重生成仍走专用端点）
- ✅ provider 未配置 / 标题 LLM 失败 / 助手空回复：会话不报错，标题保持默认，流式正常结束
- ✅ 前端零改动、零回归（既有 `consumeStream` / `onTitleUpdate` 直接生效）

---

## 回滚策略

- 单一改动聚在 `ai_chat.py` `event_stream` 一处 + `import asyncio`；回滚 = 还原该段（约 10 行），无 schema / 迁移变更。
- 不引入新依赖、不改 `requirements.txt`（`generate_conversation_title` 已在用）。
- 若上线后标题质量/延迟不可接受：只需把「触发条件」整体注释掉即可回到默认标题行为，无需回退整 PR。

---

## 风险与注意点

- ⚠️ **事件循环阻塞**：`generate_conversation_title` 是同步 HTTP，必须 `asyncio.to_thread`，直接 `await`/同步调用会卡住单 worker 的异步事件循环。
- ⚠️ **首轮延迟**：标题 LLM 调用在流式结束后、构造 `done` 前，会延迟 `done` 事件约 1–2s。UI 已先渲染完整回复，仅侧边栏标题延迟刷新，可接受。
- ⚠️ **`conversation.title == "新对话"` 作为触发哨兵**：依赖默认标题字面量。若未来默认标题文案变更，需同步此处常量（建议在 `chat.py` 抽 `DEFAULT_CONVERSATION_TITLE` 常量，Phase 3 顺手做，避免字面量散落）。
- ⚠️ **DB 会话**：标题提交复用同一 `db` 会话，已在 `event_stream` 内；注意与既有 `db.commit()` 顺序（`recalculate_conversation_token_stats` 之后的 `db.commit()` 先执行，再提交标题）。
- ⚠️ **测试 monkeypatch 点**：确认 mock `ai_chat_service.generate_conversation_title` 能命中端点实际调用（端点经 `app.services.ai` 包访问；monkeypatch 该属性即可）。

---

## 决策日志

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-15 | Phase 3 仅做「首轮自动标题」，前端零改动 | 前端 `onTitleUpdate` 已支持 `title_regenerated` 协议；旧路径即有此行为，补齐即一致 |
| 2026-07-15 | 复用 `generate_conversation_title`（不新写 LLM 调用） | 该函数已处理 provider 配置 / 空内容 / 失败返回 None，与手动重生成同源，行为统一 |
| 2026-07-15 | 标题 LLM 调用包 `asyncio.to_thread` | 端点是 async；同步 HTTP 直呼会阻塞事件循环 |
| 2026-07-15 | 以 `conversation.title == "新对话"` 为触发哨兵 | 仅默认标题时算一次，绝不覆盖用户自定义标题；`regenerate=True` 显式排除 |

---

## 下一步

- Phase 3 合并后，Pydantic AI Native 迁移（原 10 任务 + 标题补齐）全部完成，无定义中的后续 phase。
- 独立 ticket（不在本 phase）：SearXNG 中文搜索质量、tool 调用 token 成本优化、streaming tool calls。
