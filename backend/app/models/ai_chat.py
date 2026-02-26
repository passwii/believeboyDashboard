from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class AIConversation(Base):
    __tablename__ = 'ai_conversations'

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False, default='新对话')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    messages: Mapped[list['AIMessage']] = relationship(
        back_populates='conversation',
        cascade='all, delete-orphan',
        passive_deletes=True,
        order_by='AIMessage.created_at',
    )


class AIMessage(Base):
    __tablename__ = 'ai_messages'

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    conversation_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('ai_conversations.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    conversation: Mapped[AIConversation] = relationship(back_populates='messages')
