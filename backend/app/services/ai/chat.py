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


def list_conversations(db: Session) -> list[AIConversation]:
    stmt = select(AIConversation).order_by(AIConversation.updated_at.desc())
    return list(db.execute(stmt).scalars().all())


def create_conversation(db: Session, title: str | None) -> AIConversation:
    normalized_title = (title or "").strip() or "新对话"
    row = AIConversation(title=normalized_title)
    db.add(row)
    db.flush()
    return row


def delete_conversation(db: Session, conversation: AIConversation) -> None:
    db.delete(conversation)


def get_conversation_or_404(db: Session, conversation_id: int) -> AIConversation:
    row = db.get(AIConversation, conversation_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    return row


def list_messages(db: Session, conversation_id: int) -> list[AIMessage]:
    stmt = (
        select(AIMessage)
        .where(AIMessage.conversation_id == conversation_id)
        .order_by(AIMessage.created_at.asc())
    )
    return list(db.execute(stmt).scalars().all())


def append_message(
    db: Session,
    conversation_id: int,
    role: str,
    content: str,
    search_sources: list[dict[str, Any]] | None = None,
) -> AIMessage:
    row = AIMessage(
        conversation_id=conversation_id,
        role=role,
        content=content,
        search_sources=json.dumps(search_sources, ensure_ascii=False)
        if search_sources
        else None,
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
