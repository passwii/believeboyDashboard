# AI 应用层 V2 · Phase C:端点重写 + 前端协议层

> **父计划：** [`2026-07-19-ai-application-layer-v2.md`](./2026-07-19-ai-application-layer-v2.md)
> **承接 spec：** §7(取消协议)、§8(断连重连)、§11(前端模块结构)
> **依赖：** Phase A(protocol)+ Phase B(orchestrator)

**目标：** 重写后端 stream 端点(调 StreamRunner)+ 重写前端 protocol codec + useChatStream(接 /cancel + resume)。

**非目标：**
- 不删旧代码(Phase D)
- 不做 Playwright e2e(Phase D)
- 不改 UI 视觉

---

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 重写 | `backend/app/api/v1/endpoints/ai_chat.py` | stream_message 调 StreamRunner;cancel_stream 调 runner.cancel |
| 创建 | `frontend/components/chat/protocol/index.ts` | 前端协议层入口 |
| 创建 | `frontend/components/chat/protocol/events.ts` | TS union types |
| 创建 | `frontend/components/chat/protocol/codec.ts` | SSE 解析 |
| 创建 | `frontend/components/chat/protocol/errors.ts` | ErrorCode + 重试策略 |
| 重写 | `frontend/components/chat/hooks/use-chat-stream.ts` | protocol codec + /cancel + resume |
| 重写 | `frontend/lib/api/ai-chat-stream.ts` | consumeStream 基于 codec |
| 修改 | `frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts` | Content-Type + Last-Event-ID 透传 |
| 创建 | `frontend/lib/api/__tests__/ai-chat-stream.test.ts` | codec 单测 |

---

## 任务

### 任务 C1:后端端点重写(stream_message + cancel_stream)

**文件：**
- 修改：`backend/app/api/v1/endpoints/ai_chat.py`(:311-468 stream_message + :613-628 cancel_stream)

> 本任务把现有 stream_message(直接跑 agent + yield ndjson)替换为调 StreamRunner(后台跑 agent + 订阅 Redis Stream + yield SSE)。保留旧代码在文件中但不挂路由(feature flag),Phase D 删除。

- [ ] **步骤 1：编写失败的测试**

```python
# backend/tests/api/test_ai_chat_stream_v2.py
"""AI Chat V2 流式端点 e2e。

覆盖:
1. happy path: SSE 事件序列(message_start → content_block_* → message_stop)
2. 取消: POST /cancel → error{cancelled}
3. resume: Last-Event-ID → 续传
4. Content-Type: text/event-stream
"""
from __future__ import annotations

import asyncio
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app
from app.services import ai as ai_chat_service


@pytest.fixture
def api_key():
    from app.core.config import get_settings
    return get_settings().api_key


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def db_session():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def patched_runner(monkeypatch):
    """把端点的 StreamRunner 替换为用 fakeredis 的实例。"""
    import fakeredis.aioredis
    from app.services.ai.orchestrator.stream_bus import RedisStreamBus
    from app.services.ai.orchestrator.cancel import RedisCancelRegistry
    from app.services.ai.orchestrator.runner import StreamRunner
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    redis = fakeredis.aioredis.FakeRedis()
    bus = RedisStreamBus(redis)
    cancel_reg = RedisCancelRegistry(redis)
    runner = StreamRunner(bus=bus, cancel_registry=cancel_reg)

    def fake_build(settings, *, model_name=None, web_search=False, **_):
        return Agent(
            model=TestModel(custom_output_text="V2 测试回复。"),
            capabilities=[Thinking()],
            tools=[],
        )

    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)
    monkeypatch.setattr("app.api.v1.endpoints.ai_chat._stream_runner", runner)
    return runner


def _create_conversation(db_session, user_id=42):
    from app.models.ai_chat import AIConversation
    row = AIConversation(user_id=user_id, title="t")
    db_session.add(row)
    db_session.commit()
    return row.id


def _parse_sse_events(body: str):
    """从 SSE body 解析事件列表。"""
    events = []
    current_id = None
    for block in body.split("\n\n"):
        if not block.strip():
            continue
        event_id = None
        data_line = None
        for line in block.split("\n"):
            if line.startswith("id: "):
                event_id = line[4:].strip()
            elif line.startswith("data: "):
                data_line = line[6:]
        if data_line:
            import json
            events.append({"id": event_id, "data": json.loads(data_line)})
    return events


# ─── 测试 1: happy path ──

def test_stream_v2_emits_anthropic_sse_events(patched_runner, client, db_session, api_key):
    """POST /stream → text/event-stream;事件序列 message_start → content_block_* → message_stop。"""
    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "你好", "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    events = _parse_sse_events(body)
    types = [e["data"].get("type") for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"
    assert "content_block_delta" in types


# ─── 测试 2: 取消 ──

def test_cancel_v2_returns_cancelled(patched_runner, client, db_session, api_key):
    """POST /cancel → {"cancelled": true}。"""
    conv_id = _create_conversation(db_session)
    # 先启动一个流(后台),再取消
    # 注意:TestClient 同步,这里只验证 cancel 端点返回
    resp = client.post(
        f"/api/v1/ai/conversations/{conv_id}/stream/cancel",
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    )
    # 没有活跃流时返回 cancelled: false
    assert resp.status_code == 200
    assert "cancelled" in resp.json()
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_v2.py -v
# 预期：FAIL(端点还没改成调 StreamRunner)
```

- [ ] **步骤 3：编写实现**

在 `backend/app/api/v1/endpoints/ai_chat.py` 中:

1. 在文件顶部追加 import:
```python
from app.services.ai.orchestrator.runner import StreamRunner
from app.services.ai.orchestrator.stream_bus import RedisStreamBus
from app.services.ai.orchestrator.cancel import RedisCancelRegistry
from app.db.redis import create_redis_client

# 模块级 StreamRunner(生产用;测试 monkeypatch 替换)
_stream_runner: StreamRunner | None = None


def _get_stream_runner() -> StreamRunner:
    """获取或创建模块级 StreamRunner。"""
    global _stream_runner
    if _stream_runner is None:
        from app.core.config import get_settings
        settings = get_settings()
        redis = create_redis_client(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password,
            db=settings.ai_chat_redis_db,
        )
        bus = RedisStreamBus(redis)
        cancel_reg = RedisCancelRegistry(redis)
        _stream_runner = StreamRunner(bus=bus, cancel_registry=cancel_reg)
    return _stream_runner
```

2. 重写 `stream_message` 端点(:313-468):

```python
@router.post("/conversations/{conversation_id}/messages/stream")
async def stream_message(
    request: Request,
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
):
    """SSE 流式对话端点(V2:执行/分发解耦 + Anthropic Messages SSE)。

    - 首次请求(无 Last-Event-ID):启动 StreamRunner.run() 后台执行
    - 重连(有 Last-Event-ID):不启动新 agent,从该 offset 续传
    - 取消:独立 POST /cancel 端点
    """
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)

    is_resume = last_event_id is not None and last_event_id != ""
    runner = _get_stream_runner()

    if not is_resume:
        # 首次请求:准备对话上下文 + 启动 agent
        history = ai_chat_service.list_messages(db, conversation_id, user_id)
        user_content = payload.content.strip()
        regenerate = payload.regenerate

        if regenerate and not payload.enable_web_search:
            raise HTTPException(status_code=400, detail="重新生成仅在启用联网搜索时支持")

        prompt_messages, _, user_row, assistant_row, _ = _prepare_conversation_turn(
            db=db, conversation_id=conversation_id, history=history,
            payload=payload, user_content=user_content, regenerate=regenerate,
        )
        db.commit()

        user_prompt, message_history = _prompt_messages_to_pydantic_ai_args(prompt_messages)
        agent = build_chat_agent(settings, model_name=payload.model, web_search=payload.enable_web_search)

        # 后台启动 agent
        asyncio.create_task(runner.run(
            conv_id=conversation_id,
            agent=agent,
            user_prompt=user_prompt,
            message_history=message_history,
            model_name=payload.model or settings.ai_chat_default_model,
        ))
        from_id = "0"
    else:
        from_id = last_event_id

    async def event_stream():
        try:
            async for chunk in runner.subscribe(conversation_id, from_id=from_id):
                if await request.is_disconnected():
                    await runner.cancel(conversation_id)
                    break
                yield chunk
        finally:
            pass  # DB 收尾在 runner.run() 内部(to_thread)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
```

3. 重写 `cancel_stream` 端点(:613-628):

```python
@router.post("/conversations/{conversation_id}/stream/cancel")
async def cancel_stream(
    conversation_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
):
    """请求取消正在进行的流式生成。跨 worker 生效(GETDEL live_key)。"""
    ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    runner = _get_stream_runner()
    cancelled = await runner.cancel(conversation_id)
    return {"cancelled": cancelled}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd backend && ./.venv/bin/pytest tests/api/test_ai_chat_stream_v2.py -v
# 预期：PASS
```

- [ ] **步骤 5：Commit**

```bash
git add backend/app/api/v1/endpoints/ai_chat.py backend/tests/api/test_ai_chat_stream_v2.py
git commit -m "feat(ai-chat): V2 stream endpoint — StreamRunner + SSE + resume(V2 Phase C1)"
```

---

### 任务 C2:前端 protocol 屨(TS types + codec + errors)

**文件：**
- 创建：`frontend/components/chat/protocol/events.ts`
- 创建：`frontend/components/chat/protocol/codec.ts`
- 创建：`frontend/components/chat/protocol/errors.ts`
- 创建：`frontend/components/chat/protocol/index.ts`
- 创建：`frontend/lib/api/__tests__/ai-chat-stream.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// frontend/lib/api/__tests__/ai-chat-stream.test.ts
import { describe, it, expect } from 'vitest'
import { parseSSEChunk } from '@/components/chat/protocol/codec'
import type { ProtocolEvent } from '@/components/chat/protocol/events'

describe('parseSSEChunk', () => {
  it('parses single event with data', () => {
    const chunk = 'data: {"type":"message_start","message_id":"m1","model":"gpt-4","role":"assistant","created_at":1700000000000}\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].event.type).toBe('message_start')
    expect(events[0].id).toBeNull()
  })

  it('parses event with id', () => {
    const chunk = 'id: 1700000000-0\ndata: {"type":"message_stop"}\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe('1700000000-0')
    expect(events[0].event.type).toBe('message_stop')
  })

  it('parses multiple events in one chunk', () => {
    const chunk = 'data: {"type":"ping"}\n\ndata: {"type":"message_stop"}\n\n'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(2)
    expect(events[0].event.type).toBe('ping')
    expect(events[1].event.type).toBe('message_stop')
  })

  it('handles partial line in buffer', () => {
    const chunk = 'data: {"type":"ping"}\n\ndata: {"type":"mess'
    const events = parseSSEChunk(chunk)
    expect(events).toHaveLength(1)  // 只解析完整的
  })

  it('parses error event', () => {
    const chunk = 'data: {"type":"error","error":{"code":"cancelled","message":"用户取消"}}\n\n'
    const events = parseSSEChunk(chunk)
    expect(events[0].event.type).toBe('error')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd frontend && npx vitest run lib/api/__tests__/ai-chat-stream.test.ts
# 预期：FAIL(模块不存在)
```

- [ ] **步骤 3：编写实现**

```typescript
// frontend/components/chat/protocol/errors.ts
export type ErrorCode =
  | 'network' | 'timeout' | 'llm_5xx' | 'llm_4xx' | 'rate_limit'
  | 'content_filter' | 'cancelled' | 'validation' | 'internal'
  | 'persistence' | 'tool_error'

export type ProtocolError = {
  code: ErrorCode
  message: string
  retry_after?: number | null
}

export type RetryStrategy = {
  autoRetry: boolean
  maxRetries: number
  backoffMs: number[]
  showRetryButton: boolean
}

export function getRetryStrategy(code: ErrorCode): RetryStrategy {
  switch (code) {
    case 'network':
      return { autoRetry: true, maxRetries: 3, backoffMs: [1000, 2000, 4000], showRetryButton: true }
    case 'timeout':
      return { autoRetry: true, maxRetries: 1, backoffMs: [30000], showRetryButton: true }
    case 'llm_5xx':
      return { autoRetry: true, maxRetries: 1, backoffMs: [2000], showRetryButton: true }
    case 'rate_limit':
      return { autoRetry: false, maxRetries: 0, backoffMs: [], showRetryButton: true }
    case 'cancelled':
      return { autoRetry: false, maxRetries: 0, backoffMs: [], showRetryButton: false }
    default:
      return { autoRetry: false, maxRetries: 0, backoffMs: [], showRetryButton: true }
  }
}
```

```typescript
// frontend/components/chat/protocol/events.ts
export type ContentBlock =
  | { type: 'text' }
  | { type: 'thinking' }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

export type Delta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }

export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number }

export type ProtocolEvent =
  | { type: 'message_start'; message_id: string; model: string; role: 'assistant'; created_at: number }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'content_block_delta'; index: number; delta: Delta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; usage: Usage; stop_reason: string | null }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: import('./errors').ProtocolError }

export type ParsedSSEEvent = {
  id: string | null
  event: ProtocolEvent
}
```

```typescript
// frontend/components/chat/protocol/codec.ts
import type { ParsedSSEEvent, ProtocolEvent } from './events'

/**
 * Parse a chunk of SSE bytes into a list of complete events.
 * Handles partial lines by keeping the tail in a buffer (caller-managed).
 *
 * SSE format:
 *   id: {entry_id}\n     ← optional
 *   data: {json}\n
 *   \n                   ← empty line separates events
 */
export function parseSSEChunk(chunk: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = []
  const blocks = chunk.split('\n\n')

  for (const block of blocks) {
    if (!block.trim()) continue

    let id: string | null = null
    let dataLine: string | null = null

    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) {
        id = line.slice(4).trim()
      } else if (line.startsWith('data: ')) {
        dataLine = line.slice(6)
      }
    }

    if (dataLine) {
      try {
        const event = JSON.parse(dataLine) as ProtocolEvent
        events.push({ id, event })
      } catch {
        // Malformed JSON — skip
      }
    }
  }

  return events
}
```

```typescript
// frontend/components/chat/protocol/index.ts
export * from './events'
export * from './codec'
export * from './errors'
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd frontend && npx vitest run lib/api/__tests__/ai-chat-stream.test.ts
# 预期：5 passed
```

- [ ] **步骤 5：Commit**

```bash
git add frontend/components/chat/protocol/ frontend/lib/api/__tests__/ai-chat-stream.test.ts
git commit -m "feat(chat): frontend protocol layer — TS types + codec + errors(V2 Phase C2)"
```

---

### 任务 C3:重写 useChatStream + consumeStream

**文件：**
- 重写：`frontend/lib/api/ai-chat-stream.ts`
- 重写：`frontend/components/chat/hooks/use-chat-stream.ts`
- 修改：`frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts`

- [ ] **步骤 1-3：编写实现**

> 由于 useChatStream + consumeStream 是整文件重写,不适用纯 TDD(行为测试在 Phase D e2e)。此处直接写实现,测试在 Phase D 覆盖。

重写 `frontend/lib/api/ai-chat-stream.ts`(核心:consumeStream 基于 codec,存 last-event-id):

```typescript
// frontend/lib/api/ai-chat-stream.ts(关键片段)
import { parseSSEChunk, type ProtocolEvent, type ParsedSSEEvent, getRetryStrategy } from '@/components/chat/protocol'

export type StreamCallbacks = {
  onMessageStart?: (e: Extract<ProtocolEvent, { type: 'message_start' }>) => void
  onContentBlockStart?: (index: number, block: import('@/components/chat/protocol/events').ContentBlock) => void
  onTextDelta?: (index: number, text: string) => void
  onThinkingDelta?: (index: number, text: string) => void
  onContentBlockStop?: (index: number) => void
  onUsage?: (usage: import('@/components/chat/protocol/events').Usage) => void
  onMessageStop?: () => void
  onError?: (code: string, message: string, retryAfter?: number | null) => void
}

export async function consumeStream(
  response: Response,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
  onLastEventId?: (id: string) => void,
): Promise<void> {
  if (!response.ok || !response.body) {
    throw new Error(`流式响应失败 (${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const events = parseSSEChunk(buffer)
      // 保留最后不完整的块
      const lastBreak = buffer.lastIndexOf('\n\n')
      buffer = lastBreak >= 0 ? buffer.slice(lastBreak + 2) : buffer

      for (const { id, event } of events) {
        if (id && onLastEventId) onLastEventId(id)

        switch (event.type) {
          case 'message_start': callbacks.onMessageStart?.(event); break
          case 'content_block_start': callbacks.onContentBlockStart?.(event.index, event.content_block); break
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') callbacks.onTextDelta?.(event.index, event.delta.text)
            else if (event.delta.type === 'thinking_delta') callbacks.onThinkingDelta?.(event.index, event.delta.text)
            break
          case 'content_block_stop': callbacks.onContentBlockStop?.(event.index); break
          case 'message_delta': callbacks.onUsage?.(event.usage); break
          case 'message_stop': try { await reader.cancel() } catch {} return
          case 'error':
            const strategy = getRetryStrategy(event.error.code)
            if (event.error.code !== 'cancelled') {
              callbacks.onError?.(event.error.code, event.error.message, event.error.retry_after)
            }
            return
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw err
  }
}
```

重写 `useChatStream` 关键变化(`stop()` 调 `/cancel` + 存 `lastEventId`):

```typescript
// use-chat-stream.ts 关键片段(V2)
const lastEventIdRef = useRef<string | null>(null)

const stop = useCallback(() => {
  abortRef.current?.abort()
  abortRef.current = null
  // V2: 通知后端取消(乐观,不等 ack)
  const cid = conversationIdRef.current
  if (cid != null) {
    fetch(`/api/ai-chat/conversations/${cid}/stream/cancel`, { method: 'POST' }).catch(() => {})
  }
  setIsStreaming(false)
}, [conversationIdRef])

const send = useCallback(async (content, options) => {
  // ... fetch ...
  const res = await fetch(url, {
    // ... headers ...
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Last-Event-ID': lastEventIdRef.current ?? '',  // V2: resume 支持
    },
    signal: controller.signal,
  })
  await consumeStream(res, streamCallbacks, controller.signal,
    (id) => { lastEventIdRef.current = id }  // V2: 存 last-event-id
  )
}, [])
```

修改 Next.js route handler(`frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts`):

```typescript
// 透传 Last-Event-ID header + 改 Content-Type
const lastEventId = request.headers.get('Last-Event-ID')
const upstream = await fetch(
  `${getBackendBaseUrl()}/api/v1/ai/conversations/${conversationId}/messages/stream`,
  {
    method: 'POST',
    headers: {
      ...buildBackendAuthHeaders(session, { apiKey: apiKeyOrResponse.apiKey, contentType: 'application/json' }),
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),  // V2: 透传
    },
    body: JSON.stringify({ /* ... */ }),
    cache: 'no-store',
  },
)
// ...
return new Response(upstream.body, {
  status: upstream.status,
  headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',  // V2: 从 application/x-ndjson 改
    'Cache-Control': 'no-cache, no-transform',
  },
})
```

- [ ] **步骤 4：验证(手动 + 类型检查)**

```bash
cd frontend && npx tsc --noEmit
# 预期：无类型错误
```

- [ ] **步骤 5：Commit**

```bash
git add frontend/components/chat/hooks/use-chat-stream.ts frontend/lib/api/ai-chat-stream.ts frontend/app/api/ai-chat/conversations/[conversationId]/messages/stream/route.ts
git commit -m "feat(chat): rewrite useChatStream + consumeStream for V2 protocol(V2 Phase C3)"
```

---

## Phase C 完成标准

- [ ] 后端 `test_ai_chat_stream_v2.py` passed(happy + cancel)
- [ ] 前端 codec 单测 passed
- [ ] `npx tsc --noEmit` 无错误
- [ ] 手动验证:curl POST /stream 返回 `text/event-stream` + `message_start` 事件
- [ ] 手动验证:前端能消费 SSE 流(用 TestModel 后端)
