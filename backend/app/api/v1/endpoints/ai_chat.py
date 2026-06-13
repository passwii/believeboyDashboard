"""
AI Chat Endpoints — 瘦化的 endpoint 层。
SSE 流式事件编码逻辑已迁移至 app.services.ai.stream_utils。
"""
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import Settings, get_settings
from app.schemas.ai_chat import (
    AIChatConfigResponse,
    AIChatMessageUpdate,
    ConversationCreate,
    ConversationItem,
    ConversationTitleRegenerateResponse,
    MessageCreate,
    MessageCreateResponse,
    MessageItem,
)
from app.services import ai as ai_chat_service
from app.services.ai import cancel as cancel_registry
from app.services.ai.stream_utils import (
    encode_stream_event,
    serialize_message,
    build_stream_chunk,
    build_stream_done,
    build_stream_error,
    build_stream_sources,
    build_stream_thinking_chunk,
    build_stream_tool_calls,
    build_stream_tool_done,
    build_stream_tool_searching,
    build_stream_usage,
)

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(protected)])


def _get_request_user_id(
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> int | None:
    """从 X-User-Id header 解析当前请求的 user_id。

    解析失败或缺失 → None（service 层将按"无归属"处理：list 返回空，
    get_or_404 一律 404）。前端 proxy 在 `/api/backend/[...path]/route.ts`
    已经基于 NextAuth session 注入该 header。
    """
    if x_user_id is None:
        return None
    try:
        return int(x_user_id.strip())
    except (ValueError, TypeError):
        return None


# ─── 配置 & 会话管理 ─────────────────────────────────────────────────────────


@router.get("/config", response_model=AIChatConfigResponse)
def get_ai_config(settings: Settings = Depends(get_settings)) -> AIChatConfigResponse:
    models, default_model = ai_chat_service.resolve_available_models(settings)
    premium_set = {m.lower() for m in ai_chat_service.get_premium_models(settings)}
    basic_set = {m.lower() for m in ai_chat_service.get_basic_models(settings)}
    reasoning_set = {m.lower() for m in ai_chat_service.get_reasoning_models(settings)}
    premium_visible = [m for m in models if m.lower() in premium_set]
    basic_visible = [m for m in models if m.lower() in basic_set]
    reasoning_visible = [m for m in models if m.lower() in reasoning_set]
    return AIChatConfigResponse(
        provider_configured=ai_chat_service.is_provider_configured(settings),
        web_search_configured=ai_chat_service.is_web_search_configured(settings),
        models=models,
        default_model=default_model,
        premium_models=premium_visible,
        basic_models=basic_visible,
        reasoning_models=reasoning_visible,
        default_reasoning_effort=(
            ai_chat_service.normalize_reasoning_effort(settings.ai_chat_default_reasoning_effort)
            or "medium"
        ),
        timeout_seconds=settings.ai_chat_timeout_seconds,
        max_conversation_turns=settings.ai_chat_max_conversation_turns,
        web_search_max_results=settings.ai_chat_web_search_max_results,
    )


@router.get("/conversations", response_model=list[ConversationItem])
def list_conversations(
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> list[ConversationItem]:
    ai_chat_service.ensure_tables(db)
    rows = ai_chat_service.list_conversations(db, user_id)
    return [
        ConversationItem(
            id=row.id, title=row.title,
            created_at=row.created_at, updated_at=row.updated_at,
            total_prompt_tokens=row.total_prompt_tokens,
            total_completion_tokens=row.total_completion_tokens,
            total_tokens=row.total_tokens,
        )
        for row in rows
    ]


@router.post("/conversations", response_model=ConversationItem)
def create_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> ConversationItem:
    if user_id is None:
        raise HTTPException(status_code=401, detail="缺少用户身份")
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.create_conversation(db, payload.title, user_id)
    db.commit()
    db.refresh(row)
    return ConversationItem(id=row.id, title=row.title, created_at=row.created_at, updated_at=row.updated_at)


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: int,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> None:
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    ai_chat_service.delete_conversation(db, row)
    db.commit()


@router.patch("/conversations/{conversation_id}", response_model=ConversationItem)
def update_conversation(
    conversation_id: int,
    payload: ConversationCreate,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> ConversationItem:
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    if payload.title is not None:
        row.title = payload.title.strip() or "新对话"
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return ConversationItem(id=row.id, title=row.title, created_at=row.created_at, updated_at=row.updated_at)


@router.post("/conversations/{conversation_id}/regenerate-title", response_model=ConversationTitleRegenerateResponse)
def regenerate_conversation_title(
    conversation_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
) -> ConversationTitleRegenerateResponse:
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    messages = ai_chat_service.list_messages(db, conversation_id, user_id)
    generated_title = ai_chat_service.regenerate_conversation_title(settings, messages)
    regenerated = bool(generated_title)
    if generated_title:
        conversation.title = generated_title
        db.commit()
        db.refresh(conversation)
    return ConversationTitleRegenerateResponse(
        conversation=ConversationItem(
            id=conversation.id, title=conversation.title,
            created_at=conversation.created_at, updated_at=conversation.updated_at,
        ),
        regenerated=regenerated,
    )


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageItem])
def list_messages(
    conversation_id: int,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> list[MessageItem]:
    ai_chat_service.ensure_tables(db)
    rows = ai_chat_service.list_messages(db, conversation_id, user_id)
    return [serialize_message(row) for row in rows]


@router.delete("/conversations/{conversation_id}/messages/{message_id}", status_code=204)
def delete_message_endpoint(
    conversation_id: int,
    message_id: int,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> None:
    """硬删单条 AIMessage（与 delete_conversation 对齐：不引入软删字段）。"""
    ai_chat_service.ensure_tables(db)
    message = ai_chat_service.get_message_or_404(db, conversation_id, message_id, user_id)
    ai_chat_service.delete_message(db, message)
    db.commit()


@router.patch("/conversations/{conversation_id}/messages/{message_id}", response_model=MessageItem)
def update_message_endpoint(
    conversation_id: int,
    message_id: int,
    payload: AIChatMessageUpdate,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> MessageItem:
    """编辑单条消息的 content。

    当前仅支持 user 消息；编辑 assistant 消息会破坏 regenerate 链，
    统一返回 400。
    """
    ai_chat_service.ensure_tables(db)
    message = ai_chat_service.get_message_or_404(db, conversation_id, message_id, user_id)
    if message.role != "user":
        raise HTTPException(status_code=400, detail="只能编辑用户消息")

    new_content = payload.content.strip()
    if not new_content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    message.content = new_content
    conversation = message.conversation
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(message)
    return serialize_message(message)


@router.post("/conversations/{conversation_id}/messages", response_model=MessageCreateResponse)
def create_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
) -> MessageCreateResponse:
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)

    user_content = payload.content.strip()
    if not user_content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    history_rows = ai_chat_service.list_messages(db, conversation_id, user_id)
    web_search_context = None
    search_source_cards: list[dict[str, Any]] = []
    if payload.enable_web_search:
        web_search_payload = ai_chat_service.request_web_search(settings, user_content)
        web_search_context = ai_chat_service.format_web_search_context(web_search_payload, user_content)
        search_source_cards = ai_chat_service.build_search_source_cards(web_search_payload)

    llm_config = ai_chat_service.build_llm_config(
        settings=settings, model=payload.model,
        system_prompt=payload.system_prompt, reasoning_effort=payload.reasoning_effort,
    )
    if payload.attached_file_content:
        file_context = (
            f"\n\n【用户附加文件：{payload.attached_file_name or 'file'}】\n"
            f"{payload.attached_file_content.strip()}\n"
            f"请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
        )
        llm_config.system_prompt = llm_config.system_prompt + file_context

    assistant_content = ai_chat_service.generate_assistant_content(
        llm_config=llm_config, messages=history_rows,
        user_content=user_content, web_search_context=web_search_context,
    )
    if not history_rows:
        generated_title = ai_chat_service.generate_conversation_title(settings, user_content, assistant_content)
        if generated_title:
            conversation.title = generated_title

    user_row = ai_chat_service.append_message(db, conversation_id, "user", user_content)
    assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", assistant_content, search_sources=search_source_cards)
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user_row)
    db.refresh(assistant_row)

    return MessageCreateResponse(
        user_message=serialize_message(user_row),
        assistant_message=serialize_message(assistant_row),
    )


# ─── SSE 流式对话 ────────────────────────────────────────────────────────────


@router.post("/conversations/{conversation_id}/messages/stream")
def stream_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    user_id: int | None = Depends(_get_request_user_id),
):
    """SSE 流式对话端点。

    [BEL-80 follow-up] 取消支持：
    - 注册 `threading.Event` 到 `cancel_registry`；前端通过
      `POST /conversations/{id}/stream/cancel` 设事件，后端
      LLM 循环下一次迭代时检测到后立刻 `return`，
      `with httpx.Client(...)` 退出关闭连接，节省 token。
    - 进程级注册：多 worker 部署需要 sticky session 或 Redis
      广播，本 PR 暂不处理。
    - 数据库 session 仍走 FastAPI Depends（BEL-66 sync handler
      模式）：LLM 取消只关 httpx，不动 DB session 生命周期。
    """
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)

    history_rows = ai_chat_service.list_messages(db, conversation_id, user_id)
    regenerate = payload.regenerate
    user_content = payload.content.strip()

    if regenerate:
        if len(history_rows) < 2:
            raise HTTPException(status_code=400, detail="没有可重新生成的消息")
        if payload.target_message_id is not None:
            target_idx = next((i for i, r in enumerate(history_rows) if r.id == payload.target_message_id), None)
            if target_idx is None:
                raise HTTPException(status_code=404, detail="指定的消息不存在")
            if target_idx == 0 or history_rows[target_idx - 1].role != "user":
                raise HTTPException(status_code=400, detail="指定消息的前一条不是用户消息，无法重新生成")
            target_assistant = history_rows[target_idx]
            target_user = history_rows[target_idx - 1]
            context_messages = history_rows[: target_idx - 1]
            user_content = target_user.content.strip()
        else:
            last_assistant = history_rows[-1]
            last_user = history_rows[-2]
            if last_assistant.role != "assistant" or last_user.role != "user":
                raise HTTPException(status_code=400, detail="当前会话末尾消息不支持重新生成")
            context_messages = history_rows[:-2]
            user_content = last_user.content.strip()
            target_assistant = last_assistant
    else:
        if not user_content:
            raise HTTPException(status_code=400, detail="消息内容不能为空")
        context_messages = history_rows

    llm_config = ai_chat_service.build_llm_config(
        settings=settings, model=payload.model,
        system_prompt=payload.system_prompt, reasoning_effort=payload.reasoning_effort,
    )
    if payload.attached_file_content:
        file_context = (
            f"\n\n【用户附加文件：{payload.attached_file_name or 'file'}】\n"
            f"{payload.attached_file_content.strip()}\n"
            f"请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
        )
        llm_config.system_prompt += file_context

    max_turns = settings.ai_chat_max_conversation_turns
    if len(context_messages) >= max_turns * 2:
        raise HTTPException(status_code=400, detail=f"对话轮次已达上限 ({max_turns}次)，请新建会话继续对话")

    cancel_event = cancel_registry.register(conversation_id)

    def event_stream():
        assistant_parts: list[str] = []
        search_source_cards: list[dict[str, Any]] = []
        start_time = datetime.now(timezone.utc)
        tool_call_count = 0
        collected_usage: dict[str, Any] = {}
        user_row = None
        assistant_row = None
        title_regenerated = False
        cancelled = False

        try:
            yield encode_stream_event({"type": "start"})

            if regenerate:
                user_row = history_rows[-2]
                db.delete(target_assistant)
                db.flush()
                assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
            else:
                user_row = ai_chat_service.append_message(db, conversation_id, "user", user_content)
                assistant_row = ai_chat_service.append_message(db, conversation_id, "assistant", "")
            db.flush()

            if payload.enable_web_search:
                payload_messages, tools = ai_chat_service.build_payload_messages_with_tools(context_messages, user_content, llm_config.system_prompt)
                try:
                    for event in ai_chat_service.stream_with_tool_calling(llm_config=llm_config, messages=payload_messages, settings=settings, temperature=0.7, cancel_event=cancel_event):
                        if cancel_event.is_set():
                            cancelled = True
                            break
                        if event.get("type") == "chunk":
                            delta = event.get("delta", "")
                            if delta:
                                assistant_parts.append(delta)
                                if assistant_row:
                                    ai_chat_service.update_message_content(db, assistant_row.id, "".join(assistant_parts))
                                yield build_stream_chunk(delta)
                        elif event.get("type") == "tool_calls":
                            tool_call_count += 1
                            yield build_stream_tool_calls(event.get("tool_calls", []))
                        elif event.get("type") == "tool_searching":
                            yield build_stream_tool_searching()
                        elif event.get("type") == "tool_done":
                            yield build_stream_tool_done()
                        elif event.get("type") == "sources":
                            search_source_cards = event.get("sources") or []
                            yield build_stream_sources(search_source_cards)
                        elif event.get("type") == "usage":
                            collected_usage = event.get("usage", {})
                            yield build_stream_usage(collected_usage)
                        elif event.get("type") == "error":
                            raise Exception(event.get("message", "Tool calling failed"))

                    if cancelled:
                        raise _CancelledError()

                    assistant_content = "".join(assistant_parts).strip()
                    if not assistant_content:
                        raise ValueError("LLM returned empty content")

                except _CancelledError:
                    raise
                except Exception:
                    if cancel_event.is_set():
                        raise _CancelledError()
                    assistant_parts = []
                    search_source_cards = []
                    web_search_payload = ai_chat_service.request_web_search(settings, user_content)
                    web_search_context = ai_chat_service.format_web_search_context(web_search_payload, user_content)
                    search_source_cards = ai_chat_service.build_search_source_cards(web_search_payload, settings.ai_chat_web_search_max_results)

                    if search_source_cards:
                        yield build_stream_sources(search_source_cards)

                    for item in ai_chat_service.stream_assistant_content(llm_config=llm_config, messages=context_messages, user_content=user_content, web_search_context=web_search_context, settings=settings, cancel_event=cancel_event):
                        if cancel_event.is_set():
                            cancelled = True
                            break
                        if isinstance(item, dict) and item.get("type") == "thinking":
                            thinking_chunk = str(item.get("content", ""))
                            if thinking_chunk:
                                yield build_stream_thinking_chunk(thinking_chunk)
                        elif isinstance(item, str) and item:
                            assistant_parts.append(item)
                            if assistant_row:
                                ai_chat_service.update_message_content(db, assistant_row.id, "".join(assistant_parts))
                            yield build_stream_chunk(item)

                    if cancelled:
                        raise _CancelledError()

                    assistant_content = "".join(assistant_parts).strip()
                    if not assistant_content:
                        raise ValueError("LLM returned empty content")
            else:
                for item in ai_chat_service.stream_assistant_content(llm_config=llm_config, messages=context_messages, user_content=user_content, settings=settings, cancel_event=cancel_event):
                    if cancel_event.is_set():
                        cancelled = True
                        break
                    if isinstance(item, dict) and item.get("type") == "thinking":
                        thinking_chunk = str(item.get("content", ""))
                        if thinking_chunk:
                            yield build_stream_thinking_chunk(thinking_chunk)
                    elif isinstance(item, str) and item:
                        assistant_parts.append(item)
                        if assistant_row:
                            ai_chat_service.update_message_content(db, assistant_row.id, "".join(assistant_parts))
                        yield build_stream_chunk(item)

                if cancelled:
                    raise _CancelledError()

                assistant_content = "".join(assistant_parts).strip()
                if not assistant_content:
                    raise ValueError("LLM returned empty content")

            if not context_messages:
                generated_title = ai_chat_service.generate_conversation_title(settings, user_content, assistant_content)
                if generated_title:
                    conversation.title = generated_title
                    title_regenerated = True

            if assistant_row:
                ai_chat_service.update_message_content(db, assistant_row.id, assistant_content)
                if search_source_cards:
                    assistant_row.search_sources = json.dumps(search_source_cards, ensure_ascii=False)

            conversation.updated_at = datetime.now(timezone.utc)
            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)

            token_usage = None
            if collected_usage:
                token_usage = {
                    "prompt_tokens": collected_usage.get("prompt_tokens", 0),
                    "completion_tokens": collected_usage.get("completion_tokens", 0),
                    "total_tokens": collected_usage.get("total_tokens", 0),
                }

            if assistant_row:
                ai_chat_service.mark_message_complete(
                    db, assistant_row.id,
                    prompt_tokens=token_usage.get("prompt_tokens", 0) if token_usage else 0,
                    completion_tokens=token_usage.get("completion_tokens", 0) if token_usage else 0,
                    total_tokens=token_usage.get("total_tokens", 0) if token_usage else 0,
                    duration_ms=duration_ms,
                )

            db.commit()
            if assistant_row:
                db.refresh(assistant_row)

            ai_chat_service.recalculate_conversation_token_stats(db, conversation_id)
            db.commit()
            db.refresh(conversation)

            yield build_stream_done(
                user_message=serialize_message(user_row),
                assistant_message=serialize_message(assistant_row),
                conversation_title=conversation.title if title_regenerated else None,
                token_usage=token_usage,
                conversation_token_usage={
                    "prompt_tokens": conversation.total_prompt_tokens,
                    "completion_tokens": conversation.total_completion_tokens,
                    "total_tokens": conversation.total_tokens,
                },
                duration_ms=duration_ms,
                title_regenerated=title_regenerated,
            )
        except _CancelledError:
            # 用户主动停止：回滚未提交的 DB 写入（user/assistant 空的行），
            # 不写 done 也不写 error — 前端 useChatStream 已把"已停止"
            # 作为正常 UX 处理。
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


class _CancelledError(Exception):
    """内部 sentinel：用户主动停止时使用，区别于真正的错误。"""
    pass


@router.post("/conversations/{conversation_id}/stream/cancel", status_code=204)
def cancel_stream(
    conversation_id: int,
    db: Session = Depends(get_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> None:
    """请求取消正在进行的流式生成。

    - 校验 conv 归属，避免跨用户取消。
    - 通过 `cancel_registry` 设 event；
      `event_stream()` 在下一次 LLM 迭代时检测到并终止。
    - 进程级：只在同一个 worker 进程内有效（multi-worker
      部署需要 sticky session 或 Redis，本 PR 暂不处理）。
    """
    ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    cancel_registry.request_cancel(conversation_id)