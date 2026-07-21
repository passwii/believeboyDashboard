# AI 应用层 V2 · Phase D:迁移 + 清理 + e2e

> **父计划：** [`2026-07-19-ai-application-layer-v2.md`](./2026-07-19-ai-application-layer-v2.md)
> **依赖：** Phase A + B + C 全部完成并验证

**目标：** 删除旧代码(stream_mapper / cancel / test_native)+ 补全 e2e 测试 + 更新文档。

**非目标：**
- 不改 V2 新代码逻辑(Phase A-C 已稳定)
- 不做 Playwright e2e(P5 独立 phase)

---

## 文件清单

| 操作 | 文件 | 说明 |
|---|---|---|
| 删除 | `backend/app/services/ai/stream_mapper.py` | 职责已并入 orchestrator/runner.py |
| 删除 | `backend/app/services/ai/cancel.py` | 已迁移到 orchestrator/cancel.py |
| 删除 | `backend/tests/api/test_ai_chat_stream_native.py` | 被 test_ai_chat_stream_v2.py 替代 |
| 修改 | `backend/app/services/ai/__init__.py` | 移除对 stream_mapper 的引用 |
| 修改 | `backend/app/api/v1/endpoints/ai_chat.py` | 移除旧 event_stream + _CancelledError(已被 V2 替代) |
| 扩充 | `backend/tests/api/test_ai_chat_stream_v2.py` | 补全 e2e 覆盖 |
| 创建 | `backend/tests/orchestrator/test_resume_e2e.py` | resume 端到端 |
| 更新 | `docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md` | 标注"已被 V2 取代" |
| 更新 | `backend/REVIEW_ISSUES_TRACKER.md` | 更新 AI chat 架构状态 |

---

## 任务

### 任务 D1:删除旧代码 + 清理引用

**文件：**
- 删除：`backend/app/services/ai/stream_mapper.py`
- 删除：`backend/app/services/ai/cancel.py`
- 删除：`backend/tests/api/test_ai_chat_stream_native.py`
- 修改：`backend/app/services/ai/__init__.py`、`backend/app/api/v1/endpoints/ai_chat.py`

- [ ] **步骤 1：确认无引用残留**

```bash
cd backend
# 确认 stream_mapper 不再被 import
grep -rn "from app.services.ai.stream_mapper\|import stream_mapper\|from app.services.ai.cancel import\|import cancel" app/ --include="*.py"
# 预期：无输出(或只有 ai_chat.py 旧代码块,即将删除)
```

- [ ] **步骤 2：删除文件**

```bash
cd backend
git rm app/services/ai/stream_mapper.py
git rm app/services/ai/cancel.py
git rm tests/api/test_ai_chat_stream_native.py
```

- [ ] **步骤 3：清理 ai_chat.py 旧代码块**

删除 `ai_chat.py` 中已被 V2 替代的旧代码:
- 旧 `event_stream` 函数(已被 StreamRunner 替代)
- `_CancelledError` 类(已迁移到 orchestrator/runner.py)
- 旧 `from app.services.ai.stream_mapper import ...` import 行
- 旧 `from app.services.ai import cancel as cancel_registry` import 行
- 旧 `build_stream_*` 相关 import(如果不再使用)

- [ ] **步骤 4：清理 ai/__init__.py**

移除 `stream_mapper` / `cancel` 相关的 re-export(如果有)。

- [ ] **步骤 5：运行全量测试确认无回归**

```bash
cd backend && ./.venv/bin/pytest tests/ -v --tb=short -x
# 预期：全部 passed(旧 native 测试已删,V2 测试覆盖)
```

- [ ] **步骤 6：Commit**

```bash
git add -A backend/
git commit -m "refactor(ai-chat): remove legacy stream_mapper + cancel + native tests(V2 Phase D1)"
```

---

### 任务 D2:补全 e2e 测试覆盖

**文件：**
- 扩充：`backend/tests/api/test_ai_chat_stream_v2.py`
- 创建：`backend/tests/orchestrator/test_resume_e2e.py`

- [ ] **步骤 1：编写测试**

在 `test_ai_chat_stream_v2.py` 追加:

```python
def test_stream_v2_with_thinking(patched_runner, client, db_session, api_key, monkeypatch):
    """思考流(thinking delta)事件序列。"""
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, **_):
        return Agent(
            model=TestModel(custom_output_text="思考后回复"),
            capabilities=[Thinking()],
            tools=[],
        )
    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)

    conv_id = _create_conversation(db_session)
    with client.stream("POST", f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "思考一下", "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    types = [e["data"].get("type") for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"


def test_stream_v2_with_tool_use(patched_runner, client, db_session, api_key, monkeypatch):
    """工具调用流(content_block_start{tool_use} + tool_result)。"""
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    async def tavily_search(ctx, query: str) -> list[dict]:
        return [{"title": "Result", "url": "https://r.com", "content": "data", "score": 0.9}]

    def fake_build(settings, *, model_name=None, web_search=False, **_):
        return Agent(
            model=TestModel(call_tools=["tavily_search"], custom_output_text="搜索完毕"),
            capabilities=[Thinking()],
            tools=[tavily_search],
        )
    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)

    conv_id = _create_conversation(db_session)
    with client.stream("POST", f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天天气", "enable_web_search": True},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    types = [e["data"].get("type") for e in events]
    # 应有 tool_use content_block
    assert "content_block_start" in types
    assert "content_block_delta" in types


def test_stream_v2_content_type_is_event_stream(patched_runner, client, db_session, api_key):
    """Content-Type 必须是 text/event-stream。"""
    conv_id = _create_conversation(db_session)
    with client.stream("POST", f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "hi", "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert "text/event-stream" in resp.headers.get("content-type", "")


def test_stream_v2_regenerate_without_search_400(patched_runner, client, db_session, api_key):
    """regenerate + web_search=False → 400(Phase 2 路由限制保留)。"""
    from app.models.ai_chat import AIMessage
    conv_id = _create_conversation(db_session)
    db_session.add(AIMessage(conversation_id=conv_id, role="user", content="hi"))
    db_session.add(AIMessage(conversation_id=conv_id, role="assistant", content="hello", is_complete=True))
    db_session.commit()

    with client.stream("POST", f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "重新生成", "regenerate": True, "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 400


def test_stream_v2_sse_has_id_field(patched_runner, client, db_session, api_key):
    """每个 SSE 事件携带 id 字段(Redis Stream entry_id,供 Last-Event-ID resume)。"""
    conv_id = _create_conversation(db_session)
    with client.stream("POST", f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "hi", "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    events = _parse_sse_events(body)
    # 至少部分事件有 id
    has_id = any(e["id"] is not None for e in events)
    assert has_id, "no event has id field"
```

创建 `test_resume_e2e.py`:

```python
# backend/tests/orchestrator/test_resume_e2e.py
"""断连重连 e2e:subscribe(from_id=last_id) 续传。"""
import asyncio
import pytest

from app.services.ai.orchestrator.runner import StreamRunner
from app.services.ai.protocol.events import MessageStop


@pytest.mark.asyncio
async def test_resume_returns_only_events_after_last_id(runner, bus, monkeypatch):
    """重连只返回 last_event_id 之后的事件。"""
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel
    from contextlib import asynccontextmanager

    conv_id = 100
    agent = Agent(model=TestModel(custom_output_text="resume test"), capabilities=[Thinking()], tools=[])

    original_iter = agent.iter

    @asynccontextmanager
    async def slow_iter(*args, **kwargs):
        await asyncio.sleep(0.1)
        async with original_iter(*args, **kwargs) as run:
            yield run

    monkeypatch.setattr(agent, "iter", slow_iter)

    task = asyncio.create_task(runner.run(conv_id, agent, "hi", model_name="test"))

    # 消费前 2 个 SSE chunk
    first_batch = []
    async for chunk in runner.subscribe(conv_id, from_id="0"):
        first_batch.append(chunk)
        if len(first_batch) >= 2:
            break

    # 提取 last_id
    last_id = None
    for chunk in first_batch:
        for line in chunk.decode().split("\n"):
            if line.startswith("id: "):
                last_id = line[4:].strip()
    assert last_id is not None

    # 重连续传
    rest = []
    async for chunk in runner.subscribe(conv_id, from_id=last_id):
        rest.append(chunk)
    await task

    assert len(rest) > 0
    # 最后是 message_stop
    assert b"message_stop" in rest[-1]
```

- [ ] **步骤 2：运行测试**

```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_v2.py tests/orchestrator/test_resume_e2e.py -v
# 预期：全部 passed
```

- [ ] **步骤 3：Commit**

```bash
git add backend/tests/api/test_ai_chat_stream_v2.py backend/tests/orchestrator/test_resume_e2e.py
git commit -m "test(ai-chat): V2 e2e — thinking/tool/content-type/resume/400(V2 Phase D2)"
```

---

### 任务 D3:更新文档

**文件：**
- 修改：`docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md`(头部标注)
- 修改：`backend/REVIEW_ISSUES_TRACKER.md`

- [ ] **步骤 1：标注 V1 spec 已被取代**

在 `2026-07-17-ai-chat-architecture-redesign-design.md` 第 1 行后插入:

```markdown
> **⚠️ 状态更新(2026-07-19)：** 本文档(V1)已被 [`2026-07-19-ai-application-layer-redesign-v2-design.md`](./2026-07-19-ai-application-layer-redesign-v2-design.md) 取代。V2 在 V1 基础上,经开源研究后调整了执行架构(执行/分发解耦 + Redis Stream)和 agent API(agent.iter)。本文档保留作为历史参考。
```

- [ ] **步骤 2：更新 REVIEW_ISSUES_TRACKER.md**

在 AI chat 相关段落更新状态为"V2 P1 已实施"。

- [ ] **步骤 3：Commit**

```bash
git add docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md backend/REVIEW_ISSUES_TRACKER.md
git commit -m "docs(ai-chat): mark V1 spec superseded + update tracker(V2 Phase D3)"
```

---

## Phase D 完成标准

- [ ] `stream_mapper.py` / `cancel.py` / `test_ai_chat_stream_native.py` 已删除
- [ ] `grep -rn "stream_mapper\|from.*cancel import" backend/app/ --include="*.py"` 无残留
- [ ] 全量 `pytest tests/` passed
- [ ] `test_ai_chat_stream_v2.py` 覆盖:happy / thinking / tool / content-type / id-field / cancel / 400
- [ ] `test_resume_e2e.py` passed
- [ ] V1 spec 已标注"已被 V2 取代"

---

## P1 全部完成标准

- [ ] Phase A:协议层单测 passed
- [ ] Phase B:编排器单测 passed(fakeredis,无需真实 Redis)
- [ ] Phase C:端点 e2e passed + 前端 codec 单测 passed + tsc 无错误
- [ ] Phase D:旧代码删除 + e2e 补全 + 文档更新
- [ ] 全量 `pytest tests/` passed(0 failures)
- [ ] 手动冒烟:curl POST /stream → `text/event-stream` + `message_start` + `content_block_delta` + `message_stop`
- [ ] 手动冒烟:前端能消费 SSE 流并渲染(用 TestModel 后端)
