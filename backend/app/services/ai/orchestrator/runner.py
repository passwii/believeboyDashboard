"""StreamRunner — 编排器核心。

解耦 agent 执行与 HTTP 订阅,经 Redis Stream 中转事件。

- run():       asyncio.create_task 后台执行 agent.iter();事件 xadd 到 Stream
- subscribe(): AsyncGenerator,从 Stream xread,编码为 SSE bytes
- cancel():    GETDEL live_key → agent 下次 is_live() 检测到 → raise

对应 V2 spec §6.2、§9(agent.iter node 模型)。
Spike 验证:openSourceProjects/ai-app-layer-spike/spike/runner.py
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any, AsyncGenerator

from pydantic_ai import Agent
from pydantic_ai.messages import (
    PartStartEvent, PartDeltaEvent, PartEndEvent,
    TextPart, ThinkingPart, ToolCallPart, ToolReturnPart,
    TextPartDelta, ThinkingPartDelta,
)

from app.services.ai.observability.logger import log_stream_event
from app.services.ai.orchestrator.cancel import CancelRegistry
from app.services.ai.orchestrator.stream_bus import RedisStreamBus
from app.services.ai.protocol.encoder import encode_sse
from app.services.ai.protocol.errors import ErrorCode, ProtocolError
from app.services.ai.protocol.events import (
    ContentBlockStart, ContentBlockDelta, ContentBlockStop,
    ErrorEvent, MessageDelta, MessageStart, MessageStop,
    ProtocolEvent, StreamResult, TextBlock, TextDelta,
    ThinkingBlock, ThinkingDelta, ToolUseBlock, ToolResultBlock,
    Usage, validate_event,
)
from app.services.ai.search import extract_search_meta_from_messages

logger = logging.getLogger(__name__)


class CancelledError(Exception):
    """用户主动取消时使用。"""
    pass


class StreamRunner:
    """编排器:解耦 agent 执行与 HTTP 订阅。"""

    def __init__(self, bus: RedisStreamBus, cancel_registry: CancelRegistry):
        self._bus = bus
        self._cancel = cancel_registry

    async def run(
        self,
        conv_id: int,
        agent: Agent,
        user_prompt: str,
        message_history: list | None = None,
        model_name: str = "unknown",
    ) -> None:
        """后台执行 agent。事件写入 Redis Stream。"""
        message_id = str(uuid.uuid4())
        created_at = int(time.time() * 1000)

        try:
            await self._cancel.register(conv_id)
            await self._bus.start(conv_id)
        except Exception as exc:
            # Redis 不可用时无法写 Stream；直接退出，subscriber 侧
            # 的 xread 也会因连接失败而抛异常 → endpoint 返回 ErrorEvent。
            logger.error("Stream %s: Redis setup failed: %s", conv_id, exc)
            return

        # 取消检查点 0:agent 开始前
        await asyncio.sleep(0)
        if not await self._cancel.is_live(conv_id):
            await self._emit_cancelled(conv_id)
            return

        try:
            await self._bus.add(conv_id, MessageStart(
                message_id=message_id, model=model_name, created_at=created_at,
            ))

            text_parts: list[str] = []
            async with agent.iter(
                user_prompt, message_history=message_history or [],
            ) as agent_run:
                async for node in agent_run:
                    if not await self._cancel.is_live(conv_id):
                        raise CancelledError()
                    if not Agent.is_model_request_node(node):
                        continue
                    async with node.stream(agent_run.ctx) as node_stream:
                        async for event in node_stream:
                            # 累积 text delta → full_text(与旧端点 final_content 口径一致)
                            if (
                                isinstance(event, PartDeltaEvent)
                                and isinstance(event.delta, TextPartDelta)
                                and event.delta.content_delta
                            ):
                                text_parts.append(event.delta.content_delta)
                            mapped = _map_node_event(event)
                            if mapped:
                                if isinstance(mapped, list):
                                    for ev in mapped:
                                        await self._bus.add(conv_id, ev)
                                else:
                                    await self._bus.add(conv_id, mapped)

            usage = _extract_usage(agent_run)
            await self._bus.add(conv_id, MessageDelta(usage=usage, stop_reason="end_turn"))

            # Phase 1.2:业务载荷(供 endpoint 持久化,不转发客户端)。
            # source cards / time_range 从最终消息列表还原(工具结果未被截断)。
            source_cards, time_range, _query = extract_search_meta_from_messages(
                agent_run.result.all_messages()
            )
            await self._bus.add(conv_id, StreamResult(
                full_text="".join(text_parts).strip(),
                search_source_cards=source_cards,
                search_time_range=time_range,
                usage=usage,
            ))

        except CancelledError:
            await self._emit_cancelled(conv_id)
            return

        except Exception as exc:
            logger.exception("Stream %s crashed: %s", conv_id, exc)
            error = classify_error(exc)
            log_stream_event(conv_id, "error", code=error.code.value, message=error.message)
            await self._bus.add(conv_id, ErrorEvent(error=error))

        finally:
            await self._bus.add(conv_id, MessageStop())
            await self._bus.stop(conv_id)

    async def _emit_cancelled(self, conv_id: int) -> None:
        """发 cancelled error + message_stop + 关流。"""
        logger.info("Stream %s cancelled by user", conv_id)
        log_stream_event(conv_id, "cancelled")
        await self._bus.add(conv_id, ErrorEvent(
            error=ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
        ))
        await self._bus.add(conv_id, MessageStop())
        await self._bus.stop(conv_id)

    async def subscribe_events(
        self, conv_id: int, from_id: str = "0"
    ) -> AsyncGenerator[tuple[ProtocolEvent, str], None]:
        """从 Redis Stream 读取并解析事件,yield (event, entry_id)。

        endpoint 用此方法:可区分内部 stream_result(持久化用,不转发)与客户端事件。
        只在 MessageStop 时停止(ErrorEvent 后仍有 MessageStop)。
        """
        async for entry_id, entry_type, data_json in self._bus.listen(conv_id, from_id):
            if entry_type == "begin":
                continue
            if entry_type == "end":
                break
            if entry_type in ("event", "error"):
                event = validate_event(data_json)
                yield event, entry_id
                if isinstance(event, MessageStop):
                    break

    async def subscribe(
        self, conv_id: int, from_id: str = "0"
    ) -> AsyncGenerator[bytes, None]:
        """HTTP 简单订阅:编码为 SSE bytes,跳过内部 stream_result 事件。"""
        async for event, entry_id in self.subscribe_events(conv_id, from_id):
            if isinstance(event, StreamResult):
                continue
            yield encode_sse(event, entry_id=entry_id)

    async def cancel(self, conv_id: int) -> bool:
        """取消:GETDEL live_key。"""
        return await self._cancel.request_cancel(conv_id)


# ── node event → ProtocolEvent 映射 ──

def _map_node_event(event: Any) -> ProtocolEvent | list[ProtocolEvent] | None:
    """把 pydantic-ai node stream event 映射为 ProtocolEvent。对应 spec §9.3。"""
    if isinstance(event, PartStartEvent):
        part = event.part
        if isinstance(part, TextPart):
            return ContentBlockStart(index=event.index, content_block=TextBlock())
        if isinstance(part, ThinkingPart):
            return ContentBlockStart(index=event.index, content_block=ThinkingBlock())
        if isinstance(part, ToolCallPart):
            return ContentBlockStart(
                index=event.index,
                content_block=ToolUseBlock(
                    id=getattr(part, "tool_call_id", str(event.index)),
                    name=part.tool_name,
                    input=part.args if isinstance(part.args, dict) else {},
                ),
            )
        if isinstance(part, ToolReturnPart):
            return [
                ContentBlockStart(
                    index=event.index,
                    content_block=ToolResultBlock(
                        tool_use_id=getattr(part, "tool_call_id", ""),
                        content=str(part.content)[:500],
                        is_error=False,
                    ),
                ),
                ContentBlockStop(index=event.index),
            ]
        return None

    if isinstance(event, PartDeltaEvent):
        delta = event.delta
        if isinstance(delta, TextPartDelta) and delta.content_delta:
            return ContentBlockDelta(index=event.index, delta=TextDelta(text=delta.content_delta))
        if isinstance(delta, ThinkingPartDelta) and delta.content_delta:
            return ContentBlockDelta(index=event.index, delta=ThinkingDelta(text=delta.content_delta))
        return None

    if isinstance(event, PartEndEvent):
        return ContentBlockStop(index=event.index)

    return None


def _extract_usage(agent_run: Any) -> Usage:
    try:
        usage = agent_run.result.usage
        return Usage(
            input_tokens=getattr(usage, "input_tokens", 0),
            output_tokens=getattr(usage, "output_tokens", 0),
            total_tokens=getattr(usage, "total_tokens", 0),
        )
    except Exception:
        return Usage()


def classify_error(exc: Exception) -> ProtocolError:
    """异常 → typed ProtocolError。对应 spec §10.2。"""
    if isinstance(exc, CancelledError):
        return ProtocolError(code=ErrorCode.CANCELLED, message="用户取消")
    if isinstance(exc, asyncio.TimeoutError):
        return ProtocolError(code=ErrorCode.TIMEOUT, message="LLM 响应超时")
    return ProtocolError(code=ErrorCode.INTERNAL, message=str(exc) or "内部错误")
