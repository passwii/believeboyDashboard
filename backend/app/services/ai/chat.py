from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select, sql
from sqlalchemy.orm import Session

from app.models.ai_chat import AIMessage, AIConversation


def normalize_optional_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def trim_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value


def ensure_tables(db: Session) -> None:
    pass


def list_conversations(db: Session, user_id: int | None) -> list[AIConversation]:
    """返回当前用户的会话（按 updated_at 倒序）。

    user_id 为 None 视为"未登录调用方"，返回空列表；
    历史 user_id IS NULL 的会话对任何调用方都不可见。
    """
    if user_id is None:
        return []
    stmt = (
        select(AIConversation)
        .where(AIConversation.user_id == user_id)
        .order_by(AIConversation.updated_at.desc())
    )
    return list(db.execute(stmt).scalars().all())


def create_conversation(
    db: Session, title: str | None, user_id: int
) -> AIConversation:
    """创建归属于 user_id 的会话。user_id 由 endpoint 从 X-User-Id 注入。"""
    normalized_title = (title or "").strip() or "新对话"
    row = AIConversation(user_id=user_id, title=normalized_title)
    db.add(row)
    db.flush()
    return row


def delete_conversation(db: Session, conversation: AIConversation) -> None:
    db.delete(conversation)


def get_conversation_or_404(
    db: Session, conversation_id: int, user_id: int | None
) -> AIConversation:
    """取会话并校验归属。

    - 找不到：404
    - 找到但 user_id 与请求不匹配：404（不暴露存在性）
    - 找到且 user_id IS NULL：404（历史脏数据不暴露给任何用户）
    """
    row = db.get(AIConversation, conversation_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    if user_id is None or row.user_id != user_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    return row


def list_messages(
    db: Session, conversation_id: int, user_id: int | None
) -> list[AIMessage]:
    """返回 conversation 下的所有消息，按 created_at 升序。

    归属校验：先复用 `get_conversation_or_404` 做 user 隔离；
    之后返回的消息天然属于该 conv，等价于已隔离。
    """
    get_conversation_or_404(db, conversation_id, user_id)
    stmt = (
        select(AIMessage)
        .where(AIMessage.conversation_id == conversation_id)
        .order_by(AIMessage.created_at.asc())
    )
    return list(db.execute(stmt).scalars().all())


def get_message_or_404(
    db: Session, conversation_id: int, message_id: int, user_id: int | None
) -> AIMessage:
    """根据 conversation_id + message_id 取单条消息，并校验 conv 归属。

    - 找不到 message：404
    - message 存在但不属于指定 conversation：404（避免泄漏其他 conv 的 message 存在性）
    - conversation 不属于 user_id：404
    """
    get_conversation_or_404(db, conversation_id, user_id)
    row = db.get(AIMessage, message_id)
    if row is None or row.conversation_id != conversation_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Message not found"
        )
    return row


def delete_message(db: Session, message: AIMessage) -> None:
    """硬删单条消息（与 delete_conversation 对齐：不引入软删字段）。"""
    db.delete(message)


def append_message(
    db: Session,
    conversation_id: int,
    role: str,
    content: str,
    search_sources: list[dict[str, Any]] | None = None,
    search_time_range: str | None = None,
) -> AIMessage:
    """追加一条消息。

    [BEL-81.B] `search_time_range` 透传至 `AIMessage.search_time_range`，
    供历史回放时按时间范围渲染 chip。允许 `None`（老消息 / 无搜索场景）。
    """
    row = AIMessage(
        conversation_id=conversation_id,
        role=role,
        content=content,
        search_sources=json.dumps(search_sources, ensure_ascii=False)
        if search_sources
        else None,
        search_time_range=search_time_range,
    )
    db.add(row)
    return row


def update_message_content(
    db: Session, message_id: int, content: str
) -> AIMessage | None:
    row = db.get(AIMessage, message_id)
    if row:
        row.content = content
    return row


def mark_message_complete(
    db: Session,
    message_id: int,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    duration_ms: int | None = None,
) -> AIMessage | None:
    row = db.get(AIMessage, message_id)
    if row:
        row.is_complete = True
        row.prompt_tokens = prompt_tokens
        row.completion_tokens = completion_tokens
        row.total_tokens = total_tokens
        row.duration_ms = duration_ms
    return row


def recalculate_conversation_token_stats(db: Session, conversation_id: int) -> None:
    stmt = select(
        sql.func.coalesce(sql.func.sum(AIMessage.prompt_tokens), 0).label("prompt"),
        sql.func.coalesce(sql.func.sum(AIMessage.completion_tokens), 0).label(
            "completion"
        ),
        sql.func.coalesce(sql.func.sum(AIMessage.total_tokens), 0).label("total"),
    ).where(AIMessage.conversation_id == conversation_id)
    result = db.execute(stmt).fetchone()
    if result:
        conversation = db.get(AIConversation, conversation_id)
        if conversation:
            conversation.total_prompt_tokens = result.prompt
            conversation.total_completion_tokens = result.completion
            conversation.total_tokens = result.total
            db.flush()


def normalize_generated_title(value: str) -> str:
    text = value.strip()
    if not text:
        return ""

    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    normalized = first_line.strip(" \"'`\u201c\u201d\u2018\u2019")
    for prefix in ("\u6807\u9898\uff1a", "\u6807\u9898:", "\u4f1a\u8bdd\u6807\u9898\uff1a", "\u4f1a\u8bdd\u6807\u9898:"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):].strip(" \"'`\u201c\u201d\u2018\u2019")
            break

    return normalized[:40].strip()


def parse_search_sources(value: str | None) -> list[dict[str, Any]]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []
