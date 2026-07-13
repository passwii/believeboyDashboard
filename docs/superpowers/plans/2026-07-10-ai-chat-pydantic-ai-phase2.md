# AI Chat Pydantic AI Native 实施 · Phase 2

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
> 步骤使用复选框（`- [ ]`）语法跟踪进度。
> **Phase 2 起点前置：** SearXNG Tavily adapter 返回格式 spike（任务 1）必须先完成，否则后续任务的工具选择无依据。

**承接文档：**
- 原 10 任务完整路线图：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md`
- Phase 1 详细计划：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase1.md`（已 ✅ 2026-07-13）
- 跨阶段跟踪：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`

**本计划聚焦：** 原任务 T4 / T5 / T7（增量）/ T8（增量）；T9（真 LLM 烟雾全量）；T10（文档收尾）。

---

## Phase 边界

| 原任务 | 状态 | 说明 |
|---|---|---|
| T1 依赖 | ✅ Phase 1 | pydantic-ai 2.9 已装；Phase 2 追加 `tavily-python` |
| T2-T3 mapper text/thinking delta | ✅ Phase 1 | — |
| **T4 mapper tool_calls** | 🚧 Phase 2 | `FunctionToolCallEvent → build_stream_tool_calls` |
| **T5 mapper tool_result** | 🚧 Phase 2 | `FunctionToolResultEvent → build_stream_sources + build_stream_tool_done` |
| T6 mapper usage | ✅ Phase 1 | — |
| **T7 Agent factory 增量** | 🚧 Phase 2 | 注册 `tavily_search_tool`（client 指 SearXNG adapter） |
| **T8 端点 async 重写（增量）** | 🚧 Phase 2 | `enable_web_search=True` 切到 Pydantic AI native tool；删除 `_legacy_stream_response` |
| **T9 烟雾测试（增量）** | 🚧 Phase 2 | 真 LLM 端到端验证 web_search 路径；前端 consumeStream 全类型解析 |
| T10 文档同步 | 🚧 Phase 2 | 架构文档 § 9.2 标 Phase 2 完成；§ 9.3 标「Phase 3 候选」或删除 |

**Phase 1 已落地的冻结项**（Phase 2 不允许回头破坏）：
- 端点路由矩阵中 `enable_web_search=False` + `regenerate=True` → `HTTP 400` 行为
- `pydantic-ai==2.9.x` 版本
- mapper 每次返回 `bytes | None`（单条 ndjson 行）；复杂多行 yield 留给端点
- `_prompt_messages_to_pydantic_ai_args` 把 post-user system 消息折进 user_prompt 前缀
- `_legacy_stream_response` 内的 `llm_config.system_prompt += file_context` 注入
- 前端 `consumeStream` 与 ndjson 协议零改动

**Phase 2 显式冻结（不在本 PR 范围）：**
- 不动 `stream_utils.build_stream_*`（仅消费既有编码器）
- 不动 `chat_service.*` / `cancel.py` / `tools.py`（除 web_search 路径删除外）
- 不动 `search.py` / `build_search_source_cards`（除非 spike 揭示必须改）
- 不动 mapper 的 text / thinking / usage 分支
- 不引入 streaming tool calls（Phase 2 走单次 tool call；streaming tool 是独立 ticket）
- 不改前端代码

---

## Phase 2 目标 & 非目标

**目标：**
- 所有 AI chat 用户（无论 `enable_web_search`）走 Pydantic AI driver
- 删除 `ai_chat.py` 的 `_legacy_stream_response` 函数与 `_prepare_conversation_turn` 中的旧路径分支
- 删除 `enable_web_search=True` + `regenerate=True` 的旧兜底
- 删除 `enable_web_search=True` + `regenerate=False` 的旧兜底
- 端点路由矩阵简化为：`enable_web_search` 二选一（不论 `regenerate`）；`regenerate=True` + `enable_web_search=False` 继续返回 400（Phase 1 行为保留）
- `search_source_cards` / `search_time_range` 持久化字段不变
- `cancel_registry` 行为不变
- 前端 `consumeStream` 解析所有事件类型零回归

**非目标：**
- 不解决 SearXNG 中文搜索质量问题（独立 ticket）
- 不优化 tool 调用循环的 token 成本（独立 ticket）
- 不引入 streaming tool calls（独立 ticket）
- 不自动生成会话标题（Phase 1 推迟项，Phase 2 不重启）

---

## 端点路由行为矩阵（Phase 2）

| `enable_web_search` | `regenerate` | 路径 | 备注 |
|---|---|---|---|
| `False` | `False` | ✅ 新 Pydantic AI 路径 | 与 Phase 1 一致 |
| `False` | `True`  | ❌ `HTTP 400 重新生成仅在启用联网搜索时支持` | 与 Phase 1 一致 |
| `True`  | `False` | ✅ Pydantic AI native `tavily_search_tool` 路径 | **Phase 2 新增** |
| `True`  | `True`  | ✅ Pydantic AI native `tavily_search_tool` 路径 | **Phase 2 新增**（允许 regenerate，因 Tavily tool 行为确定）|

---

## 文件改动清单

### 新建

| 文件 | 职责 |
|---|---|
| `backend/scripts/spike_searxng_tavily_adapter.py` | 一次性 spike 脚本：直接调 `AsyncTavilyClient.search()` 命中 `https://search.believeboy.com`，输出实际响应 body；据此判断是否复用 `tavily_search_tool` 还是写自定义 tool |
| `backend/tests/services/test_searxng_adapter_spike.py` | 把 spike 的关键断言固化为单测（防回归） |

### 修改

| 文件 | 变更 |
|---|---|
| `backend/requirements.txt` | 追加 `tavily-python`（pydantic-ai 原生 Tavily 工具运行时依赖） |
| `backend/app/services/ai/agent.py` | `build_chat_agent` 增加 `web_search: bool = False` 参数；为 `True` 时注册 `tavily_search_tool`（client 指向 `settings.ai_chat_web_search_base_url`），并追加 web_search 行为指令 |
| `backend/app/services/ai/stream_mapper.py` | 新增 `FunctionToolCallEvent` → `tool_calls` 分支；新增 `FunctionToolResultEvent` → `sources + tool_done` 分支；新增 `MapperState` 字段 `last_tool_part / search_source_cards / search_time_range / last_search_query` |
| `backend/app/services/ai/stream_mapper.py` | 改文档头：Phase 2 覆盖范围更新 |
| `backend/app/api/v1/endpoints/ai_chat.py` | 删除 `_legacy_stream_response` 函数（行 573-820 区间） |
| `backend/app/api/v1/endpoints/ai_chat.py` | `stream_message` 路由矩阵简化：移除 `if payload.enable_web_search:` 分支；统一走 Pydantic AI 路径；按 `payload.enable_web_search` 决定 agent 工厂是否注册 Tavily tool |
| `backend/app/api/v1/endpoints/ai_chat.py` | 删除 `regenerate + web_search=False` 的 400 校验（Phase 2 统一走 Pydantic AI；但若 Tavily tool 行为对 regenerate 不友好，保留 400）— 决策见任务 5 |
| `backend/tests/services/test_agent_factory.py` | 新增 `web_search=True` 时 factory 注册 `tavily_search_tool` 的断言 |
| `backend/tests/services/test_stream_mapper.py` | 新增 `FunctionToolCallEvent` / `FunctionToolResultEvent` 分支测试 |
| `backend/tests/api/test_ai_chat_stream_native.py` | e2e 改造：删除 legacy path byte-for-byte 测试；新增 `enable_web_search=True` 路径 Pydantic AI 测试（用 TestModel + `call_tools=["tavily_search"]` 触发 tool call 循环） |
| `backend/scripts/verify_ai_chat_phase1.py` | 改名 `verify_ai_chat_phase2.py`；新增「web_search 路径」e2e 测试（Pydantic AI + Tavily tool 触发的 tool_calls/sources/tool_searching/tool_done/done 事件序列） |
| `docs/ai-chat-native-architecture.md` | § 9.2 标 Phase 2 完成；§ 9.3 删除（无 Phase 3）或改「Phase 3 候选」；§ 10 追加 tavily-python 版本 |

### 删除

| 文件/段 | 说明 |
|---|---|
| `backend/app/api/v1/endpoints/ai_chat.py:_legacy_stream_response` | Phase 2 起所有 web_search 用户走 Pydantic AI；旧 httpx 同步流退役 |
| `backend/app/api/v1/endpoints/ai_chat.py:_prepare_conversation_turn.prompt_messages` 末尾 attached_file 追加逻辑 | Phase 2 用 mapper 内的 `_handle_attached_file_to_agent_instructions` 替代（详见任务 2） |

---

## 任务

### 任务 1：SearXNG Tavily adapter 返回格式 spike（必须先做）

**目的：** 决定 mapper `_handle_tool_result` 解析 content 的路径（dict vs list[dict]）；决定能否直接用 Pydantic AI 自带的 `tavily_search_tool`，还是写自定义 tool 函数。

**背景：**
- `tavily-python` 的 `AsyncTavilyClient.search()` 默认 POST 到 `https://api.tavily.com/search`，但支持 `base_url` 参数覆盖
- 本仓库的 `AI_CHAT_WEB_SEARCH_BASE_URL=https://search.believeboy.com` 是一个 SearXNG adapter（曾由 `chat_service.request_web_search` 直接 httpx 调用）
- adapter 是否严格兼容 Tavily API 协议未知；spike 是必要前置

**文件：**
- 创建：`backend/scripts/spike_searxng_tavily_adapter.py`
- 创建：`backend/tests/services/test_searxng_adapter_spike.py`

- [ ] **步骤 1：写 spike 脚本**

```python
# backend/scripts/spike_searxng_tavily_adapter.py
"""一次性 spike：SearXNG Tavily adapter 是否真兼容 Tavily API。

运行：
    cd backend && DATABASE_URL=... ./.venv/bin/python scripts/spike_searxng_tavily_adapter.py

输出：
    - 实际 HTTP 请求 URL / payload / headers
    - 实际响应 body（首 500 字符）
    - 兼容性结论：FITS_TAVILY_TOOL / NEEDS_CUSTOM_TOOL
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))


async def _call_tavily_client() -> dict:
    from tavily import AsyncTavilyClient

    base_url = os.environ.get("AI_CHAT_WEB_SEARCH_BASE_URL", "https://search.believeboy.com")
    api_key = os.environ.get("AI_CHAT_WEB_SEARCH_API_KEY", "dummy")
    client = AsyncTavilyClient(api_key=api_key, base_url=base_url)
    raw = await client.search(
        query="今天北京天气",
        search_depth="advanced",
        topic="general",
        time_range="day",
        max_results=5,
    )
    return {"raw_type": type(raw).__name__, "raw_keys": list(raw.keys()) if isinstance(raw, dict) else None, "results_sample": raw.get("results", [])[:2] if isinstance(raw, dict) else None}


def main() -> int:
    result = asyncio.run(_call_tavily_client())
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))

    if not isinstance(result["raw_type"], str) or result["raw_type"] != "dict":
        print("\n❌ 响应不是 dict，Tavily 原生工具不兼容，需写自定义 tool")
        return 1
    if not result["results_sample"]:
        print("\n⚠️ 响应 dict 但 results 为空，可能是 SearXNG 暂未抓取到结果；再用 query='北京' 复测")
        return 2
    sample = result["results_sample"][0]
    required_keys = {"title", "url", "content", "score"}
    if not required_keys.issubset(sample.keys()):
        print(f"\n⚠️ results 缺关键字段 {required_keys - sample.keys()}，Tavily 原生工具不兼容")
        return 3
    print("\n✓ 响应格式兼容 Tavily 原生工具（dict['results'][i] 含 title/url/content/score）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **步骤 2：跑 spike**

```bash
cd backend && AI_CHAT_WEB_SEARCH_BASE_URL=https://search.believeboy.com AI_CHAT_WEB_SEARCH_API_KEY=123 ./.venv/bin/python scripts/spike_searxng_tavily_adapter.py
```

- [ ] **步骤 3：决策**

根据输出判定：
- **返回 0 + 兼容**：用 Pydantic AI 自带 `tavily_search_tool`，任务 4 直接走这条路径
- **返回 1-3 + 不兼容**：写自定义 tool 函数（任务 4 改路径）；同时把 spike 响应 body 贴到任务 4 实施时供 tool 函数解析参考

- [ ] **步骤 4：固化 spike 断言（防回归）**

把 spike 关键检查写成单测 `test_searxng_adapter_spike.py`：
- `AsyncTavilyClient(api_key="dummy", base_url=settings.ai_chat_web_search_base_url).search(query="test")` 必须返回 dict
- `result["results"]` 是 list
- 每个 result 含 `title / url / content` 三个字段（score 可选，因 SearXNG 可能无）

> ⚠️ 这是对**外网**依赖的测试；用环境变量 `SKIP_SEARXNG_SPIKE=1` 跳过（CI 环境用）。

- [ ] **步骤 5：Commit**

```bash
git add backend/scripts/spike_searxng_tavily_adapter.py backend/tests/services/test_searxng_adapter_spike.py
git commit -m "chore(ai): SearXNG Tavily adapter 格式 spike（决定 Phase 2 工具路径）"
```

> **若 spike 失败或不兼容**：commit 后**先停下来**调整任务 4 的方案，不要硬走 Tavily 原生工具。

---

### 任务 2：mapper tool_calls 分支

**承接任务 1 决策**。以下默认 spike 通过、走 Tavily 原生工具。

**文件：**
- 修改：`backend/app/services/ai/stream_mapper.py`
- 修改：`backend/tests/services/test_stream_mapper.py`

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai.messages import FunctionToolCallEvent, ToolCallPart


def _tool_call_event(name: str = "tavily_search", args: dict | None = None, call_id: str = "c1") -> FunctionToolCallEvent:
    return FunctionToolCallEvent(
        part=ToolCallPart(tool_name=name, args=args or {"query": "x"}, tool_call_id=call_id)
    )


def test_function_tool_call_yields_tool_calls_bytes():
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(), state)
    assert out is not None
    assert b'"type":"tool_calls"' in out
    assert b'"tool_name":"tavily_search"' in out
    assert state["last_tool_part"]["tool_name"] == "tavily_search"
    assert state["last_tool_part"]["args"] == {"query": "x"}


def test_function_tool_call_ignores_non_search_tools():
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(name="other_tool"), state)
    assert out is None
    assert "last_tool_part" not in state


def test_function_tool_call_sets_tool_searching_after():
    """tool_calls 后端点层会 yield tool_searching（mapper 只产 tool_calls，不产 tool_searching）。"""
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(), state)
    # mapper 一次性只产一个 bytes（tool_calls），tool_searching 由端点层紧接 yield
    assert out.count(b"\n") == 1
    assert b'"type":"tool_calls"' in out
```

- [ ] **步骤 2：跑测试，预期 FAIL**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py::test_function_tool_call_yields_tool_calls_bytes -v
# 预期：ImportError 或 AttributeError（FunctionToolCallEvent 未分支）
```

- [ ] **步骤 3：实现 tool_calls 分支**

在 `stream_mapper.py` 顶部 imports 加 `FunctionToolCallEvent, ToolCallPart`；`map_agent_event` 加分支：

```python
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    PartDeltaEvent,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPart,
)

from app.services.ai.stream_utils import (
    build_stream_chunk,
    build_stream_thinking_chunk,
    build_stream_tool_calls,
    build_stream_tool_done,
    build_stream_usage,
)


def _tool_part_to_dict(part: ToolCallPart) -> dict:
    return {
        "tool_name": part.tool_name,
        "args": part.args,
        "tool_call_id": getattr(part, "tool_call_id", None),
    }


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    # ... 既有 PartDeltaEvent / AgentRunResultEvent 分支 ...
    if isinstance(event, FunctionToolCallEvent):
        if event.part.tool_name in ("tavily_search", "web_search"):
            state["last_tool_part"] = _tool_part_to_dict(event.part)
            return build_stream_tool_calls([state["last_tool_part"]])
        return None
    return None
```

> 设计：mapper 每次只产一个 `bytes`；`tool_searching` 留在端点层（任务 6）紧接 `tool_calls` 之后手动 yield，不进 mapper。

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 加 FunctionToolCallEvent → tool_calls"
```

---

### 任务 3：mapper tool_result 分支（sources + tool_done）

**文件：** 同任务 2。

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai.messages import FunctionToolResultEvent, ToolReturnPart


def _tool_result_event(content) -> FunctionToolResultEvent:
    return FunctionToolResultEvent(
        tool_call_id="c1",
        part=ToolReturnPart(tool_name="tavily_search", content=content, tool_call_id="c1"),
    )


def test_tool_result_yields_sources_and_tool_done_bytes():
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": "day",
        "last_search_query": "今天北京天气",
    }
    content = [{"title": "北京天气预报", "url": "https://x.com", "content": "晴", "score": 0.9}]
    ev = _tool_result_event(content)
    out = map_agent_event(ev, state)
    assert out is not None
    # sources + tool_done 两条 ndjson 行合并为一个 bytes（mapper 在 Phase 2 一次性 yield 两行）
    assert out.count(b"\n") == 2
    assert b'"type":"sources"' in out
    assert b'"time_range":"day"' in out
    assert b'"query":"今天北京天气"' in out
    assert b'"type":"tool_done"' in out
    assert state["search_source_cards"][0]["title"] == "北京天气预报"
    assert state["search_source_cards"][0]["url"] == "https://x.com"


def test_tool_result_skips_when_last_tool_not_search():
    state: MapperState = {"last_tool_part": {"tool_name": "other_tool"}}
    ev = _tool_result_event([])
    assert map_agent_event(ev, state) is None
    assert "search_source_cards" not in state


def test_tool_result_handles_dict_content():
    """SearXNG adapter 可能返回 dict 而非 list[dict]（任务 1 spike 揭示）。"""
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": None,
        "last_search_query": None,
    }
    content = {"results": [{"title": "T", "url": "u", "content": "c", "score": 0.5}]}
    ev = _tool_result_event(content)
    out = map_agent_event(ev, state)
    assert out is not None
    assert b'"type":"sources"' in out
    assert state["search_source_cards"][0]["title"] == "T"
```

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：实现 tool_result 分支**

在 `stream_mapper.py` 加 `_handle_tool_result` 函数与分支：

```python
from app.services.ai.search import build_search_source_cards
from app.services.ai.stream_utils import build_stream_sources


def _normalize_tool_content(content: Any) -> list[dict]:
    """把 Tavily tool 返回的 content 标准化为 list[dict]。

    - Pydantic AI Tavily tool: list[TavilySearchResult]（每项含 title/url/content/score）
    - SearXNG adapter 自定义 tool: dict | list[dict]（视 spike 结果定）
    """
    if isinstance(content, dict):
        return content.get("results") or []
    if isinstance(content, list):
        return [dict(r) for r in content]
    return []


def _handle_tool_result(event: FunctionToolResultEvent, state: MapperState) -> bytes | None:
    last_tool = state.get("last_tool_part", {})
    if last_tool.get("tool_name") not in ("tavily_search", "web_search"):
        return None
    content = event.part.content if hasattr(event.part, "content") else event.part
    results = _normalize_tool_content(content)
    cards = build_search_source_cards({"results": results})
    state["search_source_cards"] = cards
    sources = build_stream_sources(
        cards,
        time_range=state.get("search_time_range"),
        query=state.get("last_search_query"),
    )
    return sources + build_stream_tool_done()


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    # ... 既有分支 ...
    if isinstance(event, FunctionToolCallEvent):
        # ... 既有实现 ...
    if isinstance(event, FunctionToolResultEvent):
        return _handle_tool_result(event, state)
    return None
```

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 加 FunctionToolResultEvent → sources+tool_done"
```

---

### 任务 4：Agent Factory 注册 tavily_search_tool

承接任务 1 决策：
- 若 spike 兼容 Tavily 原生：直接 `tavily_search_tool(client=AsyncTavilyClient(api_key="dummy", base_url=settings.ai_chat_web_search_base_url))`
- 若 spike 不兼容：写自定义 tool 函数（路径见任务 4 备选）

**文件：**
- 修改：`backend/app/services/ai/agent.py`
- 修改：`backend/tests/services/test_agent_factory.py`
- 修改：`backend/requirements.txt`

- [ ] **步骤 1：追加依赖**

```bash
# backend/requirements.txt 末尾追加
tavily-python
```

```bash
cd backend && ./.venv/bin/pip install tavily-python
```

- [ ] **步骤 2：写失败测试**

```python
# 加到 test_agent_factory.py
def test_build_chat_agent_without_web_search_has_no_tavily_tool():
    """默认 web_search=False → factory 不注册 tavily_search_tool。"""
    from pydantic_ai import Agent

    agent = build_chat_agent(_fake_settings(), web_search=False)
    assert isinstance(agent, Agent)
    tool_names = {t.name for t in agent.tools}
    assert "tavily_search" not in tool_names


def test_build_chat_agent_with_web_search_registers_tavily_tool():
    """web_search=True → factory 注册 tavily_search_tool。"""
    from pydantic_ai import Agent

    agent = build_chat_agent(_fake_settings(), web_search=True)
    assert isinstance(agent, Agent)
    tool_names = {t.name for t in agent.tools}
    assert "tavily_search" in tool_names
```

- [ ] **步骤 3：跑测试，预期 FAIL**

- [ ] **步骤 4：实现 agent.py 增量**

```python
# backend/app/services/ai/agent.py
from pydantic_ai.common_tools.tavily import tavily_search_tool
from tavily import AsyncTavilyClient


def build_chat_agent(
    settings: Settings,
    instructions: Optional[Iterable] = None,
    model_name: Optional[str] = None,
    web_search: bool = False,
) -> Agent:
    """构造 Pydantic AI Agent。

    Phase 2 增量：
    - `web_search=True` 时注册 `tavily_search_tool`，client 指向 SearXNG Tavily adapter。
    - 同步追加 web_search 行为指令（提示模型何时调用）。

    `instructions` 由调用方按需注入（prepend 在 base 之前；调用方控制优先级）。
    `model_name` 覆盖 settings 默认 model（来自 MessageCreate.payload.model）。
    """
    model = _build_model(settings, model_name=model_name)
    base_instructions: list = [
        "你是一个有用的 AI 助手，回答简洁准确。",
        current_date_instruction,
    ]
    extra_instructions: list = list(instructions) if instructions else []
    if web_search:
        extra_instructions.append(
            "当用户问题涉及实时信息（天气、新闻、价格、事件等）时，"
            "必须调用 tavily_search 工具获取最新数据，不要凭记忆回答。"
        )

    tools: list = []
    if web_search:
        client = AsyncTavilyClient(
            api_key=settings.ai_chat_web_search_api_key,
            base_url=settings.ai_chat_web_search_base_url,
        )
        tools.append(tavily_search_tool(client=client))

    return Agent(
        model=model,
        instructions=extra_instructions + base_instructions,
        capabilities=[Thinking()],
        tools=tools,
    )
```

- [ ] **步骤 5：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_agent_factory.py -v
```

- [ ] **步骤 6：Commit**

```bash
git add backend/app/services/ai/agent.py backend/tests/services/test_agent_factory.py backend/requirements.txt
git commit -m "feat(ai): Agent 工厂支持 web_search 注册 tavily_search_tool"
```

> **备选路径**：若任务 1 spike 不兼容 Tavily API，把 `tavily_search_tool(client=...)` 替换为写一个 `@agent.tool` 装饰的 async 函数，函数体直接 httpx POST 到 `settings.ai_chat_web_search_base_url` 并按 SearXNG adapter 实际响应解析。

---

### 任务 5：端点 `enable_web_search=True` 切到 Pydantic AI；删除 legacy 路径

**文件：**
- 修改：`backend/app/api/v1/endpoints/ai_chat.py`
- 修改：`backend/tests/api/test_ai_chat_stream_native.py`

- [ ] **步骤 1：写失败测试（web_search=True 路径 Pydantic AI）**

```python
# 加到 test_ai_chat_stream_native.py
def test_web_search_true_uses_pydantic_ai_native_tavily_tool(
    patched_build_chat_agent_with_web_search, client, db_session, api_key, monkeypatch
):
    """enable_web_search=True → Pydantic AI 路径 + Tavily tool 触发 tool_calls/sources/tool_done。"""
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, web_search=False, **_):
        # 强制 web_search=True 路径走 TestModel + 触发 tavily_search 工具调用
        return Agent(
            model=TestModel(call_tools=["tavily_search"], custom_output_text="已搜索。"),
            capabilities=[Thinking()],
            tools=[],
        )

    monkeypatch.setattr(
        "app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build
    )

    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天北京天气", "enable_web_search": True},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    types = _types_from_body(body)
    # 必须包含 tool_calls + sources + tool_done + chunk + done
    assert "start" in types
    assert "tool_calls" in types
    assert "sources" in types
    assert "tool_done" in types
    assert "chunk" in types
    assert "done" in types
```

> 需新加 fixture `patched_build_chat_agent_with_web_search`，或复用 `patched_build_chat_agent` 但让它支持 web_search 参数。

- [ ] **步骤 2：跑测试，预期 FAIL**（端点尚未切到 Pydantic AI web_search 路径）

- [ ] **步骤 3：删除 `_legacy_stream_response` 并改 `stream_message`**

在 `ai_chat.py`：

1. 删除 `_legacy_stream_response` 整个函数（约 250 行）
2. 删除 `_prepare_conversation_turn` 中的 attached_file 注入（已被 mapper 任务 3 替代；移到 agent 工厂的 instructions 注入路径更直接）
3. 简化 `stream_message`：

```python
@router.post("/conversations/{conversation_id}/messages/stream")
async def stream_message(
    request: Request,
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
):
    """SSE 流式对话端点（Phase 2：统一走 Pydantic AI driver）。

    路由矩阵：
    - enable_web_search=False / True 均走 Pydantic AI
    - regenerate=True + enable_web_search=False → HTTP 400（Phase 1 行为保留）
    - regenerate=True + enable_web_search=True  → Pydantic AI with tavily tool

    协议：ndjson（前端 consumeStream 零改动）。
    """
    from pydantic_ai.messages import FunctionToolCallEvent

    from app.services.ai.agent import build_chat_agent
    from app.services.ai.stream_mapper import MapperState, map_agent_event

    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)

    if payload.regenerate and not payload.enable_web_search:
        raise HTTPException(
            status_code=400,
            detail="重新生成仅在启用联网搜索时支持",
        )

    history = ai_chat_service.list_messages(db, conversation_id, user_id)
    user_content = payload.content.strip()
    regenerate = payload.regenerate

    prompt_messages, context_messages, user_row, assistant_row, target_assistant = (
        _prepare_conversation_turn(
            db=db,
            conversation_id=conversation_id,
            history=history,
            payload=payload,
            user_content=user_content,
            regenerate=regenerate,
        )
    )

    cancel_event = cancel_registry.register(conversation_id)

    agent = build_chat_agent(
        settings,
        model_name=payload.model,
        web_search=payload.enable_web_search,
    )
    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args(prompt_messages)

    state: MapperState = {
        "search_time_range": ai_chat_service.detect_time_range_from_query(user_content),
        "last_search_query": user_content if payload.enable_web_search else None,
    }

    async def event_stream():
        try:
            yield encode_stream_event({"type": "start"})
            async with agent.run_stream_events(
                user_prompt=user_prompt,
                message_history=message_history,
            ) as events:
                async for ev in events:
                    if cancel_event.is_set() or await request.is_disconnected():
                        cancel_event.set()
                        raise _CancelledError()
                    payload_bytes = map_agent_event(ev, state)
                    if payload_bytes is None:
                        continue
                    # tool_calls 后立即 yield tool_searching（与既有 ndjson 协议兼容）
                    if isinstance(ev, FunctionToolCallEvent):
                        if state.get("last_tool_part", {}).get("tool_name") in ("tavily_search", "web_search"):
                            yield encode_stream_event({"type": "tool_searching"})
                    for line in payload_bytes.split(b"\n"):
                        if line:
                            yield line + b"\n"

            # commit final state
            final_content = state.get("final_content") or ""
            ai_chat_service.update_message_content(db, assistant_row.id, final_content)
            if state.get("search_source_cards"):
                assistant_row.search_sources = json.dumps(
                    state["search_source_cards"], ensure_ascii=False
                )
            if state.get("search_time_range"):
                assistant_row.search_time_range = state["search_time_range"]
            usage = state.get("final_usage")
            ai_chat_service.mark_message_complete(
                db, assistant_row.id,
                prompt_tokens=(usage or {}).get("prompt_tokens", 0),
                completion_tokens=(usage or {}).get("completion_tokens", 0),
                total_tokens=(usage or {}).get("total_tokens", 0),
            )
            conversation.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(assistant_row)
            ai_chat_service.recalculate_conversation_token_stats(db, conversation_id)
            db.commit()
            yield build_stream_done(
                user_message=serialize_message(user_row) if not regenerate else serialize_message(target_assistant),
                assistant_message=serialize_message(assistant_row),
                conversation_title=conversation.title,
                token_usage=usage,
                conversation_token_usage={
                    "prompt_tokens": conversation.total_prompt_tokens,
                    "completion_tokens": conversation.total_completion_tokens,
                    "total_tokens": conversation.total_tokens,
                },
                duration_ms=None,
                title_regenerated=False,
            )
        except _CancelledError:
            db.rollback()
        except Exception as exc:
            db.rollback()
            yield build_stream_error(str(exc) or "发送失败")
        finally:
            cancel_registry.unregister(conversation_id, cancel_event)

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
```

4. 删除 `test_ai_chat_stream_native.py` 中 `test_legacy_path_preserved_when_enable_web_search_true`（legacy 已删，不再有 byte-for-byte 冻结；改用新测试覆盖 Pydantic AI + Tavily tool 路径）

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_native.py -v
```

- [ ] **步骤 5：跑 AI chat 全量测试，确认无回归**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py tests/services/test_agent_factory.py tests/services/test_ai_pydantic_ai_dependency.py tests/services/test_ai_chat_search_source_cards.py tests/api/test_ai_chat_stream_native.py -v
```

- [ ] **步骤 6：Commit**

```bash
git add backend/app/api/v1/endpoints/ai_chat.py backend/tests/api/test_ai_chat_stream_native.py
git commit -m "feat(ai): 端点统一走 Pydantic AI；删除 _legacy_stream_response"
```

---

### 任务 6：真 LLM 烟雾测试（agent 自动化 + Damon review）

**文件：**
- 创建：`backend/scripts/verify_ai_chat_phase2.py`（基于 `verify_ai_chat_phase1.py` 改名扩展）

- [ ] **步骤 1：扩展 verify 脚本**

复用 Phase 1 脚本结构，新增「web_search 路径」测试：
- 启动后端
- 建会话
- curl `enable_web_search=True` 流式请求（用 `model: "MiniMax-M3"`）
- 校验事件序列：`start → chunk × N → tool_calls → tool_searching → sources → tool_done → chunk × M → usage → done`
- 校验 `assistant_message.search_sources` 是非空 list
- 校验 `assistant_message.search_time_range` 是 day/week/month/year/all 之一

- [ ] **步骤 2：跑烟雾测试**

```bash
cd backend && DATABASE_URL=... FRONTEND_URL=... ./.venv/bin/python scripts/verify_ai_chat_phase2.py
```

预期：4/4 PASS（Pydantic AI / 400 路由 / legacy 已退役，改为 web_search 路径 / attached_file）。

- [ ] **步骤 3：把 ndjson 片段贴到本 plan「手测记录」段**

- [ ] **步骤 4：Commit**

```bash
git add backend/scripts/verify_ai_chat_phase2.py
git commit -m "test(ai): 自动化真 LLM 烟雾脚本扩展（覆盖 web_search 路径）"
```

---

### 任务 7：Merge 前最终检查与文档同步

**文件：**
- 修改：`docs/ai-chat-native-architecture.md`
- 修改：`docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`

- [ ] **步骤 1：架构文档 § 9.2 标 Phase 2 完成**

列出 Phase 2 新增模块 / 改动模块 / 行为变化 / 端点路由矩阵。

- [ ] **步骤 2：架构文档 § 10 追加 tavily-python 版本**

更新依赖列表：pydantic-ai 2.9.x + tavily-python x.y.z。

- [ ] **步骤 3：tracker 标 Phase 2 完成**

更新 `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`：
- 阶段状态总览：Phase 2 标 ✅
- Phase 2 任务详情：1-7 全标 ✅
- 已落 commits 追加 Phase 2 本轮 N 个

- [ ] **步骤 4：跑最终全量 AI chat 测试 + 前端测试**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py tests/services/test_agent_factory.py tests/services/test_ai_pydantic_ai_dependency.py tests/services/test_ai_chat_search_source_cards.py tests/api/test_ai_chat_stream_native.py -v
cd ../frontend && pnpm test
```

- [ ] **步骤 5：Commit**

```bash
git add docs/ai-chat-native-architecture.md docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md
git commit -m "docs(ai): Phase 2 完成同步（架构文档 + tracker）"
```

- [ ] **步骤 6：开 PR**

依据 AGENTS.md 的 commit 规范（中文 + Conventional Commits）整理 commit 列表，写 PR 描述（含迁移点、改动文件清单、风险点 = SearXNG 中文搜索质量仍是独立 ticket、spike 兼容性与否的影响）。

---

## 自检清单（实施前请逐项复核）

> 写计划时的内部 review 项；实施 PR 前请重新核验一遍（增删任务时尤其要回看）。

- [ ] 规格覆盖：原 plan § 9.3（Phase 2 任务清单）每一条都有对应任务（任务 1-7）。
- [ ] 占位符扫描：无「TODO」「待定」「补充细节」「placeholder」；每个 step 都有具体代码或命令。
- [ ] 类型一致性：`MapperState` 字段名（`assistant_parts / last_tool_part / search_source_cards / search_time_range / last_search_query / final_usage / final_content`）在任务 2-5 中定义与引用一致。
- [ ] 工具名称一致性：`tavily_search` 与 `web_search`（legacy 兼容）在 mapper 工厂与端点三处一致。
- [ ] `event.result.usage` 写为属性（非方法）。
- [ ] base_url 全程走 `settings.ai_chat_web_search_base_url`，无写死。
- [ ] `tavily-python` 必加 `requirements.txt`；pydantic-ai 同步依赖。
- [ ] 前端 `consumeStream` 与 ndjson 协议零改动（事件类型集合不变）。
- [ ] 删除 `_legacy_stream_response` 时不留 dangling references（grep `legacy_stream_response` 应零结果）。

---

## 手测记录（任务 6 完成后填）

> （由实施者在任务 6 完成后填入：web_search 路径实际 ndjson 片段；前端 pnpm test 结果；SearXNG 中文搜索质量观察）

---

## 决策日志（实施中追加）

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-13 | Phase 2 必须先做 SearXNG Tavily adapter spike | 决定 mapper `_handle_tool_result` content 解析路径，避免一开始猜测 |
| 2026-07-13 | Phase 2 仍保留 `regenerate + web_search=False → 400` 行为 | Tavily tool 行为对 regenerate 友好性未验证；先保守保留 Phase 1 行为 |

---

## 风险点

| 风险 | 影响 | 缓解 |
|---|---|---|
| SearXNG adapter 不严格兼容 Tavily API | 原生 `tavily_search_tool` 不可用；任务 4 走自定义 tool 备选路径 | 任务 1 spike 是必须前置；不通过则切备选 |
| Pydantic AI tool call 循环不收敛 | 流式响应卡住 / token 成本飙升 | Phase 2 暂不优化；独立 ticket 处理 max_turns / token budget |
| SearXNG 中文搜索质量差 | 用户体验下降 | 独立 ticket；Phase 2 不解决 |
| 流式响应中 `tool_searching` 事件位置与 Phase 1 legacy 略有差异（mapper vs 端点层） | 前端 UX 微差 | 前端 `consumeStream` 已支持；事件顺序在端点层与 mapper 之间严格 control |
| `tavily-python` 与 pydantic-ai 版本冲突 | 安装失败 | 任务 1 步骤 1 用 `pip install tavily-python` 单独验证；CI 阶段捕获 |

---

## 阶段间冻结（Phase 2 内不允许）

- 不引入 streaming tool calls
- 不动前端代码
- 不优化 tool 调用循环的 token 成本
- 不解决 SearXNG 中文搜索质量
- 不自动生成会话标题（Phase 1 推迟项保持）

---

## 相关文档

- 原 plan：`./2026-07-10-ai-chat-pydantic-ai-native.md`
- Phase 1：[`./2026-07-10-ai-chat-pydantic-ai-phase1.md`](./2026-07-10-ai-chat-pydantic-ai-phase1.md)
- 阶段跟踪：`./2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`
- 架构文档：`../../ai-chat-native-architecture.md`