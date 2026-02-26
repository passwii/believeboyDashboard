from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.ai_chat import AIConversation, AIMessage
from app.schemas.ai_chat import LLMConfigInput


def ensure_tables(db: Session) -> None:
    # Keep local sqlite startup simple even if migration not run yet.
    AIConversation.__table__.create(bind=db.get_bind(), checkfirst=True)
    AIMessage.__table__.create(bind=db.get_bind(), checkfirst=True)


def list_conversations(db: Session) -> list[AIConversation]:
    stmt = select(AIConversation).order_by(AIConversation.updated_at.desc())
    return list(db.execute(stmt).scalars().all())


def create_conversation(db: Session, title: str | None) -> AIConversation:
    normalized_title = (title or '').strip() or '新对话'
    row = AIConversation(title=normalized_title)
    db.add(row)
    db.flush()
    return row


def get_conversation_or_404(db: Session, conversation_id: int) -> AIConversation:
    row = db.get(AIConversation, conversation_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Conversation not found')
    return row


def list_messages(db: Session, conversation_id: int) -> list[AIMessage]:
    stmt = select(AIMessage).where(AIMessage.conversation_id == conversation_id).order_by(AIMessage.created_at.asc())
    return list(db.execute(stmt).scalars().all())


def append_message(db: Session, conversation_id: int, role: str, content: str) -> AIMessage:
    row = AIMessage(
        conversation_id=conversation_id,
        role=role,
        content=content,
    )
    db.add(row)
    return row


def generate_assistant_content(
    llm_config: LLMConfigInput,
    messages: list[AIMessage],
    user_content: str,
) -> str:
    base_url = llm_config.base_url.rstrip('/')
    endpoint = f'{base_url}/chat/completions'

    payload_messages: list[dict[str, str]] = []
    if llm_config.system_prompt.strip():
        payload_messages.append({'role': 'system', 'content': llm_config.system_prompt.strip()})

    for item in messages[-20:]:
        payload_messages.append({'role': item.role, 'content': item.content})

    payload_messages.append({'role': 'user', 'content': user_content})

    payload: dict[str, Any] = {
        'model': llm_config.model,
        'messages': payload_messages,
        'temperature': 0.7,
    }

    headers = {
        'Authorization': f'Bearer {llm_config.api_key}',
        'Content-Type': 'application/json',
    }

    try:
        with httpx.Client(timeout=llm_config.timeout_seconds) as client:
            response = client.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f'LLM request failed ({exc.response.status_code}): {detail[:300]}',
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f'LLM request failed: {exc}') from exc

    content = (
        data.get('choices', [{}])[0]
        .get('message', {})
        .get('content', '')
    )
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail='LLM returned empty content')
    return content.strip()
