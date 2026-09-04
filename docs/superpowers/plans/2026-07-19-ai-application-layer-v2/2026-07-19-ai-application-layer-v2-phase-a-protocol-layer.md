# AI 应用层 V2 · Phase A:协议层

> **父计划：** [`2026-07-19-ai-application-layer-v2.md`](./2026-07-19-ai-application-layer-v2.md)
> **承接 spec：** §5(协议事件定义)、§10(错误码)
> **Spike 参考：** `openSourceProjects/ai-app-layer-spike/spike/protocol.py` + `encoder.py`

**目标：** 建立协议层纯定义模块(ProtocolEvent / ContentBlock / Delta / Usage / ErrorCode),以及 SSE 编码器。不依赖 Redis / FastAPI / Pydantic AI,可独立单测。

**非目标：**
- 不写编排器(Phase B)
- 不改端点(Phase C)
- 不删旧代码(Phase D)

---

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 创建 | `backend/app/services/ai/protocol/__init__.py` | 包入口,re-export 主要类型 |
| 创建 | `backend/app/services/ai/protocol/events.py` | ProtocolEvent discriminated union + ContentBlock / Delta / Usage |
| 创建 | `backend/app/services/ai/protocol/encoder.py` | `encode_sse(event, entry_id=None) -> bytes` |
| 创建 | `backend/app/services/ai/protocol/errors.py` | ErrorCode enum + ProtocolError |
| 创建 | `backend/tests/protocol/__init__.py` | 测试包 |
| 创建 | `backend/tests/protocol/test_events.py` | union 校验测试 |
| 创建 | `backend/tests/protocol/test_encoder.py` | 编码 round-trip 测试 |

---

## 任务

### 任务 A1:ErrorCode enum + ProtocolError

**文件：**
- 创建：`backend/app/services/ai/protocol/errors.py`
- 创建：`backend/app/services/ai/protocol/__init__.py`
- 测试：`backend/tests/protocol/__init__.py`、`backend/tests/protocol/test_events.py`

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/protocol/test_events.py
"""协议层事件 + 错误码单测。"""
import pytest
from pydantic import ValidationError

from app.services.ai.protocol.errors import ErrorCode, ProtocolError


def test_error_code_values():
    """ErrorCode 枚举值与 spec §10.1 一致。"""
    assert ErrorCode.CANCELLED == "cancelled"
    assert ErrorCode.TIMEOUT == "timeout"
    assert ErrorCode.LLM_5XX == "llm_5xx"
    assert ErrorCode.LLM_4XX == "llm_4xx"
    assert ErrorCode.RATE_LIMIT == "rate_limit"
    assert ErrorCode.CONTENT_FILTER == "content_filter"
    assert ErrorCode.VALIDATION == "validation"
    assert ErrorCode.INTERNAL == "internal"
    assert ErrorCode.PERSISTENCE == "persistence"
    assert ErrorCode.TOOL_ERROR == "tool_error"
    assert ErrorCode.NETWORK == "network"


def test_protocol_error_minimal():
    """ProtocolError 最小字段(code + message)。"""
    err = ProtocolError(code=ErrorCode.INTERNAL, message="boom")
    assert err.code == ErrorCode.INTERNAL
    assert err.message == "boom"
    assert err.retry_after is None


def test_protocol_error_with_retry_after():
    """RATE_LIMIT 可携带 retry_after。"""
    err = ProtocolError(code=ErrorCode.RATE_LIMIT, message="限流", retry_after=30)
    assert err.retry_after == 30


def test_protocol_error_rejects_invalid_code():
    """非法 code 值应被拒绝。"""
    with pytest.raises(ValidationError):
        ProtocolError(code="not_a_real_code", message="x")
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_events.py -v
# 预期：ImportError: No module named 'app.services.ai.protocol'
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/protocol/errors.py
"""协议层错误码 + ProtocolError。

对应 V2 spec §10(错误分类)。
ErrorCode 贯穿后端 / 前端,前端按码分支,不做字符串匹配。
"""
from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    """AI Chat 流式错误码。前端按码分支重试/显示。"""
    NETWORK = "network"
    TIMEOUT = "timeout"
    LLM_5XX = "llm_5xx"
    LLM_4XX = "llm_4xx"
    RATE_LIMIT = "rate_limit"
    CONTENT_FILTER = "content_filter"
    CANCELLED = "cancelled"
    VALIDATION = "validation"
    INTERNAL = "internal"
    PERSISTENCE = "persistence"
    TOOL_ERROR = "tool_error"
```

```python
# backend/app/services/ai/protocol/__init__.py
"""AI Chat 协议层 — Anthropic Messages SSE 风格事件定义。

纯定义模块:不依赖 Redis / FastAPI / Pydantic AI。
经 Anthropic 官方 SDK 验证写法正确(raw_message_stream_event.py)。
"""
from app.services.ai.protocol.errors import ErrorCode, ProtocolError

__all__ = ["ErrorCode", "ProtocolError"]
```

```python
# backend/tests/protocol/__init__.py
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_events.py -v
# 预期：3 passed
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/protocol/ backend/tests/protocol/
git commit -m "feat(ai-protocol): ErrorCode enum + ProtocolError(V2 Phase A1)"
```

---

### 任务 A2:ContentBlock + Delta + Usage 定义

**文件：**
- 创建：`backend/app/services/ai/protocol/events.py`
- 修改：`backend/app/services/ai/protocol/__init__.py`
- 测试：`backend/tests/protocol/test_events.py`(追加)

- [ ] **步骤 1：编写失败的测试**

在 `backend/tests/protocol/test_events.py` 末尾追加:

```python
from app.services.ai.protocol.events import (
    ContentBlockStart,
    ContentBlockDelta,
    ContentBlockStop,
    MessageStart,
    MessageDelta,
    MessageStop,
    Ping,
    ErrorEvent,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
    ToolResultBlock,
    TextDelta,
    ThinkingDelta,
    InputJSONDelta,
    Usage,
    validate_event,
)


def test_text_block():
    block = TextBlock()
    assert block.type == "text"


def test_thinking_block():
    block = ThinkingBlock()
    assert block.type == "thinking"


def test_tool_use_block():
    block = ToolUseBlock(id="tu_1", name="web_search", input={"query": "weather"})
    assert block.type == "tool_use"
    assert block.id == "tu_1"
    assert block.name == "web_search"
    assert block.input == {"query": "weather"}


def test_tool_result_block():
    block = ToolResultBlock(tool_use_id="tu_1", content="result text")
    assert block.type == "tool_result"
    assert block.is_error is False


def test_usage_defaults():
    u = Usage()
    assert u.input_tokens == 0
    assert u.output_tokens == 0
    assert u.total_tokens == 0


def test_message_start():
    ev = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    assert ev.type == "message_start"
    assert ev.role == "assistant"


def test_content_block_start_with_text():
    ev = ContentBlockStart(index=0, content_block=TextBlock())
    assert ev.type == "content_block_start"
    assert ev.index == 0
    assert ev.content_block.type == "text"


def test_content_block_delta_text():
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="hello"))
    assert ev.type == "content_block_delta"
    assert ev.delta.type == "text_delta"
    assert ev.delta.text == "hello"


def test_content_block_delta_thinking():
    ev = ContentBlockDelta(index=1, delta=ThinkingDelta(text="hmm"))
    assert ev.delta.type == "thinking_delta"


def test_content_block_delta_input_json():
    ev = ContentBlockDelta(index=2, delta=InputJSONDelta(partial_json='{"q":"'))
    assert ev.delta.type == "input_json_delta"
    assert ev.delta.partial_json == '{"q":"'


def test_message_delta_with_stop_reason():
    ev = MessageDelta(usage=Usage(output_tokens=10), stop_reason="end_turn")
    assert ev.stop_reason == "end_turn"


def test_message_stop():
    ev = MessageStop()
    assert ev.type == "message_stop"


def test_error_event():
    from app.services.ai.protocol.errors import ErrorCode, ProtocolError
    ev = ErrorEvent(error=ProtocolError(code=ErrorCode.CANCELLED, message="用户取消"))
    assert ev.type == "error"
    assert ev.error.code == ErrorCode.CANCELLED


def test_validate_event_round_trip_message_start():
    """JSON → ProtocolEvent 解析(discriminated union 验证)。"""
    import json
    original = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    data = original.model_dump_json()
    parsed = validate_event(data)
    assert isinstance(parsed, MessageStart)
    assert parsed.message_id == "msg_1"


def test_validate_event_round_trip_content_block_delta():
    """不同事件类型通过 type discriminator 正确解析。"""
    original = ContentBlockDelta(index=0, delta=TextDelta(text="hi"))
    parsed = validate_event(original.model_dump_json())
    assert isinstance(parsed, ContentBlockDelta)
    assert isinstance(parsed.delta, TextDelta)
    assert parsed.delta.text == "hi"


def test_validate_event_round_trip_error():
    """error 事件也能解析。"""
    from app.services.ai.protocol.errors import ErrorCode, ProtocolError
    original = ErrorEvent(error=ProtocolError(code=ErrorCode.LLM_5XX, message="500"))
    parsed = validate_event(original.model_dump_json())
    assert isinstance(parsed, ErrorEvent)
    assert parsed.error.code == ErrorCode.LLM_5XX


def test_validate_event_rejects_unknown_type():
    """非法 type 应被拒绝。"""
    with pytest.raises(Exception):
        validate_event('{"type":"not_a_real_event"}')
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_events.py -v -k "text_block or thinking or tool_use or tool_result or usage or message_start or content_block or message_delta or message_stop or error_event or validate_event"
# 预期：ImportError(events 模块不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/protocol/events.py
"""Anthropic Messages SSE 风格事件定义。

经 anthropic-sdk-python/src/anthropic/types/raw_message_stream_event.py 验证:
discriminated union 写法正确(官方用 PropertyInfo,我们用 Field,语义等价)。

对应 V2 spec §5(协议事件定义)。
"""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter

from app.services.ai.protocol.errors import ProtocolError


# ── content blocks ──

class TextBlock(BaseModel):
    type: Literal["text"] = "text"


class ThinkingBlock(BaseModel):
    type: Literal["thinking"] = "thinking"


class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    id: str
    name: str
    input: dict = Field(default_factory=dict)


class ToolResultBlock(BaseModel):
    """工具返回结果(本仓库扩展,Anthropic 官方不显式发)。"""
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


ContentBlock = Annotated[
    Union[TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock],
    Field(discriminator="type"),
]


# ── deltas ──

class TextDelta(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class ThinkingDelta(BaseModel):
    type: Literal["thinking_delta"] = "thinking_delta"
    text: str


class InputJSONDelta(BaseModel):
    type: Literal["input_json_delta"] = "input_json_delta"
    partial_json: str


Delta = Annotated[
    Union[TextDelta, ThinkingDelta, InputJSONDelta],
    Field(discriminator="type"),
]


# ── events ──

class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class MessageStart(BaseModel):
    type: Literal["message_start"] = "message_start"
    message_id: str
    model: str
    role: Literal["assistant"] = "assistant"
    created_at: int  # unix ms


class ContentBlockStart(BaseModel):
    type: Literal["content_block_start"] = "content_block_start"
    index: int
    content_block: ContentBlock


class ContentBlockDelta(BaseModel):
    type: Literal["content_block_delta"] = "content_block_delta"
    index: int
    delta: Delta


class ContentBlockStop(BaseModel):
    type: Literal["content_block_stop"] = "content_block_stop"
    index: int


class MessageDelta(BaseModel):
    type: Literal["message_delta"] = "message_delta"
    usage: Usage
    stop_reason: Literal["end_turn", "tool_use", "cancelled", "refusal"] | None = None


class MessageStop(BaseModel):
    type: Literal["message_stop"] = "message_stop"


class Ping(BaseModel):
    type: Literal["ping"] = "ping"


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    error: ProtocolError


ProtocolEvent = Annotated[
    Union[
        MessageStart,
        ContentBlockStart,
        ContentBlockDelta,
        ContentBlockStop,
        MessageDelta,
        MessageStop,
        Ping,
        ErrorEvent,
    ],
    Field(discriminator="type"),
]


# TypeAdapter:从 JSON 解析 ProtocolEvent(Union 类型别名不能直接 model_validate_json)
_event_adapter = TypeAdapter(ProtocolEvent)


def validate_event(data: str | bytes) -> ProtocolEvent:
    """从 JSON 字符串/字节解析 ProtocolEvent。"""
    return _event_adapter.validate_json(data)
```

更新 `__init__.py`:

```python
# backend/app/services/ai/protocol/__init__.py
"""AI Chat 协议层 — Anthropic Messages SSE 风格事件定义。

纯定义模块:不依赖 Redis / FastAPI / Pydantic AI。
经 Anthropic 官方 SDK 验证写法正确(raw_message_stream_event.py)。
"""
from app.services.ai.protocol.errors import ErrorCode, ProtocolError
from app.services.ai.protocol.events import (
    ContentBlock,
    ContentBlockDelta,
    ContentBlockStart,
    ContentBlockStop,
    Delta,
    ErrorEvent,
    InputJSONDelta,
    MessageDelta,
    MessageStart,
    MessageStop,
    Ping,
    ProtocolEvent,
    TextBlock,
    TextDelta,
    ThinkingBlock,
    ThinkingDelta,
    ToolResultBlock,
    ToolUseBlock,
    Usage,
    validate_event,
)

__all__ = [
    "ErrorCode", "ProtocolError",
    "ContentBlock", "Delta", "ProtocolEvent",
    "TextBlock", "ThinkingBlock", "ToolUseBlock", "ToolResultBlock",
    "TextDelta", "ThinkingDelta", "InputJSONDelta",
    "Usage",
    "MessageStart", "ContentBlockStart", "ContentBlockDelta",
    "ContentBlockStop", "MessageDelta", "MessageStop", "Ping", "ErrorEvent",
    "validate_event",
]
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_events.py -v
# 预期：全部 passed
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/protocol/ backend/tests/protocol/
git commit -m "feat(ai-protocol): ProtocolEvent discriminated union + ContentBlock/Delta(V2 Phase A2)"
```

---

### 任务 A3:SSE 编码器

**文件：**
- 创建：`backend/app/services/ai/protocol/encoder.py`
- 创建：`backend/tests/protocol/test_encoder.py`

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/protocol/test_encoder.py
"""SSE 编码器单测。"""
from app.services.ai.protocol.encoder import encode_sse
from app.services.ai.protocol.events import (
    ContentBlockDelta,
    ContentBlockStart,
    MessageStart,
    MessageStop,
    Ping,
    TextBlock,
    TextDelta,
    Usage,
    MessageDelta,
)
from app.services.ai.protocol.errors import ErrorCode, ProtocolError, ErrorEvent


def test_encode_message_start():
    ev = MessageStart(message_id="msg_1", model="gpt-4", created_at=1719897600000)
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert text.startswith("data: ")
    assert '"type":"message_start"' in text
    assert text.endswith("\n\n")  # SSE 空行分隔


def test_encode_with_entry_id():
    """携带 entry_id 时输出 id: 行。"""
    ev = Ping()
    result = encode_sse(ev, entry_id="1719897600000-0")
    text = result.decode("utf-8")
    assert text.startswith("id: 1719897600000-0\ndata: ")
    assert text.endswith("\n\n")


def test_encode_content_block_delta():
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="hello"))
    result = encode_sse(ev, entry_id="123-0")
    text = result.decode("utf-8")
    assert '"type":"content_block_delta"' in text
    assert '"text":"hello"' in text
    assert "id: 123-0" in text


def test_encode_message_stop():
    ev = MessageStop()
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"type":"message_stop"' in text


def test_encode_error_event():
    err = ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
    ev = ErrorEvent(error=err)
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"type":"error"' in text
    assert '"code":"cancelled"' in text
    assert '"message":"用户取消"' in text


def test_encode_message_delta_with_usage():
    ev = MessageDelta(usage=Usage(input_tokens=10, output_tokens=5, total_tokens=15), stop_reason="end_turn")
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert '"stop_reason":"end_turn"' in text
    assert '"total_tokens":15' in text


def test_encode_no_entry_id():
    """无 entry_id 时不输出 id: 行。"""
    ev = MessageStop()
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert not text.startswith("id:")
    assert text.startswith("data: ")


def test_encode_unicode():
    """中文内容正确编码(非转义)。"""
    ev = ContentBlockDelta(index=0, delta=TextDelta(text="你好世界"))
    result = encode_sse(ev)
    text = result.decode("utf-8")
    assert "你好世界" in text
    assert "\\u" not in text  # 非 ASCII 转义
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_encoder.py -v
# 预期：ImportError(encoder 模块不存在)
```

- [ ] **步骤 3：编写实现**

```python
# backend/app/services/ai/protocol/encoder.py
"""SSE 编码器 — ProtocolEvent → bytes。

格式(Anthropic Messages SSE 风格):
    id: {entry_id}\n        ← 可选(有 entry_id 时,供 Last-Event-ID 重连)
    data: {json}\n
    \n                      ← 空行分隔事件

对应 V2 spec §5.1(传输)。
"""
from __future__ import annotations

from app.services.ai.protocol.events import ProtocolEvent


def encode_sse(event: ProtocolEvent, entry_id: str | None = None) -> bytes:
    """把 ProtocolEvent 编码为 SSE 帧 bytes。"""
    payload = event.model_dump_json()  # ensure_ascii=False 默认
    parts: list[str] = []
    if entry_id is not None:
        parts.append(f"id: {entry_id}")
    parts.append(f"data: {payload}")
    parts.append("")  # 空行
    return ("\n".join(parts) + "\n").encode("utf-8")
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/protocol/test_encoder.py -v
# 预期：8 passed
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/services/ai/protocol/encoder.py backend/tests/protocol/test_encoder.py
git commit -m "feat(ai-protocol): SSE encoder(V2 Phase A3)"
```

---

## Phase A 完成标准

- [ ] `tests/protocol/test_events.py` 全部 passed
- [ ] `tests/protocol/test_encoder.py` 全部 passed
- [ ] `app/services/ai/protocol/__init__.py` 可 import,无循环依赖
- [ ] protocol 模块不 import redis / fastapi / pydantic_ai(纯 pydantic)
