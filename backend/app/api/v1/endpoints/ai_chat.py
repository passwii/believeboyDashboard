from datetime import datetime, timezone
import json

from fastapi import APIRouter, Depends
from fastapi import HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import Settings, get_settings
from app.schemas.ai_chat import (
    AIChatConfigResponse,
    ConversationCreate,
    ConversationItem,
    ConversationTitleRegenerateResponse,
    MessageCreate,
    MessageCreateResponse,
    MessageItem,
)
from app.services import ai_chat_service

router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(protected)])


def serialize_message(row: ai_chat_service.AIMessage) -> dict[str, object]:
    return {
        "id": row.id,
        "conversation_id": row.conversation_id,
        "role": row.role,
        "content": row.content,
        "search_sources": ai_chat_service.parse_search_sources(row.search_sources),
        "created_at": row.created_at.isoformat(),
    }


def encode_stream_event(payload: dict[str, object]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


@router.get("/config", response_model=AIChatConfigResponse)
def get_ai_config(settings: Settings = Depends(get_settings)) -> AIChatConfigResponse:
    models, default_model = ai_chat_service.resolve_available_models(settings)
    return AIChatConfigResponse(
        provider_configured=ai_chat_service.is_provider_configured(settings),
        web_search_configured=ai_chat_service.is_web_search_configured(settings),
        models=models,
        default_model=default_model,
        timeout_seconds=settings.ai_chat_timeout_seconds,
        max_conversation_turns=settings.ai_chat_max_conversation_turns,
    )


@router.get("/conversations", response_model=list[ConversationItem])
def list_conversations(db: Session = Depends(get_db_session)) -> list[ConversationItem]:
    ai_chat_service.ensure_tables(db)
    rows = ai_chat_service.list_conversations(db)
    return [
        ConversationItem(
            id=row.id,
            title=row.title,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.post("/conversations", response_model=ConversationItem)
def create_conversation(
    payload: ConversationCreate, db: Session = Depends(get_db_session)
) -> ConversationItem:
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.create_conversation(db, payload.title)
    db.commit()
    db.refresh(row)
    return ConversationItem(
        id=row.id,
        title=row.title,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: int, db: Session = Depends(get_db_session)
) -> None:
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.get_conversation_or_404(db, conversation_id)
    ai_chat_service.delete_conversation(db, row)
    db.commit()


@router.post(
    "/conversations/{conversation_id}/regenerate-title",
    response_model=ConversationTitleRegenerateResponse,
)
def regenerate_conversation_title(
    conversation_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> ConversationTitleRegenerateResponse:
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id)
    messages = ai_chat_service.list_messages(db, conversation_id)
    generated_title = ai_chat_service.regenerate_conversation_title(settings, messages)
    regenerated = bool(generated_title)
    if generated_title:
        conversation.title = generated_title
        conversation.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(conversation)

    return ConversationTitleRegenerateResponse(
        conversation=ConversationItem(
            id=conversation.id,
            title=conversation.title,
            created_at=conversation.created_at,
            updated_at=conversation.updated_at,
        ),
        regenerated=regenerated,
    )


@router.get(
    "/conversations/{conversation_id}/messages", response_model=list[MessageItem]
)
def list_messages(
    conversation_id: int, db: Session = Depends(get_db_session)
) -> list[MessageItem]:
    ai_chat_service.ensure_tables(db)
    ai_chat_service.get_conversation_or_404(db, conversation_id)
    rows = ai_chat_service.list_messages(db, conversation_id)
    return [
        MessageItem(
            id=row.id,
            conversation_id=row.conversation_id,
            role=row.role,
            content=row.content,
            search_sources=ai_chat_service.parse_search_sources(row.search_sources),
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post(
    "/conversations/{conversation_id}/messages", response_model=MessageCreateResponse
)
def create_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
) -> MessageCreateResponse:
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id)

    user_content = payload.content.strip()
    if not user_content:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="消息内容不能为空"
        )
    history_rows = ai_chat_service.list_messages(db, conversation_id)
    web_search_context = None
    search_source_cards: list[dict[str, object]] = []
    if payload.enable_web_search:
        web_search_payload = ai_chat_service.request_web_search(settings, user_content)
        web_search_context = ai_chat_service.format_web_search_context(
            web_search_payload, user_content
        )
        search_source_cards = ai_chat_service.build_search_source_cards(
            web_search_payload
        )
    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=payload.model,
        system_prompt=payload.system_prompt,
    )

    # Append attached file content to system prompt
    if payload.attached_file_content:
        file_context = (
            f"\n\n【用户附加文件：{payload.attached_file_name or 'file'}】\n"
            f"{payload.attached_file_content.strip()}\n"
            f"请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
        )
        llm_config.system_prompt = llm_config.system_prompt + file_context

    assistant_content = ai_chat_service.generate_assistant_content(
        llm_config=llm_config,
        messages=history_rows,
        user_content=user_content,
        web_search_context=web_search_context,
    )
    if not history_rows:
        generated_title = ai_chat_service.generate_conversation_title(
            settings, user_content, assistant_content
        )
        if generated_title:
            conversation.title = generated_title

    user_row = ai_chat_service.append_message(db, conversation_id, "user", user_content)
    assistant_row = ai_chat_service.append_message(
        db,
        conversation_id,
        "assistant",
        assistant_content,
        search_sources=search_source_cards,
    )
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user_row)
    db.refresh(assistant_row)

    return MessageCreateResponse(
        user_message=MessageItem(
            id=user_row.id,
            conversation_id=user_row.conversation_id,
            role=user_row.role,
            content=user_row.content,
            created_at=user_row.created_at,
        ),
        assistant_message=MessageItem(
            id=assistant_row.id,
            conversation_id=assistant_row.conversation_id,
            role=assistant_row.role,
            content=assistant_row.content,
            search_sources=ai_chat_service.parse_search_sources(
                assistant_row.search_sources
            ),
            created_at=assistant_row.created_at,
        ),
    )


@router.post("/conversations/{conversation_id}/messages/stream")
def stream_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
):
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id)

    history_rows = ai_chat_service.list_messages(db, conversation_id)
    regenerate = payload.regenerate
    user_content = payload.content.strip()

    if regenerate:
        if len(history_rows) < 2:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="没有可重新生成的消息"
            )

        last_assistant = history_rows[-1]
        last_user = history_rows[-2]
        if last_assistant.role != "assistant" or last_user.role != "user":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="当前会话末尾消息不支持重新生成",
            )

        context_messages = history_rows[:-2]
        user_content = last_user.content.strip()
    else:
        if not user_content:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="消息内容不能为空"
            )
        context_messages = history_rows

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=payload.model,
        system_prompt=payload.system_prompt,
    )

    # Append attached file content to system prompt
    if payload.attached_file_content:
        file_context = (
            f"\n\n【用户附加文件：{payload.attached_file_name or 'file'}】\n"
            f"{payload.attached_file_content.strip()}\n"
            f"请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
        )
        llm_config.system_prompt = llm_config.system_prompt + file_context

    max_turns = settings.ai_chat_max_conversation_turns
    if len(context_messages) >= max_turns * 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"对话轮次已达上限 ({max_turns}次)，请新建会话继续对话",
        )

    def event_stream():
        assistant_parts: list[str] = []
        search_source_cards: list[dict[str, object]] = []
        start_time = datetime.now(timezone.utc)
        tool_call_count = 0
        collected_usage: dict[str, Any] = {}

        try:
            yield encode_stream_event({"type": "start"})

            if payload.enable_web_search:
                payload_messages, tools = (
                    ai_chat_service.build_payload_messages_with_tools(
                        context_messages, user_content, llm_config.system_prompt
                    )
                )

                try:
                    for event in ai_chat_service.stream_with_tool_calling(
                        llm_config=llm_config,
                        messages=payload_messages,
                        settings=settings,
                        temperature=0.7,
                    ):
                        if event.get("type") == "chunk":
                            delta = event.get("delta", "")
                            if delta:
                                assistant_parts.append(delta)
                                yield encode_stream_event(
                                    {"type": "chunk", "delta": delta}
                                )
                        elif event.get("type") == "tool_calls":
                            tool_call_count += 1
                            yield encode_stream_event(
                                {
                                    "type": "tool_calls",
                                    "tool_calls": event.get("tool_calls", []),
                                }
                            )
                        elif event.get("type") == "tool_searching":
                            yield encode_stream_event(event)
                        elif event.get("type") == "tool_done":
                            yield encode_stream_event(event)
                        elif event.get("type") == "sources":
                            search_source_cards = event.get("sources") or []
                            yield encode_stream_event(
                                {"type": "sources", "sources": search_source_cards}
                            )
                        elif event.get("type") == "usage":
                            collected_usage = event.get("usage", {})
                            yield encode_stream_event(event)
                        elif event.get("type") == "error":
                            raise Exception(event.get("message", "Tool calling failed"))

                    assistant_content = "".join(assistant_parts).strip()
                    if not assistant_content:
                        raise ValueError("LLM returned empty content")

                except Exception as tool_error:
                    assistant_parts = []
                    search_source_cards = []
                    web_search_payload = ai_chat_service.request_web_search(
                        settings, user_content
                    )
                    web_search_context = ai_chat_service.format_web_search_context(
                        web_search_payload, user_content
                    )
                    search_source_cards = ai_chat_service.build_search_source_cards(
                        web_search_payload
                    )

                    if search_source_cards:
                        yield encode_stream_event(
                            {"type": "sources", "sources": search_source_cards}
                        )

                    for chunk in ai_chat_service.stream_assistant_content(
                        llm_config=llm_config,
                        messages=context_messages,
                        user_content=user_content,
                        web_search_context=web_search_context,
                    ):
                        assistant_parts.append(chunk)
                        yield encode_stream_event({"type": "chunk", "delta": chunk})

                    assistant_content = "".join(assistant_parts).strip()
                    if not assistant_content:
                        raise ValueError("LLM returned empty content")
            else:
                for chunk in ai_chat_service.stream_assistant_content(
                    llm_config=llm_config,
                    messages=context_messages,
                    user_content=user_content,
                ):
                    assistant_parts.append(chunk)
                    yield encode_stream_event({"type": "chunk", "delta": chunk})

                assistant_content = "".join(assistant_parts).strip()
                if not assistant_content:
                    raise ValueError("LLM returned empty content")

            generated_title = None
            if not context_messages:
                generated_title = ai_chat_service.generate_conversation_title(
                    settings, user_content, assistant_content
                )
                if generated_title:
                    conversation.title = generated_title

            if regenerate:
                user_row = history_rows[-2]
                db.delete(history_rows[-1])
                db.flush()
                assistant_row = ai_chat_service.append_message(
                    db,
                    conversation_id,
                    "assistant",
                    assistant_content,
                    search_sources=search_source_cards,
                )
            else:
                user_row = ai_chat_service.append_message(
                    db, conversation_id, "user", user_content
                )
                assistant_row = ai_chat_service.append_message(
                    db,
                    conversation_id,
                    "assistant",
                    assistant_content,
                    search_sources=search_source_cards,
                )
            conversation.updated_at = datetime.now(timezone.utc)
            db.commit()
            if not regenerate:
                db.refresh(user_row)
            db.refresh(assistant_row)

            end_time = datetime.now(timezone.utc)
            duration_ms = int((end_time - start_time).total_seconds() * 1000)

            token_usage = None
            if collected_usage:
                token_usage = {
                    "prompt_tokens": collected_usage.get("prompt_tokens", 0),
                    "completion_tokens": collected_usage.get("completion_tokens", 0),
                    "total_tokens": collected_usage.get("total_tokens", 0),
                }

            yield encode_stream_event(
                {
                    "type": "done",
                    "user_message": serialize_message(user_row),
                    "assistant_message": serialize_message(assistant_row),
                    "conversation_title": conversation.title,
                    "token_usage": token_usage,
                    "duration_ms": duration_ms,
                }
            )
        except Exception as exc:
            db.rollback()
            yield encode_stream_event(
                {"type": "error", "message": str(exc) or "发送失败"}
            )

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
