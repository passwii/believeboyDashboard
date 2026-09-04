"""AI Chat message-level service tests (BEL-62 缺口 1).

覆盖新增的 `get_message_or_404` / `delete_message` 行为，
以及对既有 `update_message_content` 的 contract 验证。
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import Base
from app.models.ai_chat import AIConversation, AIMessage
from app.services.ai import chat as chat_service


@pytest.fixture()
def db() -> Session:
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _seed_conversation(db: Session, title: str = "test-conv", user_id: int = 1) -> AIConversation:
    conv = AIConversation(
        user_id=user_id,
        title=title,
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    db.add(conv)
    db.flush()
    return conv


def _seed_message(
    db: Session,
    conv: AIConversation,
    role: str = "user",
    content: str = "hi",
) -> AIMessage:
    row = AIMessage(
        conversation_id=conv.id,
        role=role,
        content=content,
        is_complete=(role == "user"),
    )
    db.add(row)
    db.flush()
    return row


# ── get_message_or_404 ────────────────────────────────────────────────────────


def test_get_message_or_404_returns_message(db: Session) -> None:
    conv = _seed_conversation(db)
    msg = _seed_message(db, conv, role="user", content="hello")

    found = chat_service.get_message_or_404(db, conv.id, msg.id, 1)

    assert found.id == msg.id
    assert found.content == "hello"


def test_get_message_or_404_missing_message_raises_404(db: Session) -> None:
    conv = _seed_conversation(db)

    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_message_or_404(db, conv.id, 99999, 1)
    assert excinfo.value.status_code == 404


def test_get_message_or_404_wrong_conversation_raises_404(db: Session) -> None:
    conv_a = _seed_conversation(db, title="A")
    conv_b = _seed_conversation(db, title="B")
    msg_b = _seed_message(db, conv_b, role="user", content="in B")

    # 存在但属于 B，请求时却传 A → 404（不泄漏其他 conv 的 message 存在性）
    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_message_or_404(db, conv_a.id, msg_b.id, 1)
    assert excinfo.value.status_code == 404


# ── delete_message ────────────────────────────────────────────────────────────


def test_delete_message_removes_row(db: Session) -> None:
    conv = _seed_conversation(db)
    msg = _seed_message(db, conv, role="user", content="bye")
    msg_id = msg.id

    chat_service.delete_message(db, msg)
    db.commit()

    remaining = db.get(AIMessage, msg_id)
    assert remaining is None


def test_delete_message_keeps_siblings(db: Session) -> None:
    """删除单条消息不应影响同 conversation 的其他消息。"""
    conv = _seed_conversation(db)
    m1 = _seed_message(db, conv, role="user", content="1")
    _seed_message(db, conv, role="assistant", content="2")
    _seed_message(db, conv, role="user", content="3")

    chat_service.delete_message(db, m1)
    db.commit()

    remaining = chat_service.list_messages(db, conv.id, 1)
    assert [r.content for r in remaining] == ["2", "3"]


# ── update_message_content (既有 contract 验证) ──────────────────────────────


def test_update_message_content_updates_field(db: Session) -> None:
    conv = _seed_conversation(db)
    msg = _seed_message(db, conv, role="user", content="original")

    updated = chat_service.update_message_content(db, msg.id, "edited")
    db.commit()

    assert updated is not None
    assert updated.content == "edited"
    refreshed = db.get(AIMessage, msg.id)
    assert refreshed is not None
    assert refreshed.content == "edited"


def test_update_message_content_missing_returns_none(db: Session) -> None:
    result = chat_service.update_message_content(db, 99999, "anything")
    assert result is None
