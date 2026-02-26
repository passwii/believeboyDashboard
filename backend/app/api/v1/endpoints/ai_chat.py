from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.schemas.ai_chat import ConversationCreate, ConversationItem, MessageCreate, MessageCreateResponse, MessageItem
from app.services import ai_chat_service

router = APIRouter(prefix='/ai', tags=['ai'], dependencies=[Depends(protected)])


@router.get('/conversations', response_model=list[ConversationItem])
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


@router.post('/conversations', response_model=ConversationItem)
def create_conversation(payload: ConversationCreate, db: Session = Depends(get_db_session)) -> ConversationItem:
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


@router.get('/conversations/{conversation_id}/messages', response_model=list[MessageItem])
def list_messages(conversation_id: int, db: Session = Depends(get_db_session)) -> list[MessageItem]:
    ai_chat_service.ensure_tables(db)
    ai_chat_service.get_conversation_or_404(db, conversation_id)
    rows = ai_chat_service.list_messages(db, conversation_id)
    return [
        MessageItem(
            id=row.id,
            conversation_id=row.conversation_id,
            role=row.role,
            content=row.content,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post('/conversations/{conversation_id}/messages', response_model=MessageCreateResponse)
def create_message(
    conversation_id: int,
    payload: MessageCreate,
    db: Session = Depends(get_db_session),
) -> MessageCreateResponse:
    ai_chat_service.ensure_tables(db)
    conversation = ai_chat_service.get_conversation_or_404(db, conversation_id)

    user_content = payload.content.strip()
    history_rows = ai_chat_service.list_messages(db, conversation_id)
    assistant_content = ai_chat_service.generate_assistant_content(
        llm_config=payload.llm_config,
        messages=history_rows,
        user_content=user_content,
    )

    user_row = ai_chat_service.append_message(db, conversation_id, 'user', user_content)
    assistant_row = ai_chat_service.append_message(db, conversation_id, 'assistant', assistant_content)
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
            created_at=assistant_row.created_at,
        ),
    )
