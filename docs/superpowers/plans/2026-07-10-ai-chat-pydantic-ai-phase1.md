# AI Chat Pydantic AI Native 实施 · Phase 1

> **面向 AI 代理的工作者：** 必需子技能：superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
> 步骤使用复选框（`- [ ]`）语法跟踪进度。

**承接文档：** `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-native.md`（原 10 任务完整路线图）。
**跨阶段跟踪：** `docs/superpowers/plans/2026-07-10-ai-chat-pydantic-ai-phase-tracker.md`（Phase 1 + Phase 2 进度索引）。
**本计划聚焦：** 原任务 T1 / T2 / T3 / T6 / T7（裁剪）/ T8（裁剪）/ T9 / T10。

---

## Phase 边界

| 原任务 | 状态 | 说明 |
|---|---|---|
| T1 依赖（pydantic-ai） | ✅ Phase 1 | 不引 tavily-python |
| T2 text delta mapper | ✅ Phase 1 | — |
| T3 thinking delta mapper | ✅ Phase 1 | — |
| T4 tool_calls mapper | ⏸ Phase 2 | 跟着 web_search 走 |
| T5 sources/tool_done mapper | ⏸ Phase 2 | 同上 |
| T6 usage mapper | ✅ Phase 1 | — |
| T7 Agent factory | ✅ Phase 1（裁剪） | 仅注册 `Thinking()` capability，**不**注册 Tavily tool |
| T8 端点 async 重写 | ✅ Phase 1（裁剪） | `enable_web_search=False` 走 Pydantic AI；`enable_web_search=True` 走旧同步路径兜底 |
| T9 烟雾测试 | ✅ Phase 1 | 仅 `enable_web_search=False` |
| T10 文档同步 | ✅ Phase 1 | — |

---

## Phase 1 目标 & 非目标

**目标：**
- 解 P0-1（客户端断连检测）：async `request.is_disconnected()`
- 解 P0-2（DB session 持有期）：流过程中不持有 DB session
- 引入 Pydantic AI 2.8 编排 LLM 流，替代手搓 httpx 循环
- 保留前端 `consumeStream` 与 ndjson 协议零改动
- `enable_web_search=False` 用户体验完全不变
- `enable_web_search=True` 用户路径行为完全冻结（用 e2e 测试固化）

**非目标：**
- 不动 web_search 用户路径（行为、UX、性能指标全部冻结）
- 不引入 Pydantic AI native Tavily tool（T7 工厂不注册）
- 不动 mapper 的 tool_calls / tool_result / sources 分支
- 不动 `stream_utils.build_stream_*` / `build_search_source_cards` / `chat_service.*` / `cancel.py` / `search.py` / `tools.py` / `llm.py`
- Phase 1 新路径不自动生成会话标题（与现状不一致的场景由 Phase 2 处理）

**端点路由行为矩阵：**

| `enable_web_search` | `regenerate` | 路径 |
|---|---|---|
| `False` | `False` | ✅ 新 Pydantic AI 路径 |
| `False` | `True` | ❌ `HTTP 400 重新生成仅在启用联网搜索时支持` |
| `True` | `True` / `False` | ✅ 旧同步路径（行为冻结） |

---

## 文件改动清单

### 新建

| 文件 | 职责 |
|---|---|
| `backend/app/services/ai/agent.py` | `build_chat_agent(settings)` 工厂：`OpenAIChatModel` + `OpenAIProvider`（指向既有 `ai_chat_provider_base_url`）+ `Thinking()` capability + 动态 `current_date` 指令。**不**注册 tools。 |
| `backend/app/services/ai/stream_mapper.py` | `map_agent_event(event, state)` 纯函数，仅覆盖 `PartDeltaEvent`（text + thinking）与 `AgentRunResultEvent`（usage）两类分支。`MapperState` 跟踪 `assistant_parts / final_usage / final_content`。 |
| `backend/tests/services/test_ai_pydantic_ai_dependency.py` | 依赖存在性单测（任务 1 已落地） |
| `backend/tests/services/test_stream_mapper.py` | mapper 单测（text / thinking / usage 三分支） |
| `backend/tests/services/test_agent_factory.py` | factory 配置层单测（用 `pydantic_ai.models.test.TestModel` 替换真实 provider） |
| `backend/tests/api/test_ai_chat_stream_native.py` | 端点 e2e：Pydantic AI 路径顺序 + 旧路径 byte-for-byte 冻结对比 |

### 修改

| 文件 | 变更 |
|---|---|
| `backend/requirements.txt` | 追加 `pydantic-ai==2.8.0`（**不**加 tavily-python） |
| `backend/app/api/v1/endpoints/ai_chat.py` | `stream_message` 改为 `async def`；新增 `Request` 依赖；提取 `_prepare_conversation_turn` 与 `_legacy_stream_response` 两个辅助函数；`event_stream` 内部按 `enable_web_search` 分流。 |
| `docs/ai-chat-native-architecture.md` | § 9.2 / § 10 标 Phase 1 实际完成情况；§ 9.3 增补 Phase 2 计划入口 |

---

## 实施状态

- [x] **任务 1：依赖** — `pydantic-ai==2.8.0` 已写入 requirements.txt；`tests/services/test_ai_pydantic_ai_dependency.py` 5 项单测全过。
  - 注：pydantic-ai 2.8.0 间接拉入 `sse-starlette>=3` 要求 `starlette>=1.0`，与 `fastapi==0.115.5` 要求的 `starlette<0.42` 冲突。本仓库 app 代码不直接使用 sse-starlette，venv 中卸载 sse-starlette + 保留 starlette 0.41.3 即可（与 fastapi 兼容）；mcp 包间接需要 sse-starlette，但本仓库不依赖 mcp。

---

## 任务

### 任务 1：依赖 ✅ 已完成

**文件：**
- 修改：`backend/requirements.txt`
- 创建：`backend/tests/services/test_ai_pydantic_ai_dependency.py`

- [x] **步骤 1：写失败测试**

```python
# backend/tests/services/test_ai_pydantic_ai_dependency.py
def test_pydantic_ai_importable():
    import pydantic_ai
    assert pydantic_ai.__version__.startswith("2.8")
```

- [x] **步骤 2：跑测试，预期 FAIL**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_ai_pydantic_ai_dependency.py -v
# 预期：ImportError: No module named 'pydantic_ai'
```

- [x] **步骤 3：追加依赖**

`backend/requirements.txt` 末尾加：
```
pydantic-ai==2.8.0
```

> **Phase 1 不引 tavily-python**：factory 不注册 Tavily tool，工具调用推迟到 Phase 2 一并接入。

- [x] **步骤 4：安装**
```bash
cd backend && ./.venv/bin/pip install "pydantic-ai==2.8.0"
```

实际：成功安装；之后卸载 `sse-starlette` 解决 starlette 冲突，保留 `starlette==0.41.3`（与 fastapi==0.115.5 兼容）。

- [x] **步骤 5：测试 PASS（5/5）**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_ai_pydantic_ai_dependency.py -v
# 结果：5 passed in 0.93s
```

- [ ] **步骤 6：Commit**
```bash
git add backend/requirements.txt backend/tests/services/test_ai_pydantic_ai_dependency.py
git commit -m "build(deps): 引入 pydantic-ai==2.8.0（chat 流式编排原生化 · Phase 1）"
```

---

### 任务 2：Stream Mapper — 文本 delta

**文件：**
- 创建：`backend/app/services/ai/stream_mapper.py`
- 创建：`backend/tests/services/test_stream_mapper.py`

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/services/test_stream_mapper.py
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_mapper import MapperState, map_agent_event


def test_text_delta_yields_chunk_bytes():
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta="hi"))
    out = map_agent_event(event, state)
    assert out == b'{"type":"chunk","delta":"hi"}\n'
    assert state["assistant_parts"] == ["hi"]


def test_text_delta_skips_empty_delta():
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=TextPartDelta(content_delta=""))
    assert map_agent_event(event, state) is None
    assert state.get("assistant_parts", []) == []
```

- [ ] **步骤 2：跑测试，预期 FAIL**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
# 预期：ImportError or ModuleNotFoundError: app.services.ai.stream_mapper
```

- [ ] **步骤 3：最小实现**

```python
# backend/app/services/ai/stream_mapper.py
from __future__ import annotations

from typing import Any

from pydantic_ai.messages import PartDeltaEvent, TextPartDelta

from app.services.ai.stream_utils import build_stream_chunk


class MapperState(dict):
    """事件流运行期状态。继承 dict 兼容字段访问。"""


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    """Pydantic AI 事件 → ndjson 字节。返回 None 表示不产数据。

    Phase 1 仅覆盖 PartDeltaEvent (text)；
    thinking/usage 分支在任务 3/4 追加。
    """
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
    return None
```

- [ ] **步骤 4：跑测试，预期 PASS**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**
```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 初版（text delta → chunk）"
```

---

### 任务 3：Stream Mapper — thinking delta

**文件：** 同上

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai.messages import ThinkingPartDelta


def test_thinking_delta_yields_thinking_chunk_bytes():
    state: MapperState = {}
    event = PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="hmm"))
    out = map_agent_event(event, state)
    assert out == b'{"type":"thinking_chunk","delta":"hmm"}\n'


def test_thinking_delta_does_not_mix_with_assistant_parts():
    state: MapperState = {}
    map_agent_event(PartDeltaEvent(index=0, delta=ThinkingPartDelta(content_delta="…")), state)
    assert "assistant_parts" not in state
```

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：在 mapper 加 thinking 分支**

```python
# 修改 stream_mapper.py
from pydantic_ai.messages import PartDeltaEvent, TextPartDelta, ThinkingPartDelta
from app.services.ai.stream_utils import build_stream_chunk, build_stream_thinking_chunk


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
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

### 任务 4：Stream Mapper — AgentRunResult → usage

**文件：** 同上

- [ ] **步骤 1：写失败测试**

```python
# 加到 test_stream_mapper.py
from pydantic_ai import AgentRunResultEvent


class _FakeUsage:
    prompt_tokens = 1; completion_tokens = 2; total_tokens = 3


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


def test_agent_run_result_handles_missing_usage():
    class _NoUsageResult:
        usage = None
        output = ""
    state: MapperState = {}
    out = map_agent_event(AgentRunResultEvent(result=_NoUsageResult()), state)
    assert state["final_usage"] is None


def test_agent_run_result_assembles_final_content_from_parts():
    state: MapperState = {"assistant_parts": ["你", "好"]}
    out = map_agent_event(AgentRunResultEvent(result=_FakeResult()), state)
    assert state["final_content"] == "你好"
```

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：在 mapper 加 AgentRunResult 分支**

```python
# 修改 stream_mapper.py
from pydantic_ai import AgentRunResultEvent
from app.services.ai.stream_utils import (
    build_stream_chunk,
    build_stream_thinking_chunk,
    build_stream_usage,
)


def map_agent_event(event: Any, state: MapperState) -> bytes | None:
    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            state.setdefault("assistant_parts", []).append(delta.content_delta)
            return build_stream_chunk(delta.content_delta)
        if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
            return build_stream_thinking_chunk(delta.content_delta)
        return None
    if isinstance(event, AgentRunResultEvent):
        u = event.result.usage  # 属性而非方法（Pydantic AI 已知陷阱）
        usage_dict = (
            {
                "prompt_tokens": getattr(u, "prompt_tokens", 0),
                "completion_tokens": getattr(u, "completion_tokens", 0),
                "total_tokens": getattr(u, "total_tokens", 0),
            }
            if u is not None
            else None
        )
        state["final_usage"] = usage_dict
        state["final_content"] = "".join(state.get("assistant_parts", [])).strip()
        return build_stream_usage(usage_dict)
    return None
```

> `done` 事件由**端点层**在 commit DB 后 yield，因为需要 `user_row` / `assistant_row` / conversation 元数据，不属 mapper 责任范围。

- [ ] **步骤 4：跑测试，预期 PASS**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_stream_mapper.py -v
```

- [ ] **步骤 5：Commit**
```bash
git add backend/app/services/ai/stream_mapper.py backend/tests/services/test_stream_mapper.py
git commit -m "feat(ai): stream_mapper 加 AgentRunResultEvent → usage"
```

---

### 任务 5：Agent Factory（无 tools）

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


def _fake_settings():
    s = type("S", (), {})()
    s.ai_chat_default_model = "gpt-4"
    s.ai_chat_provider_api_key = "test-key"
    s.ai_chat_provider_base_url = "https://api.openai.com/v1"
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


def test_build_chat_agent_registers_no_tools_phase1():
    """Phase 1 工厂不注册 tools：web_search 推迟到 Phase 2。"""
    agent = build_chat_agent(_fake_settings())
    assert len(agent.tools) == 0


def test_build_chat_agent_uses_settings_provider_base_url():
    settings = _fake_settings()
    settings.ai_chat_provider_base_url = "https://custom.example.com/v1"
    # 仅校验工厂构建不抛错；具体 provider 实例校验放 integration 测试
    agent = build_chat_agent(settings)
    assert isinstance(agent, Agent)
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
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from app.core.config import Settings


def current_date_instruction(ctx: RunContext | None) -> str:
    """Pydantic AI 动态指令：注入今天的日期，供模型时间锚定。"""
    return f"今天的日期是 {datetime.now().strftime('%Y-%m-%d')}。回答涉及时间时请以此为参照。"


def _build_model(settings: Settings) -> OpenAIChatModel:
    return OpenAIChatModel(
        settings.ai_chat_default_model,
        provider=OpenAIProvider(
            api_key=settings.ai_chat_provider_api_key,
            base_url=settings.ai_chat_provider_base_url,
        ),
    )


def build_chat_agent(settings: Settings, instructions: Optional[Iterable] = None) -> Agent:
    """构造 Pydantic AI Agent。

    Phase 1：不注册 tools（web_search 走旧路径）；仅 `Thinking()` capability。
    Phase 2：追加 `tavily_search_tool` 注册与对应指令。
    """
    model = _build_model(settings)
    base_instructions = [
        "你是一个有用的 AI 助手，回答简洁准确。",
        current_date_instruction,
    ]
    merged_instructions: list = list(instructions) if instructions else []
    return Agent(
        model=model,
        instructions=merged_instructions + base_instructions,
        capabilities=[Thinking()],
        tools=[],
    )
```

- [ ] **步骤 4：跑测试，预期 PASS**
```bash
cd backend && ./.venv/bin/pytest tests/services/test_agent_factory.py -v
```

- [ ] **步骤 5：Commit**
```bash
git add backend/app/services/ai/agent.py backend/tests/services/test_agent_factory.py
git commit -m "feat(ai): Agent 工厂 Phase 1（Thinking + 动态 current_date，无 tools）"
```

---

### 任务 6：端点 async 改造 + 双路径分流

**文件：**
- 修改：`backend/app/api/v1/endpoints/ai_chat.py`
- 创建：`backend/tests/api/test_ai_chat_stream_native.py`

> 端点改动面最大。先确认任务 1-5 已合并。

- [ ] **步骤 1：写失败测试**

```python
# backend/tests/api/test_ai_chat_stream_native.py
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.ai import chat as chat_service
from app.services.ai import cancel as cancel_registry


@pytest.fixture()
def client(monkeypatch, db_session):
    """TestModel 替换真实 provider，避免依赖外网。"""
    from pydantic_ai.models.test import TestModel
    from app.services.ai.agent import build_chat_agent

    def fake_build(settings):
        return build_chat_agent(settings).override(
            model=TestModel(custom_output_text="你好，已完成。")
        )

    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)
    return TestClient(app)


def _create_conversation(db_session, user_id: int = 42) -> int:
    from app.models.ai_chat import AIConversation
    row = AIConversation(user_id=user_id, title="t")
    db_session.add(row)
    db_session.commit()
    return row.id


def test_native_path_emits_start_chunk_usage_done_in_order(client, db_session):
    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "你好", "enable_web_search": False},
        headers={"X-User-Id": "42"},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    types = [
        line.split('"type":')[1].split('"')[1]
        for line in body.strip().split("\n")
        if '"type":' in line
    ]
    assert types[0] == "start"
    assert "chunk" in types
    assert "usage" in types
    assert types[-1] == "done"
    done_line = next(line for line in body.split("\n") if line.startswith('{"type":"done"'))
    assert '"assistant_message"' in done_line


def test_regenerate_with_web_search_false_returns_400(client, db_session):
    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "再生成", "regenerate": True, "enable_web_search": False},
        headers={"X-User-Id": "42"},
    ) as resp:
        assert resp.status_code == 400


def test_legacy_path_preserved_when_enable_web_search_true(client, db_session, monkeypatch):
    """enable_web_search=True 必须走旧同步路径，行为冻结。"""
    from app.services.ai import tools as tools_module

    captured = {"called": False}

    def fake_stream_with_tool_calling(**kwargs):
        captured["called"] = True
        yield {"type": "tool_searching"}
        yield {"type": "sources", "sources": [], "time_range": "day", "query": "x"}
        yield {"type": "tool_done"}
        yield {"type": "chunk", "delta": "你好"}
        yield {"type": "usage", "usage": {"prompt_tokens": 1, "completion_tokens": 2, "total_tokens": 3}}

    monkeypatch.setattr(tools_module, "stream_with_tool_calling", fake_stream_with_tool_calling)

    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天天气", "enable_web_search": True},
        headers={"X-User-Id": "42"},
    ) as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    assert captured["called"], "enable_web_search=True 必须走旧路径"
    assert '"tool_searching"' in body
    assert '"sources"' in body


def test_attached_file_content_injected_into_system_prompt(client, db_session):
    """attached_file_content 在 _prepare_conversation_turn 内注入到 system_prompt，新旧路径共享。"""
    conv_id = _create_conversation(db_session)
    captured = {"system_prompt": None}

    def fake_build(settings):
        from app.services.ai.agent import build_chat_agent as real
        from pydantic_ai.models.test import TestModel

        agent = real(settings).override(model=TestModel(custom_output_text="已读取"))
        return agent

    monkeypatch.setattr(
        "app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build
    )
    # 验证 attached_file 透传：检查 Pydantic AI prompt 中是否含文件名
    # （如果实现里直接读 system_prompt，可在 _prepare_conversation_turn 注入）
    ...
```

> 路由前缀、FastAPI app 装配、db fixture、auth 等以现有 backend 测试约定为准（参考 `backend/tests/api/test_internal.py`）。

- [ ] **步骤 2：跑测试，预期 FAIL**

- [ ] **步骤 3：改造 `stream_message`**

**策略：** 把现有 `def event_stream()` 整段抽为模块级 `_legacy_stream_response(...)`（同步 generator）；把入参段抽为 `_prepare_conversation_turn(...)`；新 `stream_message` 按 `enable_web_search` 分流。

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
    """SSE 流式对话端点。

    [Phase 1] 双路径：
    - `enable_web_search=False` → Pydantic AI 驱动（async、解 P0-1/P0-2）
    - `enable_web_search=True`  → 旧 httpx 路径，行为冻结
    [Phase 2] 旧路径将被 Pydantic AI native Tavily tool 取代。
    """
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    history = ai_chat_service.list_messages(db, conversation_id, user_id)
    regenerate = payload.regenerate
    user_content = payload.content.strip()

    if regenerate and not payload.enable_web_search:
        # Phase 1 简化：新路径不支持 regenerate
        raise HTTPException(
            status_code=400,
            detail="重新生成仅在启用联网搜索时支持",
        )

    if not user_content and not regenerate:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    prompt_messages, user_row, assistant_row, target_assistant = _prepare_conversation_turn(
        db=db,
        conversation=conversation,
        conversation_id=conversation_id,
        history=history,
        payload=payload,
        user_content=user_content,
        regenerate=regenerate,
    )

    if payload.enable_web_search:
        return _legacy_stream_response(
            db=db,
            conversation=conversation,
            prompt_messages=prompt_messages,
            user_row=user_row,
            assistant_row=assistant_row,
            target_assistant=target_assistant,
            user_content=user_content,
            payload=payload,
            history=history,
            settings=settings,
            cancel_event=cancel_registry.register(conversation_id),
        )

    from app.services.ai.agent import build_chat_agent
    from app.services.ai.stream_mapper import MapperState, map_agent_event

    agent = build_chat_agent(settings)
    cancel_event = cancel_registry.register(conversation_id)
    state: MapperState = {}

    async def event_stream():
        try:
            yield encode_stream_event({"type": "start"})
            async with agent.run_stream_events(prompt_messages) as events:
                async for ev in events:
                    if cancel_event.is_set() or await request.is_disconnected():
                        cancel_event.set()
                        raise _CancelledError()
                    out = map_agent_event(ev, state)
                    if out is not None:
                        yield out

            final_content = state.get("final_content") or ""
            ai_chat_service.update_message_content(db, assistant_row.id, final_content)
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
                user_message=serialize_message(user_row),
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


def _prepare_conversation_turn(
    *,
    db: Session,
    conversation: AIConversation,
    conversation_id: int,
    history: list[AIMessage],
    payload: MessageCreate,
    user_content: str,
    regenerate: bool,
) -> tuple[list[dict], AIMessage | None, AIMessage, AIMessage | None]:
    """公共入参段：history 切片、user/assistant 行写入、attached_file 注入 system_prompt、prompt_messages 拼装。

    返回 (prompt_messages, user_row, assistant_row, target_assistant)。
    - regenerate=False：user_row 为新增 user 行；target_assistant=None
    - regenerate=True：user_row 为历史 user 行；target_assistant 为目标 assistant 行
    """
    if regenerate:
        if len(history) < 2:
            raise HTTPException(status_code=400, detail="没有可重新生成的消息")
        if payload.target_message_id is not None:
            target_idx = next(
                (i for i, r in enumerate(history) if r.id == payload.target_message_id),
                None,
            )
            if target_idx is None:
                raise HTTPException(status_code=404, detail="指定的消息不存在")
            if target_idx == 0 or history[target_idx - 1].role != "user":
                raise HTTPException(
                    status_code=400,
                    detail="指定消息的前一条不是用户消息，无法重新生成",
                )
            target_assistant = history[target_idx]
            target_user = history[target_idx - 1]
            context_messages = history[: target_idx - 1]
            user_content = target_user.content.strip()
        else:
            last_assistant = history[-1]
            last_user = history[-2]
            if last_assistant.role != "assistant" or last_user.role != "user":
                raise HTTPException(
                    status_code=400, detail="当前会话末尾消息不支持重新生成"
                )
            context_messages = history[:-2]
            user_content = last_user.content.strip()
            target_assistant = last_assistant
        user_row = history[-2]
        db.delete(target_assistant)
        db.flush()
        assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
    else:
        context_messages = history
        user_row = ai_chat_service.append_message(db, conversation_id, "user", user_content)
        assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
        target_assistant = None
    db.flush()

    # attached_file_content 注入到 system_prompt（仅非 regenerate 时）
    system_prompt_extra = ""
    if payload.attached_file_content:
        system_prompt_extra = (
            f"\n\n【用户附加文件：{payload.attached_file_name or 'file'}】\n"
            f"{payload.attached_file_content.strip()}\n"
            "请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
        )

    prompt_messages: list[dict] = []
    for m in context_messages[-20:]:
        prompt_messages.append({"role": m.role, "content": m.content})
    if system_prompt_extra:
        # 把附加文件追加到最后一条 user 消息之后
        prompt_messages.append({"role": "user", "content": user_content})
        prompt_messages.append({"role": "system", "content": system_prompt_extra.strip()})
    else:
        prompt_messages.append({"role": "user", "content": user_content})

    return prompt_messages, user_row, assistant_row, target_assistant


def _legacy_stream_response(
    *,
    db: Session,
    conversation: AIConversation,
    prompt_messages: list[dict],
    user_row: AIMessage | None,
    assistant_row: AIMessage,
    target_assistant: AIMessage | None,
    user_content: str,
    payload: MessageCreate,
    history: list[AIMessage],
    settings: Settings,
    cancel_event,
):
    """旧同步路径：`enable_web_search=True` 走这里。逻辑完全冻结（与现状 byte-for-byte 一致）。"""
    # ... 完整搬自原 lines 377-578 的 event_stream() 整段。
    # ... 维持：llm_config 计算、stream_with_tool_calling + fallback、标题生成、duration_ms、token_usage、mark_message_complete 等。
    ...
```

> **实施者注意：**
> - `_prepare_conversation_turn` 与 `_legacy_stream_response` 是**纯重构**，原 `def stream_message` 里的逻辑逐字搬过去；不要顺手改业务行为
> - `_legacy_stream_response` 内部继续用 `cancel_registry.register`（同步 Event 在 async 上下文里 `is_set()` 是非阻塞）
> - 标题生成 (`generate_conversation_title`) 仅在旧路径保留；新路径暂不自动生成
> - `attached_file_content` 注入放在 `_prepare_conversation_turn` 内，新旧路径共享同一段
> - `regenerate=True && enable_web_search=False` 已在 `stream_message` 入口返 400，不需要在 `_prepare_conversation_turn` 内再做防御

- [ ] **步骤 4：跑 E2E 测试，预期 PASS**
```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_native.py -v
```

如失败，逐项调试：
- 检查 `build_chat_agent` 是否被正确 monkeypatch 到 `app.api.v1.endpoints.ai_chat`
- 检查 mapper 状态字段名（`assistant_parts / final_usage / final_content`）
- 检查 TestModel 的 `custom_output_text` 路径与 Pydantic AI 2.8 的 `Agent.override()` 签名

- [ ] **步骤 5：跑全后端测试，确认无回归**
```bash
cd backend && ./.venv/bin/pytest -q
```

允许的失败：与 22 个 JSONB/SQLite 测试基础设施错误同源的预存在 errors（即 fixture 阶段挂在 `r2_delete_failures JSONB` 上的，不应当因本 PR 增多）。

- [ ] **步骤 6：Commit**
```bash
git add backend/app/api/v1/endpoints/ai_chat.py backend/tests/api/test_ai_chat_stream_native.py
git commit -m "feat(ai): stream_message async 化 + enable_web_search 分流（Pydantic AI 路径 + 旧路径兜底）"
```

---

### 任务 7：真 LLM 烟雾测试（手测）

**文件：** 不改代码；在本 plan 末尾「手测记录」节填入输出片段。

- [ ] **步骤 1：本地启动后端**
```bash
cd backend && ./.venv/bin/uvicorn app.main:app --reload --port 8000
```

- [ ] **步骤 2：创建会话 + 发送 `enable_web_search=False` 真流式请求**
```bash
curl -N -X POST "http://localhost:8000/api/v1/ai/conversations/<id>/messages/stream" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"content":"你好，介绍下 Pydantic AI","enable_web_search":false}'
```

预期 ndjson：`start` → `thinking_chunk` × N（可选）→ `chunk` × N → `usage` → `done`

- [ ] **步骤 3：取消按钮**

在前端页面发一条流式请求，期间点击「停止」。预期：流立即中断 + 服务端 `cancel_registry` 标记该 conv_id + DB 回滚未提交写入。

- [ ] **步骤 4：前端冒烟**
```bash
cd frontend && pnpm lint && pnpm build && pnpm test
```
预期：`consumeStream` 对 start/chunk/thinking_chunk/usage/done 解析逻辑零回归。

- [ ] **步骤 5：写「手测通过」记录**

在本 plan 文件末尾追加「Smoke test 记录」一节，填入实际输出片段。

---

### 任务 8：Merge 前最终检查与文档同步

**文件：** `docs/ai-chat-native-architecture.md`

- [ ] **步骤 1：核对「依赖」小节**

把 `backend/requirements.txt` 实际增加的版本行（`pydantic-ai==2.8.0`，**不**含 tavily-python）写到架构文档的 § 10。

- [ ] **步骤 2：核对「落地路径」**

§ 9.2 中标 Phase 1 完成项；§ 9.3 增补 Phase 2 计划入口，引用本 plan 与原生 plan。

- [ ] **步骤 3：跑最终全量后端测试 + 前端测试**
```bash
cd backend && ./.venv/bin/pytest -q
cd ../frontend && pnpm test
```

- [ ] **步骤 4：Commit（如文档有更新）**
```bash
git add docs/ai-chat-native-architecture.md
git commit -m "docs(ai): 更新 native 架构文档 § 9/§ 10 与 Phase 1 PR 实际落地一致"
```

- [ ] **步骤 5：准备 PR 描述**

依据 `AGENTS.md` 的 commit 规范（中文 + Conventional Commits）整理 commit 列表，写 PR 描述：
- **迁移点**：`stream_message` 改 async + 新增 `Request` 依赖；`enable_web_search=False` 用户路径换 Pydantic AI driver
- **行为变更**：仅 `enable_web_search=False` 路径内部编排变化；ndjson 协议、UX 可见事件序列零变化
- **风险点**：(a) Pydantic AI 2.8 在不同 OpenAI 兼容 provider 上的事件顺序可能差异（需一周观察）；(b) 模型兼容性；(c) SearXNG 中文搜索质量仍是独立 ticket，**未**在 Phase 1 触及
- **回滚策略**：单 commit revert；旧 `event_stream()` 逻辑完整保留在 `_legacy_stream_response`，可手动改路由临时回退

---

## 自检清单（PR 前复核）

- [ ] mapper 仅覆盖 text / thinking / usage 三分支，无 tool_calls / tool_result 逻辑
- [ ] factory 不注册 tools；仅 `Thinking()` capability
- [ ] `enable_web_search=True` 端点路径调用栈与现状 byte-for-byte 一致（用 e2e 测试固化）
- [ ] `result.usage` 写为属性（`event.result.usage`），不是 `event.result.usage()`
- [ ] `base_url` 全程走 `settings.ai_chat_provider_base_url`，无写死
- [ ] 前端 `consumeStream` 与 ndjson 协议零改动
- [ ] 跑全量 backend `pytest -q`，失败数不超出现状基线
- [ ] `attached_file_content` 注入逻辑只存在于 `_prepare_conversation_turn`，新旧路径共享

---

## 手测记录（任务 7 完成后填）

> 由实施者在任务 7 完成后填入：
> - 真 LLM `enable_web_search=False` 完整 ndjson 片段
> - 取消按钮实际响应时间
> - 前端 `pnpm test` 结果
> - `enable_web_search=True` 用户路径对比（应与现状一致）

---

## Phase 2 起点（明确边界）

Phase 2 任务直接对接 Phase 1，**起点为以下三个 commit 之后**：

1. **SearXNG Tavily adapter 返回格式 spike**
   任务：单测 + 真实请求，确认 `/search` 端点返回 `dict` 含 `results: list[dict]` 还是直接的 `list[dict]`。结果决定 `_handle_tool_result` 如何提取 `results`。
   文件：`backend/tests/services/test_searxng_tavily_adapter_shape.py`（新建 spike 文件）

2. **Stream Mapper — tool_calls 分支**（原 T4）
3. **Stream Mapper — tool_result 分支**（原 T5）
4. **Agent Factory 注册 `tavily_search_tool`**（T7 增量）
5. **端点 `enable_web_search=True` 切到 Pydantic AI native tool**（T8 增量）
6. **端点层 `tool_searching` 事件与 mapper 解耦**

Phase 2 验收：
- `enable_web_search=True` 用户的 ndjson 事件序列与 Phase 1 旧路径完全一致
- `search_source_cards` / `search_time_range` 持久化字段不变
- `cancel_registry` 行为不变