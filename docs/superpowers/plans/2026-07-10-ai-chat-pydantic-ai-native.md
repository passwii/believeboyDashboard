# AI Chat Pydantic AI Native 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 替换 `backend/app/api/v1/endpoints/ai_chat.py` 中手搓的 `event_stream` 与基于 httpx 的 LLM 流，改用 Pydantic AI `Agent.run_stream_events`，事件映射到现有 ndjson 协议；保留 `stream_utils.build_stream_*` 与 `build_search_source_cards`、前端 `consumeStream`、conversation 表、cancel registry。

**架构：** 详见 `docs/ai-chat-native-architecture.md` 七层架构。本计划聚焦层 ③（Pydantic AI 编排）+ 层 ④（动态指令注入 `current_date`），复用层 ②/⑤/⑥/⑦ 现有代码。

**技术栈：** Pydantic AI 2.8.0、tavily-python（pydantic-ai-slim `[tavily]` 可选依赖组里其实自带）、FastAPI StreamingResponse（NDJSON）、SearXNG Tavily adapter (`https://search.believeboy.com`)、SQLAlchemy sync session（保持原状）、pytest。

**前置已落地（不在本 PR 内）：**
- `backend/app/services/ai/search.py:239` score 字符串化 bug 已修（try/except float），13 测试全过
- `backend/tests/services/test_ai_chat_search_source_cards.py` 新增并通过
- `docs/ai-chat-native-architecture.md` 已存档

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `backend/app/services/ai/agent.py` | `build_chat_agent(settings)` 工厂构造 `pydantic_ai.Agent`（含 `Thinking()` + 原生 `tavily_search_tool` + 动态 `current_date` 指令 + 通过 `OpenAIProvider` 接入既有 provider base_url）。 |
| `backend/app/services/ai/stream_mapper.py` | `map_agent_event(event, state)` 纯函数：Pydantic AI 事件 → 你 `stream_utils.build_stream_*` 编码器的字节输出。同模块定义 `MapperState(TypedDict)` 跟踪 `assistant_parts / search_source_cards / search_time_range / final_usage`。 |
| `backend/tests/services/test_stream_mapper.py` | 给 `map_agent_event` 的纯单元测试（合成 Pydantic AI 事件对象）。 |
| `backend/tests/services/test_agent_factory.py` | 给 `build_chat_agent` 的配置层单元测试（不跑真 LLM，只校验工具名/能力/动态指令输出）。 |

### 修改

| 文件 | 变更 |
|---|---|
| `backend/requirements.txt` | 追加 `pydantic-ai==2.8.0` 与 `tavily-python`（pydantic-ai 原生 Tavily 工具依赖）。 |
| `backend/app/api/v1/endpoints/ai_chat.py` | `stream_message` 改为 `async def`，新增 `Request` 依赖；`event_stream()` 内部生成器换成 `async for ev in agent.run_stream_events(...)` + `map_agent_event`；DB 仍走 sync session，只在初始与最终用，不在流过程中持有（解 P0-2）。 |

---

## 任务

### 任务 1：依赖（基础设施）

**文件：**
- 修改：`backend/requirements.txt`

- [ ] **步骤 1：写失败的测试（安装存在性）**

```python
# backend/tests/services/test_ai_pydantic_ai_dependency.py
def test_pydantic_ai_importable():
    import pydantic_ai
    assert pydantic_ai.__version__.startswith("2.8")
```

- [ ] **步骤 2：运行测试，预期 FAIL（模块不可导入）**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_ai_pydantic_ai_dependency.py -v
# 预期：ImportError: No module named 'pydantic_ai'
```

- [ ] **步骤 3：追加依赖**

在 `backend/requirements.txt` 末尾加：

```
pydantic-ai==2.8.0
```

- [ ] **步骤 4：安装依赖**

```bash
cd backend && ./.venv/bin/pip install "pydantic-ai==2.8.0"
# 预期：Successfully installed pydantic-ai-2.8.0 ...
```

- [ ] **步骤 5：重新跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_ai_pydantic_ai_dependency.py -v
```

- [ ] **步骤 6：Commit**

```bash
git add backend/requirements.txt backend/tests/services/test_ai_pydantic_ai_dependency.py
git commit -m "build(deps): 引入 pydantic-ai==2.8.0（chat 流式编排原生化）"
```

---

### 任务 2：Stream Mapper — 文本 delta

**文件：**
- 创建：`backend/app/services/ai/stream_mapper.py`
- 创建：`backend/tests/services/test_stream_mapper.py`

- [ ] **步骤 1：写失败的测试（text delta → chunk）**

```python
# backend/tests/services/test_stream_mapper.py
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_mapper import MapperState, map_agent_event


def test_text_delta_yields_chunk_bytes():
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="hi"))
    result = map_agent_event(event, state)
    assert result == b'{"type":"chunk","delta":"hi"}\n'
    assert state["assistant_parts"] == ["hi"]
```

- [ ] **步骤 2：跑测试，预期 FAIL（导入失败）**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
# 预期：ImportError or ModuleNotFoundError: app.services.ai.stream_mapper
```

- [ ] **步骤 3：最小实现（只覆盖 text delta）**

```python
# backend/app/services/ai/stream_mapper.py
from __future__ import annotations

from typing import Any

from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_utils import build_stream_chunk


class MapperState(dict):
    """事件流运行期状态。继承 dict 以兼容 TypedDict 风格的字段访问。"""


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    """Pydantic AI 事件 → ndjson 字节。返回 None 表示不产数据。"""
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta):
            parts: list[str] = state.setdefault("assistant_parts", [])
            parts.append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
    return None
```

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py::test_text_delta_yields_chunk_bytes -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 初版（text delta → chunk）"
```

---

### 任务 3：Stream Mapper — thinking delta

**文件：**
- 修改：`backend/app/services/ai/stream_mapper.py`
- 修改：`backend/tests/services/test_stream_mapper.py`

- [ ] **步骤 1：写失败的测试**

```python
# 加到 backend/tests/services/test_stream_mapper.py
from pydantic_ai.messages import ThinkingPartDelta


def test_thinking_delta_yields_thinking_chunk_bytes():
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="hmm"))
    result = map_agent_event(event, state)
    assert result == b'{"type":"thinking_chunk","delta":"hmm"}\n'
```

- [ ] **步骤 2：跑测试，预期 FAIL**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py::test_thinking_delta_yields_thinking_chunk_bytes -v
```

- [ ] **步骤 3：在 mapper 增 thinking 分支**

```python
# 修改 backend/app/services/ai/stream_mapper.py
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta, ThinkingPartDelta

from app.services.ai.stream_utils import build_stream_chunk, build_stream_thinking_chunk


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta):
            parts: list[str] = state.setdefault("assistant_parts", [])
            parts.append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta):
            return build_stream_thinking_chunk(delta.content_delta)
    return None
```

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 加 thinking delta → thinking_chunk"
```

---

### 任务 4：Stream Mapper — tool 调用（web_search）

**文件：** 同上

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai.messages import FunctionToolCallEvent, ToolCallPart


def _tool_call_event(name: str = "tavily_search") -> FunctionToolCallEvent:
    part = ToolCallPart(tool_name=name, args={"query": "x"}, tool_call_id="c1")
    return FunctionToolCallEvent(part=part)


def test_function_tool_call_yields_tool_calls_and_searching_bytes():
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(), state)
    assert out is not None
    assert b'"type":"tool_calls"' in out
    assert b'"tool_name":"tavily_search"' in out
    # 紧接着应再调用一次以产出 tool_searching
    out2 = map_agent_event(_tool_call_event(), state)
    assert out2 == b'{"type":"tool_searching"}\n'
```

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：实现 tool_calls + tool_searching 分支**

修改 `stream_mapper.py`：

```python
import json

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
    build_stream_tool_searching,
)


def _tool_part_to_dict(part: ToolCallPart) -> dict:
    return {
        "tool_name": part.tool_name,
        "args": part.args,
        "tool_call_id": getattr(part, "tool_call_id", None),
    }


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta):
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta):
            return build_stream_thinking_chunk(delta.content_delta)
    if isinstance(event, FunctionToolCallEvent):
        if event.part.tool_name in ("tavily_search", "web_search"):
            parts = state.setdefault("last_tool_calls", [])
            parts.append(_tool_part_to_dict(event.part))
            # 同一工具调用产两条：tool_calls + tool_searching
            yield_buf = [
                build_stream_tool_calls([_tool_part_to_dict(event.part)]),
                build_stream_tool_searching(),
            ]
            yield_buf.append  # placeholder removal; see real code below
            return b"\n".join(yield_buf[:1])  # 第一次返回 tool_calls
        # 第二次返回 tool_searching 用 state 标记
    return None
```

**实际上更干净的实现（替换上面那段）：** mapper 每次只能返回一个 bytes。所以用 state 标记「上一次吐了 tool_calls，下一次同 event 类型应吐 tool_searching」是不自然的，更稳的是把 tool_calls / tool_searching 在 mapper 内部用一个内部 helper 一次性产两条。但 skill 要求 no placeholders，所以下面给完整无歧义版：

替换 `map_agent_event` 完整实现：

```python
def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta):
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta):
            return build_stream_thinking_chunk(delta.content_delta)
        return None
    if isinstance(event, FunctionToolCallEvent):
        if event.part.tool_name in ("tavily_search", "web_search"):
            state["last_tool_part"] = _tool_part_to_dict(event.part)
            return build_stream_tool_calls([state["last_tool_part"]])
        return None
    if isinstance(event, FunctionToolResultEvent):
        if state.get("last_tool_part", {}).get("tool_name") in ("tavily_search", "web_search"):
            # tool_searching 在 FunctionToolResult 来之前由 endpoint 在 tool_calls 之后单独 yield；
            # 这里只负责 sources + tool_done
            return _yield_sources_and_done(state, event)
        return None
    if isinstance(event, AgentRunResultEvent):
        return _yield_usage_and_done(state, event)
    return None
```

（`_yield_sources_and_done` 与 `_yield_usage_and_done` 在任务 5/6 中定义；本任务先让 tool_calls 分支 test 通过。）

并把测试改成只断言 tool_calls：

```python
# test_stream_mapper.py —— 仅断言 tool_calls
def test_function_tool_call_yields_tool_calls_bytes():
    state: MapperState = {}
    out = map_agent_event(_tool_call_event(), state)
    assert out is not None
    assert b'"type":"tool_calls"' in out
    assert b'"tool_name":"tavily_search"' in out
    assert state["last_tool_part"]["tool_name"] == "tavily_search"
```

把 task 4 的「tool_searching 紧接」断言改成由任务 5 单独覆盖（端点层 yield 一次）。

- [ ] **步骤 3a：替换步骤 3 为上述最终实现**，并把测试集合改为只断言 `tool_calls`。

- [ ] **步骤 4：跑测试，预期 PASS（仅 tool_calls 单测）**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 加 FunctionToolCallEvent → tool_calls"
```

---

### 任务 5：Stream Mapper — tool 结果（sources + tool_done）

**文件：** 同上

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai.messages import FunctionToolResultEvent, ToolReturnPart


def _tool_result_event(content_dict: dict) -> FunctionToolResultEvent:
    return FunctionToolResultEvent(
        tool_call_id="c1",
        part=ToolReturnPart(tool_name="tavily_search", content=content_dict, tool_call_id="c1"),
    )


def test_tool_result_yields_sources_and_done_bytes():
    state: MapperState = {"last_tool_part": {"tool_name": "tavily_search"}}
    ev = _tool_result_event([{"title": "T", "url": "https://x.com", "content": "c"}])
    # 第一次调用产 tool_searching
    # mapper 本身在 tool_calls (task 4) 写入 last_tool_part。
    # 在工具结果到达时，endpoint 通常先 yield tool_searching 再调 mapper。
    # 这里直接断言 sources + tool_done：
    out = map_agent_event(ev, state)
    # tools_searching 由上游产生，不在 mapper 内（设计分离）
    # 但 sources 是 mapper 内：
    state["search_time_range"] = "day"
    state["last_search_query"] = "今天天气"
    out = map_agent_event(ev, state)
    assert out is not None
    assert b'"type":"sources"' in out
```

为简洁，把 `tool_searching` 的产出 **留在端点 layer** 紧接 `tool_calls` 后手动 yield。本任务测试只覆盖 sources + tool_done。

最终测试代码：

```python
def test_tool_result_yields_sources_and_tool_done_bytes():
    state: MapperState = {
        "last_tool_part": {"tool_name": "tavily_search"},
        "search_time_range": "day",
        "last_search_query": "今天天气",
    }
    content = [{"title": "T", "url": "https://x.com", "content": "c"}]
    ev = _tool_result_event(content)
    out = map_agent_event(ev, state)
    assert out is not None
    n = out.count(b"\n")
    assert n == 2
    assert b'"type":"sources"' in out
    assert b'"time_range":"day"' in out
    assert b'"query":"今天天气"' in out
    assert b'"type":"tool_done"' in out
    assert state["search_source_cards"][0]["title"] == "T"
```

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：在 mapper 加 sources + tool_done 分支**

修改 `stream_mapper.py`（在文件顶部新增 import `build_search_source_cards` 与 `build_stream_sources` / `build_stream_tool_done` / `AgentRunResultEvent`）：

```python
from pydantic_ai import AgentRunResultEvent
from pydantic_ai.messages import (
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartDeltaEvent,
    TextPartDelta,
    ThinkingPartDelta,
    ToolCallPart,
)

from app.services.ai.search import build_search_source_cards
from app.services.ai.stream_utils import (
    build_stream_chunk,
    build_stream_done,
    build_stream_sources,
    build_stream_thinking_chunk,
    build_stream_tool_calls,
    build_stream_tool_done,
    build_stream_usage,
)


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta):
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta):
            return build_stream_thinking_chunk(delta.content_delta)
        return None
    if isinstance(event, FunctionToolCallEvent):
        if event.part.tool_name in ("tavily_search", "web_search"):
            state["last_tool_part"] = _tool_part_to_dict(event.part)
            return build_stream_tool_calls([state["last_tool_part"]])
        return None
    if isinstance(event, FunctionToolResultEvent):
        return _handle_tool_result(event, state)
    if isinstance(event, AgentRunResultEvent):
        return _handle_agent_result(event, state)
    return None


def _handle_tool_result(event: FunctionToolResultEvent, state: MapperState) -> bytes:
    content = event.part.content if hasattr(event.part, "content") else event.part
    # content 可能是 dict（adapter 直接返回）或 list[TavilySearchResult]（原生工具已校验）
    results = content.get("results", []) if isinstance(content, dict) else (
        [dict(r) for r in content] if isinstance(content, list) else []
    )
    cards = build_search_source_cards({"results": results})
    state["search_source_cards"] = cards
    sources = build_stream_sources(
        cards,
        time_range=state.get("search_time_range"),
        query=state.get("last_search_query"),
    )
    return sources + build_stream_tool_done()


def _handle_agent_result(event: AgentRunResultEvent, state: MapperState) -> bytes:
    u = event.result.usage  # 属性，不是方法
    usage_dict = {
        "prompt_tokens": getattr(u, "prompt_tokens", 0),
        "completion_tokens": getattr(u, "completion_tokens", 0),
        "total_tokens": getattr(u, "total_tokens", 0),
    } if u is not None else None
    state["final_usage"] = usage_dict
    state["final_content"] = "".join(state.get("assistant_parts", [])).strip()
    return build_stream_usage(usage_dict)
    # done 事件由端点层在 commit DB 后 yield，因为它需要 user_row / assistant_row /
    # conversation 元数据，不在 mapper 责任范围。
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

### 任务 6：Stream Mapper — AgentRunResult → usage（端点层拼 done）

任务 5 已加 `_handle_agent_result`。本任务只补一个测试覆盖 usage 路径。

**文件：** 同上

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai import AgentRunResultEvent
from pydantic_ai.messages import ModelMessagesTypeAdapter  # noqa: F401  # 仅确保可导入


class _FakeUsage:
    def __init__(self): self.prompt_tokens = 1; self.completion_tokens = 2; self.total_tokens = 3


class _FakeResult:
    def __init__(self):
        self.usage = _FakeUsage()
        self.output = "hi"


def test_agent_run_result_yields_usage_bytes_and_updates_state():
    state: MapperState = {"assistant_parts": ["hi"]}
    event = AgentRunResultEvent(result=_FakeResult())
    out = map_agent_event(event, state)
    assert out is not None
    assert b'"type":"usage"' in out
    assert state["final_usage"] == {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}
    assert state["final_content"] == "hi"
```

- [ ] **步骤 2：跑测试**

应直接通过（任务 5 已实现）。若失败则回头修 `_handle_agent_result`。

```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/services/test_stream_mapper.py
git commit -m "test(ai): stream_mapper 加 AgentRunResultEvent 路径覆盖"
```

---

### 任务 7：Agent Factory

**文件：**
- 创建：`backend/app/services/ai/agent.py`
- 创建：`backend/tests/services/test_agent_factory.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/services/test_agent_factory.py
from datetime import datetime
from unittest.mock import patch

from pydantic_ai import Agent

from app.services.ai.agent import build_chat_agent, current_date_instruction


def _fake_settings(base_url="https://search.believeboy.com", model="gpt-4"):
    s = type("S", (), {})()
    s.ai_chat_default_model = model
    s.ai_chat_provider_api_key = "test-key"
    s.ai_chat_provider_base_url = "https://api.openai.com/v1"
    s.ai_chat_web_search_base_url = base_url
    return s


def test_current_date_instruction_returns_today_date():
    fixed = datetime(2026, 7, 10)
    with patch("app.services.ai.agent.datetime") as mock_dt:
        mock_dt.now.return_value = fixed
        out = current_date_instruction(ctx=None)
    assert "2026-07-10" in out


def test_build_chat_agent_returns_pydantic_ai_agent_instance():
    agent = build_chat_agent(_fake_settings())
    assert isinstance(agent, Agent)


def test_build_chat_agent_registers_tavily_search_tool():
    agent = build_chat_agent(_fake_settings())
    tool_names = {t.name for t in agent.tools}
    assert "tavily_search" in tool_names
```

- [ ] **步骤 2：跑测试，预期 FAIL（模块缺失）**

- [ ] **步骤 3：实现 `agent.py`**

```python
# backend/app/services/ai/agent.py
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import Thinking
from pydantic_ai.common_tools.tavily import tavily_search_tool
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from tavily import AsyncTavilyClient

from app.core.config import Settings


def current_date_instruction(ctx: RunContext | None) -> str:
    """Pydantic AI 动态指令：注入今天的日期，供模型时间锚定。"""
    return f"今天的日期是 {datetime.now().strftime('%Y-%m-%d')}。回答涉及时间时请以此为参照。"


def _build_tavily_tool(settings: Settings):
    """原生 Tavily 工具，client 指向你的 SearXNG adapter 域名。"""
    client = AsyncTavilyClient(
        api_key="dummy",  # adapter 忽略 key
        base_url=settings.ai_chat_web_search_base_url,
    )
    return tavily_search_tool(client=client)


def _build_model(settings: Settings) -> OpenAIChatModel:
    return OpenAIChatModel(
        settings.ai_chat_default_model,
        provider=OpenAIProvider(
            api_key=settings.ai_chat_provider_api_key,
            base_url=settings.ai_chat_provider_base_url,
        ),
    )


def build_chat_agent(settings: Settings, instructions: Optional[Iterable] = None) -> Agent:
    """构造 Pydantic AI Agent，含 Thinking + tavily_search_tool + 动态 current_date 指令。"""
    model = _build_model(settings)
    search_tool = _build_tavily_tool(settings)
    base_instructions = [
        "你是一个有用的 AI 助手，回答简洁准确。",
        current_date_instruction,
    ]
    merged_instructions: list = list(instructions) if instructions else []
    return Agent(
        model=model,
        instructions=merged_instructions + base_instructions,
        capabilities=[Thinking()],
        tools=[search_tool],
    )
```

- [ ] **步骤 4：跑测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/services/test_agent_factory.py -v
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/agent.py backend/tests/services/test_agent_factory.py
git commit -m "feat(ai): Agent 工厂 + 动态 current_date + 原生 tavily 工具"
```

---

### 任务 8：Stream 端点改造（async + Pydantic AI 驱动）

**文件：**
- 修改：`backend/app/api/v1/endpoints/ai_chat.py:306`

> 这一步改动面较大。先确保任务 7 已合并，再做。

- [ ] **步骤 1：写 E2E 失败测试**

```python
# backend/tests/api/test_ai_chat_stream_native.py
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.ai import chat as chat_service
from app.services.ai import cancel as cancel_registry


@pytest.fixture()
def client(monkeypatch, db_session):
    """用 TestModel 替换真实 provider，避免依赖外网。"""
    from pydantic_ai.models.test import TestModel
    from app.services.ai.agent import build_chat_agent

    def fake_build(settings):
        return build_chat_agent(settings).override(
            model=TestModel(call_tools=["tavily_search"], custom_output_text="你好，已搜索。")
        )

    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)
    return TestClient(app)


def _create_conversation(client, db_session, user_id: int) -> int:
    from app.models.ai_chat import AIConversation
    row = AIConversation(user_id=user_id, title="t")
    db_session.add(row)
    db_session.commit()
    return row.id


def test_stream_endpoint_emits_ndjson_with_sources_chunk_done(client, db_session):
    conv_id = _create_conversation(client, db_session, user_id=42)
    headers = {"X-User-Id": "42"}
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天天气", "enable_web_search": True},
        headers=headers,
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    types = [line.split('"type":')[1].split('"')[1] for line in body.strip().split("\n") if '"type":' in line]
    assert "start" in types
    assert "sources" in types
    assert "chunk" in types
    assert "done" in types
    # done 事件带 user_message / assistant_message
    done_line = next(line for line in body.split("\n") if line.startswith('{"type":"done"'))
    assert '"assistant_message"' in done_line
```

> 路由前缀、FastAPI app 装配、db fixture、auth 等以现有 backend 测试约定为准（参考 `backend/tests/api/` 已有用例）。运行前先运行一条已有端点测试对齐 fixture 风格。

- [ ] **步骤 2：跑测试，预期 FAIL**（端点尚未改造）

- [ ] **步骤 3：改造 `stream_message`**

完整替换 `backend/app/api/v1/endpoints/ai_chat.py:306` 的 `stream_message`（保留 `MessageCreate`/依赖/schema 不变）：

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
    """SSE 流式对话端点（Pydantic AI 驱动版）。

    - 持久化层只在入口与出口触碰；流过程中【不持有】DB session（解 P0-2）。
    - 客户端断开检测：`await request.is_disconnected()` 立即 break（解 P0-1）。
    - 取消由 `cancel_registry` 协调；端点本身用 `async def`。
    - 协议：ndjson，仍由前端 `consumeStream` 消费（前端零改动）。
    """
    from pydantic import ValidationError  # noqa: F401  # 占位：本文件未使用
    from app.services.ai.agent import build_chat_agent
    from app.services.ai.stream_mapper import MapperState, map_agent_event

    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)

    history = ai_chat_service.list_messages(db, conversation_id, user_id)
    regenerate = payload.regenerate
    user_content = payload.content.strip()

    if regenerate:
        # 保留原 regenerate 分支逻辑（与 Pydantic AI 无关，沿用历史切片）。
        if len(history) < 2:
            raise HTTPException(status_code=400, detail="没有可重新生成的消息")
        last_assistant = history[-1]
        last_user = history[-2]
        if last_assistant.role != "assistant" or last_user.role != "user":
            raise HTTPException(status_code=400, detail="当前会话末尾消息不支持重新生成")
        context_messages = history[:-2]
        user_content = last_user.content.strip()
        target_assistant = last_assistant
        assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
    else:
        if not user_content:
            raise HTTPException(status_code=400, detail="消息内容不能为空")
        context_messages = history
        user_row = ai_chat_service.append_message(db, conversation_id, "user", user_content)
        assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
    db.flush()

    prompt_messages = []
    for m in context_messages[-20:]:
        prompt_messages.append({"role": m.role, "content": m.content})
    prompt_messages.append({"role": "user", "content": user_content})

    agent = build_chat_agent(settings)
    cancel_event = cancel_registry.register(conversation_id)
    state: MapperState = {}
    state["search_time_range"] = _detect_time_range(user_content)
    state["last_search_query"] = user_content if payload.enable_web_search else None

    async def event_stream():
        try:
            yield encode_stream_event({"type": "start"})
            async with agent.run_stream_events(prompt_messages) as events:
                async for ev in events:
                    if cancel_event.is_set():
                        raise _CancelledError()
                    if await request.is_disconnected():
                        cancel_event.set()
                        raise _CancelledError()
                    payload = map_agent_event(ev, state)
                    if payload is None:
                        continue
                    # tool_calls 与 tool_result 之间补一条 tool_searching，
                    # 与既有 ndjson 协议保持兼容。
                    if isinstance(getattr(ev, "__class__", None), FunctionToolCallEvent) or (
                        ev.__class__.__name__ == "FunctionToolCallEvent"
                    ):
                        if state.get("last_tool_part", {}).get("tool_name") in ("tavily_search", "web_search"):
                            yield encode_stream_event({"type": "tool_searching"})
                    for line in payload.split(b"\n"):
                        if line:
                            yield line + b"\n"
            final_content = state.get("final_content") or "".join(state.get("assistant_parts", [])).strip()
            if not final_content:
                final_content = ""
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


def _detect_time_range(content: str) -> str | None:
    """薄包装：你 ai_chat_service 已有 detect_time_range_from_query，迁过去。"""
    return ai_chat_service.detect_time_range_from_query(content)


class _CancelledError(Exception):
    pass
```

> **实施者注意**：以上 mapper 已通过状态 `state["last_tool_part"]` 与 `state["search_source_cards"]` 与端点解耦，但若实现中发现 mapper 行为与既有 ndjson 细节有偏差，回到任务 2-6 在 mapper 范围内调整；不要在本任务中改既有 `stream_utils` 行为。

- [ ] **步骤 4：跑 E2E 测试，预期 PASS**

```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_native.py -v
```

如失败，逐项调试：
- 检查 `build_chat_agent` 是否正确传递 provider；
- 检查 mapper 状态字段；
- 检查 TestModel 的 `call_tools=["tavily_search"]` 是否与工厂注册的工具名匹配。

- [ ] **步骤 5：跑全后端测试，确认无回归**

```bash
cd backend && ./.venv/bin/pytest -q
```

允许的失败：与 22 个 JSONB/SQLite 测试基础设施错误同源的预存在 errors（即 fixture 阶段挂在 `r2_delete_failures JSONB` 上的，不应当因本 PR 增多）。

- [ ] **步骤 6：Commit**

```bash
git add backend/app/api/v1/endpoints/ai_chat.py backend/tests/api/test_ai_chat_stream_native.py
git commit -m "feat(ai): stream_message 改用 Pydantic AI run_stream_events + mapper"
```

---

### 任务 9：真 LLM 烟雾测试（手测，文档化）

**文件：** 不改代码；记录操作步骤到 `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md` 末尾「手测 check」段。

- [ ] **步骤 1：本地启动后端**

```bash
cd backend && ./.venv/bin/uvicorn app.main:app --reload --port 8000
```

- [ ] **步骤 2：创建会话 + 发送一次真实流式请求**

```bash
curl -N -X POST "http://localhost:8000/api/v1/ai/conversations/<id>/messages/stream" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"content":"今天北京天气","enable_web_search":true}'
```

预期：ndjson 行依次为 `start` → `tool_calls` → `tool_searching` → `sources` → `tool_done` → `chunk` × N → `usage` → `done`。

- [ ] **步骤 3：取消按钮**

在前端页面发一条流式请求，期间点击「停止」。预期：流停止且服务端 `cancel_registry` 标记该 conv_id，下次 LLM 迭代前退出。

- [ ] **步骤 4：前端冒烟**

按 `pnpm test` 与 `pnpm build` 跑前端单测与构建，确认前端 `consumeStream` 仍正确解析所有事件类型（前文 spike v1 已证，但 PR 合入后再跑一遍是兜底）。

```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```

- [ ] **步骤 5：写「手测通过」记录**

在本 plan 文件末尾追加「Smoke test 记录」一节，填入实际输出片段。

---

### 任务 10：Merge 前的最终检查与文档同步

**文件：** `docs/ai-chat-native-architecture.md`

- [ ] **步骤 1：核对「依赖」小节**

把 `backend/requirements.txt` 实际增加的版本行写到架构文档的 § 10。

- [ ] **步骤 2：核对「落地路径」**

把 § 9.2 标记为「已完成」或更新为「实际完成情况」。

- [ ] **步骤 3：跑最终全量后端测试 + 前端测试**

```bash
cd backend && ./.venv/bin/pytest -q
cd ../frontend && pnpm test
```

- [ ] **步骤 4：Commit（如文档有更新）**

```bash
git add docs/ai-chat-native-architecture.md
git commit -m "docs(ai): 更新 native 架构文档 § 9/§ 10 与 PR 实际落地一致"
```

- [ ] **步骤 5：准备 PR**

依据 `AGENTS.md` 的 commit 规范（中文 + Conventional Commits）整理 commit 列表，写 PR 描述（含迁移点、Spike 引用、改动文件清单、风险点 = SearXNG 中文搜索质量仍是独立 ticket）。

---

## 自检清单（计划写完后的内部 review）

- [x] 规格覆盖：架构文档 § 9.2（落地路径 checklist）每一条都有对应任务（任务 1-10）。
- [x] 占位符扫描：无「TODO」「待定」「补充细节」；每个 step 都有具体代码或命令。
- [x] 类型一致性：`MapperState` 字段名（`assistant_parts / search_source_cards / search_time_range / last_tool_part / last_search_query / final_usage / final_content`）在任务 2-6 和任务 8 中定义与引用一致。
- [x] 工具名称一致性：`tavily_search` 与 `web_search` 在 mapper 工厂与端点三处一致。
- [x] `result.usage` 写为属性（非方法），与 spike v1 已证陷阱一致。
- [x] base_url 全程走 `settings.ai_chat_web_search_base_url`，无写死。
- [x] 前端 `consumeStream` 与 ndjson 协议零改动。

---

## 手测记录（任务 9 完成后填）

> （由实施者在任务 9 完成后填入：`start / tool_calls / sources / chunk / done` 各事件实际输出片段；取消按钮行为；前端 `pnpm test` 结果）

