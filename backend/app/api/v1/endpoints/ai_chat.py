"""
AI Chat Endpoints — 瘦化的 endpoint 层。
SSE 流式事件编码逻辑已迁移至 app.services.ai.stream_utils。
"""

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, protected
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
from app.services.ai.stream_utils import serialize_message

logger = logging.getLogger(__name__)

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
            ai_chat_service.normalize_reasoning_effort(
                settings.ai_chat_default_reasoning_effort
            )
            or "medium"
        ),
        timeout_seconds=settings.ai_chat_timeout_seconds,
        max_conversation_turns=settings.ai_chat_max_conversation_turns,
        web_search_max_results=settings.ai_chat_web_search_max_results,
    )


@router.get("/conversations", response_model=list[ConversationItem])
def list_conversations(
    db: Session = Depends(get_read_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> list[ConversationItem]:
    ai_chat_service.ensure_tables(db)
    rows = ai_chat_service.list_conversations(db, user_id)
    return [
        ConversationItem(
            id=row.id,
            title=row.title,
            created_at=row.created_at,
            updated_at=row.updated_at,
            total_prompt_tokens=row.total_prompt_tokens,
            total_completion_tokens=row.total_completion_tokens,
            total_tokens=row.total_tokens,
        )
        for row in rows
    ]


@router.post("/conversations", response_model=ConversationItem)
def create_conversation(
    payload: ConversationCreate,
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> ConversationItem:
    if user_id is None:
        raise HTTPException(status_code=401, detail="缺少用户身份")
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.create_conversation(db, payload.title, user_id)
    db.commit()
    db.refresh(row)
    return ConversationItem(
        id=row.id, title=row.title, created_at=row.created_at, updated_at=row.updated_at
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: int,
    db: Session = Depends(get_primary_db_session),
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
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> ConversationItem:
    ai_chat_service.ensure_tables(db)
    row = ai_chat_service.get_conversation_or_404(db, conversation_id, user_id)
    if payload.title is not None:
        row.title = payload.title.strip() or "新对话"
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return ConversationItem(
        id=row.id, title=row.title, created_at=row.created_at, updated_at=row.updated_at
    )


@router.post(
    "/conversations/{conversation_id}/regenerate-title",
    response_model=ConversationTitleRegenerateResponse,
)
def regenerate_conversation_title(
    conversation_id: int,
    db: Session = Depends(get_primary_db_session),
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
    conversation_id: int,
    db: Session = Depends(get_read_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> list[MessageItem]:
    ai_chat_service.ensure_tables(db)
    rows = ai_chat_service.list_messages(db, conversation_id, user_id)
    return [serialize_message(row) for row in rows]


@router.delete(
    "/conversations/{conversation_id}/messages/{message_id}", status_code=204
)
def delete_message_endpoint(
    conversation_id: int,
    message_id: int,
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> None:
    """硬删单条 AIMessage（与 delete_conversation 对齐：不引入软删字段）。"""
    ai_chat_service.ensure_tables(db)
    message = ai_chat_service.get_message_or_404(
        db, conversation_id, message_id, user_id
    )
    ai_chat_service.delete_message(db, message)
    db.commit()


@router.patch(
    "/conversations/{conversation_id}/messages/{message_id}", response_model=MessageItem
)
def update_message_endpoint(
    conversation_id: int,
    message_id: int,
    payload: AIChatMessageUpdate,
    db: Session = Depends(get_primary_db_session),
    user_id: int | None = Depends(_get_request_user_id),
) -> MessageItem:
    """编辑单条消息的 content。

    当前仅支持 user 消息；编辑 assistant 消息会破坏 regenerate 链，
    统一返回 400。
    """
    ai_chat_service.ensure_tables(db)
    message = ai_chat_service.get_message_or_404(
        db, conversation_id, message_id, user_id
    )
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


@router.post(
    "/conversations/{conversation_id}/messages", response_model=MessageCreateResponse
)
def create_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_primary_db_session),
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
    search_time_range: str | None = None
    if payload.enable_web_search:
        web_search_payload = ai_chat_service.request_web_search(settings, user_content)
        web_search_context = ai_chat_service.format_web_search_context(
            web_search_payload, user_content
        )
        search_source_cards = ai_chat_service.build_search_source_cards(
            web_search_payload
        )
        search_time_range = web_search_payload.get(
            "time_range"
        ) or ai_chat_service.detect_time_range_from_query(user_content)

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=payload.model,
        system_prompt=payload.system_prompt,
        reasoning_effort=payload.reasoning_effort,
    )
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
        search_time_range=search_time_range,
        # [BEL-379] 落库 model 供按模型聚合；payload.model 为空时回退 'unknown'。
        model=(payload.model or "unknown"),
    )
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user_row)
    db.refresh(assistant_row)

    return MessageCreateResponse(
        user_message=serialize_message(user_row),
        assistant_message=serialize_message(assistant_row),
    )


def _prepare_conversation_turn(
    *,
    db: Session,
    conversation_id: int,
    history: list,
    payload: MessageCreate,
    user_content: str,
    regenerate: bool,
):
    """[Phase 1 任务 6] 公共入参段：regenerate 校验 + user/assistant 行写入 + prompt_messages 拼装。

    返回 (prompt_messages, context_messages, user_row, assistant_row, target_assistant)：
    - prompt_messages：list[dict]，ready for LLM（末尾追加 user 消息；附 attached_file 时再加 system）
    - context_messages：list[AIMessage]（legacy 路径 stream_assistant_content 需要原始 row）
    - user_row：新增 user 行（regenerate=False）/ 历史 user 行（regenerate=True）
    - assistant_row：新增的空 assistant 行（regenerate 时已删原行）
    - target_assistant：regenerate=True 时为被删的原 assistant 行；否则 None
    """
    from app.models.ai_chat import AIMessage

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
                    status_code=400, detail="指定消息的前一条不是用户消息，无法重新生成"
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
        assistant_row = ai_chat_service.append_message(
            db,
            conversation_id,
            "assistant",
            "",
            # [BEL-379] regenerate 路径：用当前 payload.model
            model=(payload.model or "unknown"),
        )
    else:
        if not user_content:
            raise HTTPException(status_code=400, detail="消息内容不能为空")
        context_messages = history
        user_row = ai_chat_service.append_message(
            db, conversation_id, "user", user_content
        )
        assistant_row = ai_chat_service.append_message(
            db,
            conversation_id,
            "assistant",
            "",
            # [BEL-379] 落库 model 供按模型聚合
            model=(payload.model or "unknown"),
        )
        target_assistant = None
    db.flush()

    # attached_file_content 注入为末尾的 system 消息
    # （不是 system_prompt，因为 Pydantic AI 路径用 Agent factory 的 instructions，
    # 新加 system_prompt 字段会与 mapper 冲突；append 方式兼容新旧两条路径）
    prompt_messages: list[dict] = []
    for m in context_messages[-20:]:
        prompt_messages.append({"role": m.role, "content": m.content})
    prompt_messages.append({"role": "user", "content": user_content})
    if payload.attached_file_content:
        prompt_messages.append(
            {
                "role": "system",
                "content": (
                    f"【用户附加文件：{payload.attached_file_name or 'file'}】\n"
                    f"{payload.attached_file_content.strip()}\n"
                    "请根据上述附加文件内容回答用户问题。如果用户没有明确提问，请先总结文件的主要内容。"
                ),
            }
        )

    return prompt_messages, context_messages, user_row, assistant_row, target_assistant


def _prompt_messages_to_pydantic_ai_args(prompt_messages: list[dict]) -> tuple:
    """把 `[{role, content}, ...]` 转成 Pydantic AI 2.9 的 `run_stream_events` 参数。

    关键约束（Pydantic AI 2.9）：
    - `run_stream_events(user_prompt, *, message_history=...)` 不接受 `Sequence[ModelMessage]` 作为 user_prompt
    - 必须把"最后一条 user 消息"作为 user_prompt，其余历史消息（assistant + 之前 user + system）作为 message_history
    - Pydantic AI 内部会把 ModelRequest 包装在 ModelRequest 里（"Expected code to be unreachable" bug 触发），
      所以不能直接传 `[ModelRequest(...)]`

    返回 (user_prompt: str | list[UserContent], message_history: list[ModelMessage])
    """
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        SystemPromptPart,
        TextPart,
        UserPromptPart,
    )

    # 找到最后一条 user 消息作为 user_prompt
    last_user_idx = None
    for i in range(len(prompt_messages) - 1, -1, -1):
        if prompt_messages[i].get("role") == "user":
            last_user_idx = i
            break
    if last_user_idx is None:
        # 没有 user 消息？防御性 fallback：把整个 list 当 message_history，user_prompt 留空
        last_user_idx = len(prompt_messages)

    user_prompt_content = (
        prompt_messages[last_user_idx].get("content", "")
        if last_user_idx < len(prompt_messages)
        else ""
    )

    # post-user 注入：把最后一条 user 之后追加的 system 消息（如 attached_file 提示）
    # 折叠到 user_prompt 前缀，避免被 `prompt_messages[:last_user_idx]` 切片丢掉。
    # 详见 Phase 1 PR review fix：Kilo 指出 `_prompt_messages_to_pydantic_ai_args` 漏传 attached_file。
    post_user_prefixes: list[str] = []
    for m in prompt_messages[last_user_idx + 1 :]:
        if m.get("role") == "system":
            content = m.get("content")
            if content:
                post_user_prefixes.append(content)
    if post_user_prefixes:
        prefix = "\n\n".join(post_user_prefixes)
        user_prompt_content = (
            f"{prefix}\n\n{user_prompt_content}" if user_prompt_content else prefix
        )

    user_prompt: str = (
        user_prompt_content
        if isinstance(user_prompt_content, str)
        else str(user_prompt_content)
    )

    message_history: list = []
    for m in prompt_messages[:last_user_idx]:
        role = m.get("role")
        content = m.get("content", "")
        if role == "user":
            message_history.append(
                ModelRequest(parts=[UserPromptPart(content=content)])
            )
        elif role == "assistant":
            message_history.append(ModelResponse(parts=[TextPart(content=content)]))
        elif role == "system":
            message_history.append(
                ModelRequest(parts=[SystemPromptPart(content=content)])
            )
        # else: 未知 role 跳过

    return user_prompt, message_history
