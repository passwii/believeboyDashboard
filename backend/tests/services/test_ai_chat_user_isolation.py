"""AI Chat user-isolation service tests (BEL-80 后续).

覆盖 `AIConversation.user_id` 隔离行为：
- 创建会话会 stamp user_id；
- `list_conversations` 只返回当前用户的会话；
- `get_conversation_or_404` 拒绝其他用户；
- `get_message_or_404` 透过 conv 拒绝其他用户；
- 历史 user_id IS NULL 的会话对任何用户都 404。
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


def _seed_conv(db: Session, *, user_id: int | None, title: str = "c") -> AIConversation:
    conv = AIConversation(
        user_id=user_id,
        title=title,
        created_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        updated_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    db.add(conv)
    db.flush()
    return conv


# ── list_conversations ────────────────────────────────────────────────────────


def test_list_conversations_filters_by_user_id(db: Session) -> None:
    _seed_conv(db, user_id=1, title="u1-a")
    _seed_conv(db, user_id=1, title="u1-b")
    _seed_conv(db, user_id=2, title="u2-a")

    rows = chat_service.list_conversations(db, 1)

    assert {r.title for r in rows} == {"u1-a", "u1-b"}


def test_list_conversations_none_user_id_returns_empty(db: Session) -> None:
    _seed_conv(db, user_id=1, title="u1-a")

    rows = chat_service.list_conversations(db, None)

    assert rows == []


def test_list_conversations_excludes_null_user_id(db: Session) -> None:
    """历史脏数据（user_id IS NULL）对任何用户都不可见。"""
    _seed_conv(db, user_id=None, title="legacy")
    _seed_conv(db, user_id=1, title="u1-a")

    rows = chat_service.list_conversations(db, 1)

    assert {r.title for r in rows} == {"u1-a"}


# ── create_conversation ───────────────────────────────────────────────────────


def test_create_conversation_stamps_user_id(db: Session) -> None:
    row = chat_service.create_conversation(db, "hello", 7)

    assert row.user_id == 7
    assert row.title == "hello"
    # 已 flush，ID 已分配
    assert row.id is not None


def test_create_conversation_default_title(db: Session) -> None:
    row = chat_service.create_conversation(db, None, 1)

    assert row.title == "新对话"
    assert row.user_id == 1


# ── get_conversation_or_404 ───────────────────────────────────────────────────


def test_get_conversation_or_404_returns_owned(db: Session) -> None:
    conv = _seed_conv(db, user_id=1)

    found = chat_service.get_conversation_or_404(db, conv.id, 1)

    assert found.id == conv.id


def test_get_conversation_or_404_rejects_other_user(db: Session) -> None:
    conv = _seed_conv(db, user_id=1)

    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_conversation_or_404(db, conv.id, 2)
    assert excinfo.value.status_code == 404


def test_get_conversation_or_404_rejects_unauthenticated(db: Session) -> None:
    """user_id=None 视为未登录调用方，404（不暴露存在性）。"""
    conv = _seed_conv(db, user_id=1)

    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_conversation_or_404(db, conv.id, None)
    assert excinfo.value.status_code == 404


def test_get_conversation_or_404_rejects_legacy_null(db: Session) -> None:
    """user_id IS NULL 的历史脏数据对任何用户都 404。"""
    conv = _seed_conv(db, user_id=None)

    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_conversation_or_404(db, conv.id, 1)
    assert excinfo.value.status_code == 404


def test_get_conversation_or_404_missing_id_raises_404(db: Session) -> None:
    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_conversation_or_404(db, 99999, 1)
    assert excinfo.value.status_code == 404


# ── get_message_or_404（通过 conv 间接校验 user 隔离）─────────────────────────


def test_get_message_or_404_rejects_other_user(db: Session) -> None:
    conv = _seed_conv(db, user_id=1)
    row = AIMessage(conversation_id=conv.id, role="user", content="hi")
    db.add(row)
    db.flush()

    with pytest.raises(HTTPException) as excinfo:
        chat_service.get_message_or_404(db, conv.id, row.id, 2)
    assert excinfo.value.status_code == 404


def test_get_message_or_404_returns_owned(db: Session) -> None:
    conv = _seed_conv(db, user_id=1)
    row = AIMessage(conversation_id=conv.id, role="user", content="hi")
    db.add(row)
    db.flush()

    found = chat_service.get_message_or_404(db, conv.id, row.id, 1)

    assert found.id == row.id
    assert found.content == "hi"


# ── list_messages（通过 conv 间接校验 user 隔离）─────────────────────────────


def test_list_messages_rejects_other_user(db: Session) -> None:
    conv = _seed_conv(db, user_id=1)
    db.add(AIMessage(conversation_id=conv.id, role="user", content="hi"))
    db.flush()

    with pytest.raises(HTTPException) as excinfo:
        chat_service.list_messages(db, conv.id, 2)
    assert excinfo.value.status_code == 404
