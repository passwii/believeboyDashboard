"""AI Chat V2 Endpoints — 执行/分发解耦 + Redis Stream + Anthropic SSE 协议。

对应 V2 spec §6(编排器)、§7(SSE 端点)、§8(取消)、§11(重连)。
旧端点保留在 ai_chat.py,Phase D 删除。
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, protected
from app.core.config import Settings, get_settings
from app.schemas.ai_chat import MessageCreate
from app.services import ai as ai_chat_service
from app.services.ai.chat import DEFAULT_CONVERSATION_TITLE
from app.services.ai.agent import build_chat_agent

# V2 编排器
from app.services.ai.orchestrator.runner import StreamRunner
from app.services.ai.orchestrator.stream_bus import RedisStreamBus
from app.services.ai.orchestrator.cancel import RedisCancelRegistry
from app.services.ai.protocol.events import (
    ErrorEvent,
    MessageStop,
    StreamResult,
)
from app.services.ai.protocol.errors import ErrorCode, ProtocolError
from app.services.ai.protocol.encoder import encode_sse

# 复用旧端点的 DB 准备逻辑(Phase D 迁移到独立模块)
from app.api.v1.endpoints.ai_chat import (
    _get_request_user_id,
    _prepare_conversation_turn,
    _prompt_messages_to_pydantic_ai_args,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai-v2"], dependencies=[Depends(protected)])

# ── 模块级 StreamRunner(懒初始化) ──

_runner: StreamRunner | None = None


def get_runner() -> StreamRunner:
    """懒初始化 StreamRunner(首次调用时创建 Redis 连接)。"""
    global _runner
    if _runner is None:
        from app.db.redis import create_redis_client

        settings = get_settings()
        # 使用带连接池的 async 单例（db 由 ai_chat_redis_db 指定）
        redis = create_redis_client(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password,
            db=settings.ai_chat_redis_db,
        )
        bus = RedisStreamBus(redis)
        cancel = RedisCancelRegistry(redis)
        _runner = StreamRunner(bus=bus, cancel_registry=cancel)
    return _runner


# ── V2 流式端点 ──


@router.post("/conversations/{conversation_id}/messages/stream")
async def stream_message_v2(
    request: Request,
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
):
    """V2 SSE 流式对话端点。

    架构:agent 在后台 asyncio.Task 中执行,事件经 Redis Stream 中转,
    本端点仅订阅 + 编码 SSE。执行与 HTTP 交付完全解耦。

    重连:客户端传 Last-Event-ID header,从该 ID 之后续传。
    """
    runner = get_runner()

    # ── 重连路径:直接从 Redis Stream 续传 ──
    if last_event_id:
        return StreamingResponse(
            _resume_stream(runner, conversation_id, last_event_id, request),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    # ── 首次请求路径 ──
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    history = ai_chat_service.list_messages(db, conversation_id, user_id)
    user_content = payload.content.strip()
    regenerate = payload.regenerate

    if regenerate and not payload.enable_web_search:
        raise HTTPException(status_code=400, detail="重新生成仅在启用联网搜索时支持")

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

    agent = build_chat_agent(
        settings,
        model_name=payload.model,
        web_search=payload.enable_web_search,
    )
    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args(prompt_messages)

    # 后台执行 agent(事件写入 Redis Stream)
    asyncio.create_task(
        runner.run(
            conv_id=conversation_id,
            agent=agent,
            user_prompt=user_prompt,
            message_history=message_history,
            model_name=payload.model or "unknown",
        )
    )

    return StreamingResponse(
        _first_request_stream(
            runner=runner,
            conversation_id=conversation_id,
            request=request,
            db=db,
            settings=settings,
            conversation=conversation,
            user_row=user_row,
            assistant_row=assistant_row,
            target_assistant=target_assistant,
            user_content=user_content,
            regenerate=regenerate,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


async def _first_request_stream(
    *,
    runner: StreamRunner,
    conversation_id: int,
    request: Request,
    db: Session,
    settings: Settings,
    conversation,
    user_row,
    assistant_row,
    target_assistant,
    user_content: str,
    regenerate: bool,
):
    """首次请求:订阅 Redis Stream,yield SSE,StreamResult 时做 DB 收尾。"""
    from app.services.ai.stream_utils import serialize_message

    try:
        async for event, entry_id in runner.subscribe_events(
            conversation_id, from_id="0"
        ):
            # 客户端断连 → 取消
            if await request.is_disconnected():
                await runner.cancel(conversation_id)
                break

            # 内部事件:StreamResult → DB 收尾 + 发 done(不转发 StreamResult 本身)
            if isinstance(event, StreamResult):
                done_payload = await _finalize_db(
                    db=db,
                    settings=settings,
                    conversation=conversation,
                    assistant_row=assistant_row,
                    user_row=user_row,
                    target_assistant=target_assistant,
                    stream_result=event,
                    user_content=user_content,
                    regenerate=regenerate,
                )
                if done_payload:
                    # 项目扩展:done 事件(兼容前端,携带持久化数据)
                    yield _encode_done_sse(done_payload)
                continue

            # 客户端事件 → SSE
            yield encode_sse(event, entry_id=entry_id)

            if isinstance(event, MessageStop):
                break

    except Exception:
        logger.exception("V2 stream %s failed", conversation_id)
        db.rollback()
        yield encode_sse(
            ErrorEvent(error=ProtocolError(code=ErrorCode.INTERNAL, message="内部错误"))
        )


async def _resume_stream(
    runner: StreamRunner,
    conversation_id: int,
    from_id: str,
    request: Request,
):
    """重连:从 last_event_id 之后续传,跳过内部事件。"""
    async for chunk in runner.subscribe(conversation_id, from_id=from_id):
        if await request.is_disconnected():
            break
        yield chunk


async def _finalize_db(
    *,
    db: Session,
    settings: Settings,
    conversation,
    assistant_row,
    user_row,
    target_assistant,
    stream_result: StreamResult,
    user_content: str,
    regenerate: bool,
) -> dict | None:
    """DB 收尾:保存内容、更新 token 统计、自动生成标题。

    返回 done payload(供 SSE done 事件),失败返回 None。
    幂等:如果 assistant_row 已有内容(重连场景),跳过。
    """
    from app.services.ai.stream_utils import serialize_message

    try:
        # ⚠️ 必须在任何 db.commit() 之前序列化 user message 快照。
        # regenerate 路径中 target_assistant 已被 db.delete()+flush()，
        # commit 后 session expire → 再访问属性会 DetachedInstanceError。
        user_msg_snapshot = serialize_message(
            target_assistant if regenerate else user_row
        )

        # 幂等守卫:重连时不重复写
        if assistant_row.content:
            return None

        final_content = stream_result.full_text or ""
        ai_chat_service.update_message_content(db, assistant_row.id, final_content)

        if stream_result.search_source_cards:
            assistant_row.search_sources = json.dumps(
                stream_result.search_source_cards, ensure_ascii=False
            )
        if stream_result.search_time_range:
            assistant_row.search_time_range = stream_result.search_time_range

        usage = stream_result.usage
        ai_chat_service.mark_message_complete(
            db,
            assistant_row.id,
            prompt_tokens=usage.input_tokens if usage else 0,
            completion_tokens=usage.output_tokens if usage else 0,
            total_tokens=usage.total_tokens if usage else 0,
        )
        conversation.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(assistant_row)
        ai_chat_service.recalculate_conversation_token_stats(db, conversation.id)
        db.commit()

        # 首轮自动生成标题
        title_regenerated = False
        if (
            not regenerate
            and conversation.title == DEFAULT_CONVERSATION_TITLE
            and final_content
        ):
            try:
                generated = await asyncio.to_thread(
                    ai_chat_service.generate_conversation_title,
                    settings,
                    user_content,
                    final_content,
                )
            except Exception:
                logger.warning("V2 autotitle failed; keep default", exc_info=True)
                generated = None
            if generated:
                conversation.title = generated
                db.commit()
                title_regenerated = True

        # 构建 done payload(兼容旧前端协议)
        return {
            "type": "done",
            "user_message": user_msg_snapshot,
            "assistant_message": serialize_message(assistant_row),
            "conversation_title": conversation.title,
            "token_usage": {
                "prompt_tokens": usage.input_tokens if usage else 0,
                "completion_tokens": usage.output_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            }
            if usage
            else None,
            "conversation_token_usage": {
                "prompt_tokens": conversation.total_prompt_tokens,
                "completion_tokens": conversation.total_completion_tokens,
                "total_tokens": conversation.total_tokens,
            },
            "duration_ms": None,
            "title_regenerated": title_regenerated,
        }

    except Exception:
        logger.exception("V2 DB finalize failed for conv %s", conversation.id)
        db.rollback()
        return None


def _encode_done_sse(payload: dict) -> bytes:
    """编码 done 事件为 SSE 格式(项目扩展,非 Anthropic 标准)。"""
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {data}\n\n".encode("utf-8")


# ── V2 取消端点 ──


@router.post("/conversations/{conversation_id}/cancel")
async def cancel_stream_v2(
    conversation_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
):
    """V2 取消:GETDEL live_key,跨 worker 生效。"""
    ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    runner = get_runner()
    cancelled = await runner.cancel(conversation_id)
    return {"cancelled": cancelled}
